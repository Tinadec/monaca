import type { MiddlewareHandler } from "hono";
import { extractBearer } from "./bearer.ts";
import { problemResponse } from "./problem.ts";
import type { GuardLogger, ToolAuditRecord, ToolAuditSink, ToolScopeMap, TokenVerifier, VerifiedToken } from "./types.ts";
import { buildWwwAuthenticate } from "./www-authenticate.ts";

/**
 * The MCP resource-server guard (docs/contracts/m0.md §9).
 *
 * A Hono middleware mounted in front of a module's MCP routes. Per request it:
 *
 *  1. pulls a bearer token out of the `Authorization` header only (RFC 6750 §2.1);
 *  2. verifies it through the injected {@link TokenVerifier} — the kernel's `VerifierSlot`
 *     satisfies that shape, and the guard itself never imports the native binary;
 *  3. for every `tools/call` in the (possibly batched) JSON-RPC body, checks the tool's
 *     required scopes against the token's `scope`;
 *  4. writes `tool.invoked` / `tool.denied` to the {@link ToolAuditSink} **before** the
 *     request is allowed through or refused — a failing sink fails the request closed;
 *  5. stashes the verified token (and the parsed body, so the transport does not read the
 *     request stream twice) under {@link MCP_GUARD_KEY} for the route handler.
 *
 * Failure modes are fail-closed: no token → 401, bad token → 401, verifier unavailable →
 * 503, missing scope → 403, unknown tool → 403, audit write failure → 503.
 */

declare module "hono" {
  interface ContextVariableMap {
    /** Set by {@link resourceGuard}; read by the MCP route handler. */
    "monaca.mcp": McpGuardContext;
  }
}

/** Context key the guard stashes its result under. */
export const MCP_GUARD_KEY = "monaca.mcp";

/** What the guard leaves on the Hono context for the route handler. */
export interface McpGuardContext {
  readonly token: VerifiedToken;
  /**
   * The parsed JSON-RPC payload when the guard could read it. The Streamable HTTP transport
   * accepts a pre-parsed body (`handleRequest(req, { parsedBody })`), so handing this over
   * avoids reading the request stream a second time. `undefined` when the body was absent
   * or unparseable — the transport then produces the protocol-level error itself.
   */
  readonly body?: unknown;
}

export interface ResourceGuardOptions {
  /** Verifies access tokens. Throws an `Error` whose `code` is a `MONACA_TOKEN_*` code, or `MONACA_VERIFIER_UNAVAILABLE`. */
  readonly verifier: TokenVerifier;
  /** Tool name → scopes the caller must hold. An empty list means "any authenticated caller". */
  readonly scopeMap: ToolScopeMap;
  /** RFC 9728 metadata URL; sent in every `WWW-Authenticate` challenge. */
  readonly resourceMetadataUrl: string;
  /** Issuer and audience the token must match (contract §4.2 `VerifyExpectations`). */
  readonly expect: { readonly issuer: string; readonly audience: string };
  /** Receives one record per `tools/call` before the call runs or is refused. */
  readonly auditSink: ToolAuditSink;
  readonly logger?: GuardLogger;
}

/** `MONACA_VERIFIER_UNAVAILABLE` says nothing about the token; everything else is a rejection. */
const VERIFIER_UNAVAILABLE_CODE = "MONACA_VERIFIER_UNAVAILABLE";

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** M0 scope semantics: the granted set must contain every required scope. */
export function scopesCover(granted: readonly string[], required: readonly string[]): boolean {
  if (required.length === 0) return true;
  const held = new Set(granted);
  return required.every((scope) => held.has(scope));
}

/** One `tools/call` request found in a single or batched JSON-RPC body. */
interface ToolCall {
  readonly id: unknown;
  /** `undefined` when `params.name` is missing or not a string — treated as an unknown tool. */
  readonly name: string | undefined;
}

/** Collects every `tools/call` from a single message or a batch (MCP batches are legacy but legal). */
export function findToolCalls(body: unknown): ToolCall[] {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  const calls: ToolCall[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.method !== "tools/call") continue;
    const params = isRecord(message.params) ? message.params : undefined;
    const name = params?.name;
    calls.push({ id: message.id, name: typeof name === "string" ? name : undefined });
  }
  return calls;
}

/**
 * The guard. Mount it with `app.use(mountPath, resourceGuard({...}))` before the MCP routes;
 * the route handler reads {@link MCP_GUARD_KEY} off the context.
 */
export function resourceGuard(options: ResourceGuardOptions): MiddlewareHandler {
  const { verifier, scopeMap, expect, auditSink, logger } = options;
  const challenge = (error?: "invalid_token" | "insufficient_scope", scope?: readonly string[]): string =>
    buildWwwAuthenticate({ resourceMetadataUrl: options.resourceMetadataUrl, error, scope });

  return async (c, next) => {
    // --- 1. credentials -----------------------------------------------------------------
    const extraction = extractBearer(c.req.header("authorization"));
    if (extraction.kind === "none") {
      logger?.debug("mcp guard: no bearer token", { path: c.req.path });
      return problemResponse({
        code: "MONACA_TOKEN_MISSING",
        status: 401,
        title: "Authentication required",
        detail: "This protected resource requires a bearer access token.",
        instance: c.req.path,
        headers: { "www-authenticate": challenge() },
      });
    }
    if (extraction.kind === "malformed") {
      logger?.debug("mcp guard: malformed bearer token", { path: c.req.path });
      return problemResponse({
        code: "MONACA_TOKEN_MALFORMED",
        status: 401,
        title: "Invalid token",
        detail: "The Authorization header did not carry a single well-formed bearer token.",
        instance: c.req.path,
        headers: { "www-authenticate": challenge("invalid_token") },
      });
    }

    // --- 2. verification -----------------------------------------------------------------
    let token: VerifiedToken;
    try {
      token = await verifier.verifyAccessToken(extraction.token, expect);
    } catch (error) {
      const code = errorCode(error);
      if (code === VERIFIER_UNAVAILABLE_CODE) {
        // Says nothing about the token: the resource server cannot check anything. Fail closed,
        // and say so with a 503 rather than a 401 that would blame the client.
        logger?.error("mcp guard: verifier unavailable", { code, path: c.req.path });
        return problemResponse({
          code: VERIFIER_UNAVAILABLE_CODE,
          status: 503,
          title: "Token verification unavailable",
          detail: "The resource server cannot verify tokens right now.",
          instance: c.req.path,
          headers: { "www-authenticate": challenge() },
        });
      }
      logger?.debug("mcp guard: token rejected", { code, path: c.req.path });
      return problemResponse({
        code: code ?? "MONACA_TOKEN_INVALID",
        status: 401,
        title: "Invalid token",
        instance: c.req.path,
        headers: { "www-authenticate": challenge("invalid_token") },
      });
    }

    // --- 3. the JSON-RPC body (cloned: the transport still needs the original stream) ------
    let body: unknown;
    try {
      body = await c.req.raw.clone().json();
    } catch {
      // No body (GET/DELETE) or not JSON: nothing to scope-check, the transport answers.
      body = undefined;
    }

    // --- 4. per-tool scope checks + audit-before-response ---------------------------------
    // Two passes over the (possibly batched) calls: decide everything first, then audit. A
    // refused batch must never leave a `tool.invoked` record for a call that will not run —
    // the audit log has to say what actually happened.
    const verdicts = findToolCalls(body).map((call) => {
      const tool = call.name ?? "";
      const required = scopeMap[tool];
      return { tool, required, allowed: required !== undefined && scopesCover(token.scope, required) };
    });
    const denied = verdicts.filter((verdict) => !verdict.allowed);

    const auditUnavailable = (tool: string, error: unknown): Response => {
      logger?.error("mcp guard: audit write failed", { tool, error });
      return problemResponse({
        code: "MONACA_AUDIT_UNAVAILABLE",
        status: 503,
        title: "Audit unavailable",
        detail: "The tool call could not be audited and was not executed.",
        instance: c.req.path,
      });
    };

    if (denied.length > 0) {
      for (const verdict of denied) {
        const record: ToolAuditRecord = {
          action: "tool.denied",
          decision: "deny",
          tool: verdict.tool,
          requiredScopes: verdict.required ?? [],
          reason: verdict.required === undefined ? "unknown_tool" : "insufficient_scope",
          token,
        };
        try {
          await auditSink.record(record);
        } catch (error) {
          return auditUnavailable(verdict.tool, error);
        }
      }
      // The response names the first refusal in body order.
      const first = denied[0];
      const tool = first?.tool ?? "";
      const required = first?.required;
      if (required === undefined) {
        // Not in the fixed tool map: not authorised, and no scope can be named for it.
        logger?.debug("mcp guard: unknown tool denied", { tool });
        return problemResponse({
          code: "MONACA_TOOL_UNKNOWN",
          status: 403,
          title: "Unknown tool",
          detail: `Tool "${tool}" is not part of this resource server.`,
          instance: c.req.path,
          headers: { "www-authenticate": challenge() },
        });
      }
      logger?.debug("mcp guard: insufficient scope", { tool, required, granted: token.scope });
      return problemResponse({
        code: "MONACA_INSUFFICIENT_SCOPE",
        status: 403,
        title: "Insufficient scope",
        detail: `Tool "${tool}" requires scope(s): ${required.join(" ")}.`,
        instance: c.req.path,
        headers: { "www-authenticate": challenge("insufficient_scope", required) },
      });
    }

    for (const verdict of verdicts) {
      const record: ToolAuditRecord = {
        action: "tool.invoked",
        decision: "allow",
        tool: verdict.tool,
        requiredScopes: verdict.required ?? [],
        token,
      };
      try {
        await auditSink.record(record);
      } catch (error) {
        return auditUnavailable(verdict.tool, error);
      }
    }

    // --- 5. hand the verified token (and parsed body) to the route handler ------------------
    c.set(MCP_GUARD_KEY, body === undefined ? { token } : { token, body });
    await next();
  };
}
