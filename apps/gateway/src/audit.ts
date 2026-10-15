/**
 * The audit sink the MCP guard writes through (contract §9: every `tools/call` is audited
 * before the response, and a failed audit fails the request).
 *
 * The gateway is the only side that knows `MONACA_SERVER_URL` and `MONACA_INTERNAL_SECRET`, so
 * it owns the sink and provides it to the demo module over the kernel registry. The sink turns
 * the guard's {@link ToolAuditRecord} into the §8.1 event shape and POSTs it to
 * `POST /internal/audit` (§6.3); anything but a 201 throws, which the guard turns into a 503 —
 * an unaudited call is never allowed through.
 */
import type { ToolAuditRecord, ToolAuditSink } from "@monaca/mcp";
import { newTypedId } from "./typed-id.ts";
import type { GatewayConfig } from "./config.ts";

/** §8.1 event, minus the three chain fields the server adds (`seq`, `prev_hash`, `hash`). */
export interface AuditEvent {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly actor_chain: { type: string; id: string }[];
  readonly subject: { type: string; id: string };
  readonly decision: "allow" | "deny";
  readonly grant_id?: string;
  readonly jti: string;
  readonly payload: Record<string, unknown>;
}

export interface AuditSinkOptions {
  readonly config: Pick<GatewayConfig, "serverUrl" | "internalSecret" | "mcpDemoTenant" | "mcpDemoOrg">;
  /** Per-request timeout; the guard awaits this inline, so it must be short. */
  readonly timeoutMs?: number;
  readonly onError?: (error: unknown, record: ToolAuditRecord) => void;
}

/**
 * Builds the §8.1 event for a tool call. `actor_chain` is outermost-first: the account, then
 * the acting agent when the token is delegated (§7.2). Exported for tests.
 */
export function buildToolAuditEvent(
  record: ToolAuditRecord,
  now: number = Date.now(),
): AuditEvent {
  const { token } = record;
  const actorChain: { type: string; id: string }[] = [{ type: "account", id: token.sub }];
  // The delegated token's `act.sub` is the agent; deeper nesting is M3 (§7.2).
  if (token.act !== undefined) actorChain.push({ type: "agent", id: token.act.sub });

  return {
    id: newTypedId("evt", now),
    at: new Date(now).toISOString(),
    action: record.action,
    actor_chain: actorChain,
    subject: { type: "tool", id: record.tool },
    decision: record.decision,
    ...(token.grantId === undefined ? {} : { grant_id: token.grantId }),
    jti: token.jti,
    payload: {
      scope: token.scope,
      aud: token.aud,
      required_scopes: record.requiredScopes,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
    },
  };
}

export function createHttpAuditSink(options: AuditSinkOptions): ToolAuditSink {
  const { config } = options;
  const timeoutMs = options.timeoutMs ?? 5_000;

  return {
    async record(entry: ToolAuditRecord): Promise<void> {
      const event = buildToolAuditEvent(entry);
      let response: Response;
      try {
        response = await fetch(`${config.serverUrl}/internal/audit`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-monaca-internal-secret": config.internalSecret,
          },
          body: JSON.stringify({ tenant: config.mcpDemoTenant, org: config.mcpDemoOrg, event }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        options.onError?.(error, entry);
        throw new Error(`audit write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status !== 201) {
        const detail = await response.text().catch(() => "");
        const error = new Error(`audit write rejected: HTTP ${response.status} ${detail}`.trim());
        options.onError?.(error, entry);
        throw error;
      }
    },
  };
}
