/**
 * JWKS sync into the native verifier (contract §9: "JWKS sync"; §4.2: the native module does
 * no I/O — keys are pushed in by TypeScript and cache invalidation is TypeScript's job).
 *
 * The gateway pulls `GET /internal/tenants/{slug}/jwks` from the server (authenticated with
 * `X-Monaca-Internal-Secret`, §6.3), pushes the document into the native `Verifier` with
 * `setKeys`, and installs that verifier into the kernel's slot — but only after a successful
 * sync. Until then the slot holds a fail-closed "unavailable" verifier, so the MCP guard
 * answers 503 rather than letting anything through unverified.
 *
 * When the machine has no native binary (no `bun run fetch:native` yet), the loader throws
 * `MONACA_CORE_BINARY_MISSING` and the gateway stays fail-closed on purpose.
 */
import type { Logger, VerifierSlot } from "@monaca/kernel";
import type { VerifiedToken, VerifyExpectations } from "@monaca/mcp";

/** The slice of `@monaca/core`'s `Verifier` the gateway uses (contract §4.2). */
export interface CoreVerifier {
  setKeys(issuer: string, jwksJson: string): void;
  verifyAccessToken(token: string, expect: VerifyExpectations): VerifiedToken;
}

/** Shape of the `@monaca/core` module the gateway dynamically imports. */
interface CoreModule {
  Verifier?: new (options?: { clockSkewSecs?: number }) => CoreVerifier;
}

/**
 * Loads the native binding, or returns `undefined` when it is absent. Any other failure
 * (a genuinely broken binary) is re-thrown: silently degrading would hide it.
 */
export async function loadNativeVerifier(clockSkewSecs: number, logger: Logger): Promise<CoreVerifier | undefined> {
  let core: CoreModule;
  try {
    core = (await import("@monaca/core")) as CoreModule;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "MONACA_CORE_BINARY_MISSING") {
      logger.warn("native verifier unavailable (no .node binding); MCP guard stays fail-closed 503");
      return undefined;
    }
    throw error;
  }
  if (typeof core.Verifier !== "function") {
    logger.warn("@monaca/core loaded but exposes no Verifier; MCP guard stays fail-closed 503");
    return undefined;
  }
  return new core.Verifier({ clockSkewSecs });
}

export interface JwksSyncerOptions {
  readonly serverUrl: string;
  readonly tenant: string;
  readonly internalSecret: string;
  /** The tenant issuer the keys belong to, e.g. `http://localhost:8080/t/demo`. */
  readonly issuer: string;
  readonly refreshSecs: number;
  readonly verifier: CoreVerifier;
  readonly slot: VerifierSlot;
  readonly logger: Logger;
}

export interface JwksSyncer {
  /** One sync attempt. Returns whether the slot now holds the native verifier. */
  syncOnce(): Promise<boolean>;
  /** Starts the periodic refresh (idempotent). */
  start(): void;
  stop(): void;
}

export function createJwksSyncer(options: JwksSyncerOptions): JwksSyncer {
  const { serverUrl, tenant, internalSecret, issuer, refreshSecs, verifier, slot, logger } = options;
  let installed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function syncOnce(): Promise<boolean> {
    try {
      const response = await fetch(`${serverUrl}/internal/tenants/${encodeURIComponent(tenant)}/jwks`, {
        headers: { accept: "application/json", "x-monaca-internal-secret": internalSecret },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        logger.warn("jwks sync failed", { status: response.status });
        return installed;
      }
      const jwksJson = await response.text();
      verifier.setKeys(issuer, jwksJson);
      if (!installed) {
        slot.set(verifier);
        installed = true;
        logger.info("native verifier installed", { issuer, keys: countKeys(jwksJson) });
      }
      return installed;
    } catch (error) {
      // A failed refresh keeps the previously installed keys — they stay valid until rotation.
      logger.warn("jwks sync error", { error: error instanceof Error ? error.message : String(error) });
      return installed;
    }
  }

  return {
    syncOnce,
    start(): void {
      timer ??= setInterval(() => void syncOnce(), Math.max(1, refreshSecs) * 1000).unref();
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

function countKeys(jwksJson: string): number {
  try {
    const parsed = JSON.parse(jwksJson) as { keys?: unknown };
    return Array.isArray(parsed.keys) ? parsed.keys.length : 0;
  } catch {
    return 0;
  }
}
