/**
 * Structural mirror of the `@monaca/core` surface the Bun side consumes (docs/contracts/m0.md §4.2).
 * It is declared here instead of imported so the kernel never loads the native binary; the gateway
 * asserts at compile time that `@monaca/core`'s `Verifier` is assignable to `AccessTokenVerifier`.
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

/** Throws an `Error` whose `code` is a `MONACA_TOKEN_*` code on rejection (contract §4.3). */
export interface AccessTokenVerifier {
  verifyAccessToken(token: string, expect: VerifyExpectations): VerifiedToken | Promise<VerifiedToken>;
}

export const VERIFIER_UNAVAILABLE = "MONACA_VERIFIER_UNAVAILABLE";

/** The verifier cannot run at all (no native binary, keys not synced yet). Says nothing about the token. */
export class VerifierUnavailableError extends Error {
  readonly code = VERIFIER_UNAVAILABLE;

  constructor(reason: string) {
    super(`${VERIFIER_UNAVAILABLE}: ${reason}`);
    this.name = "VerifierUnavailableError";
  }
}

/** Fail-closed placeholder: every verification throws {@link VerifierUnavailableError}. */
export function createUnavailableVerifier(reason: string): AccessTokenVerifier {
  return {
    verifyAccessToken(): never {
      throw new VerifierUnavailableError(reason);
    },
  };
}

/**
 * The verifier handed to every module. It delegates to whatever is currently installed, so a
 * module that captured `ctx.verifier` early still sees a later swap (e.g. after the native binary
 * loads or JWKS sync completes).
 */
export interface VerifierSlot extends AccessTokenVerifier {
  get(): AccessTokenVerifier;
  set(verifier: AccessTokenVerifier): void;
}

export function createVerifierSlot(initial?: AccessTokenVerifier): VerifierSlot {
  let current: AccessTokenVerifier = initial ?? createUnavailableVerifier("no verifier installed");
  return {
    get: () => current,
    set(verifier) {
      current = verifier;
    },
    verifyAccessToken: (token, expect) => current.verifyAccessToken(token, expect),
  };
}
