/* eslint-disable */
/*
 * BOOTSTRAP PLACEHOLDER for the napi-rs generated declarations of `crates/monaca-napi`.
 * The rust.yml `codegen` job regenerates this file; `bun run fetch:native` copies the
 * generated version over it and the result is committed. Until then, this hand-written
 * copy mirrors the binding contract in docs/contracts/m0.md §4.2 exactly.
 *
 * The first codegen run replaces this file wholesale. Review that first diff once instead of
 * "fixing" it toward this placeholder (§10.6) — napi renders the same surface with its own
 * formatting, doc-comment placement and import style, and that rendering is what is committed.
 */

/** One link of a delegation chain. */
export interface ActorChain {
  /** Agent ID (`agt_…`). */
  sub: string
  /** The actor that delegated to `sub`; present on multi-hop (M3) chains. */
  act?: ActorChain
}

/** Claim set parsed out of a verified access token. */
export interface VerifiedToken {
  iss: string
  /** `acc_…`: the user, or the delegating user on an agent token. */
  sub: string
  aud: string
  /** Tenant ID (`ten_…`). */
  tid: string
  /** Organization ID (`org_…`). */
  org: string
  /** Sorted, de-duplicated scopes. */
  scope: Array<string>
  /** Present on delegated (agent) tokens only. */
  act?: ActorChain
  /** `grt_…`, present on delegated tokens only. */
  grantId?: string
  jti: string
  iat: number
  exp: number
}

export interface VerifierOptions {
  /** Permitted clock skew in seconds. Defaults to 60. */
  clockSkewSecs?: number
}

export interface VerifyExpectations {
  issuer: string
  audience: string
}

/** In-process verifier. No I/O: keys are pushed in from TypeScript via setKeys. */
export declare class Verifier {
  constructor(opts?: VerifierOptions | undefined | null)
  /** Replace the key set for one issuer. Throws MONACA_JWKS_INVALID. */
  setKeys(issuer: string, jwksJson: string): void
  /** Throws an Error whose `code` is a MONACA_TOKEN_* code. */
  verifyAccessToken(token: string, expect: VerifyExpectations): VerifiedToken
}

/** True when every entry of `required` is in `granted`. */
export declare function scopeSatisfies(granted: Array<string>, required: Array<string>): boolean

/** Version of the native module (the monaca-napi crate version). */
export declare function version(): string
