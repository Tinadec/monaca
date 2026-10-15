/**
 * Claims of a verified access token, mirroring `VerifiedToken` in `@monaca/core`
 * (docs/contracts/m0.md §4.2). Declared here so the guard never imports the native binary;
 * `modules/mcp-demo` asserts at compile time that this stays assignable both ways with the kernel's copy.
 */
export interface ActorChain {
  sub: string;
  act?: ActorChain;
}

export interface VerifiedToken {
  iss: string;
  sub: string;
  aud: string;
  tid: string;
  org: string;
  scope: string[];
  act?: ActorChain;
  grantId?: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface VerifyExpectations {
  issuer: string;
  audience: string;
}

/**
 * Anything shaped like `@monaca/core`'s `Verifier.verifyAccessToken`. It throws an `Error` whose
 * `code` is `MONACA_TOKEN_*` when the token is bad, or `MONACA_VERIFIER_UNAVAILABLE` when it
 * cannot run at all. May be async so a remote or WASM verifier fits too.
 */
export interface TokenVerifier {
  verifyAccessToken(token: string, expect: VerifyExpectations): VerifiedToken | Promise<VerifiedToken>;
}

/** Tool name -> scopes the caller must hold. An empty list means "any authenticated caller". */
export type ToolScopeMap = Readonly<Record<string, readonly string[]>>;

export type ToolDenialReason = "insufficient_scope" | "unknown_tool";

/** What the guard tells the audit sink about one `tools/call`. */
export interface ToolAuditRecord {
  action: "tool.invoked" | "tool.denied";
  decision: "allow" | "deny";
  tool: string;
  requiredScopes: readonly string[];
  /** Present on `tool.denied` only. */
  reason?: ToolDenialReason;
  token: VerifiedToken;
}

/**
 * Receives one record per `tools/call`, before the call is executed or refused. If `record`
 * throws, the guard fails the request closed (503): an unaudited call is not allowed through
 * (docs/contracts/m0.md §9).
 */
export interface ToolAuditSink {
  record(entry: ToolAuditRecord): void | Promise<void>;
}

/** Logger surface the guard uses; the kernel's `Logger` satisfies it (it also has `info`/`child`). */
export interface GuardLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
