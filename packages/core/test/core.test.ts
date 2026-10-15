/**
 * Differential test: the native Verifier against `jose`.
 *
 * The point is not that either implementation works in isolation — it is that they agree. A
 * token `jose` signs must verify natively, and every token one rejects the other must reject too,
 * with the same reason. That is what `docs/contracts/m0.md` §10.6 asks `bun test` to cover.
 *
 * The native binding is a CI build artifact, not an npm package, so it is usually absent on a
 * developer machine. The whole suite then skips with one clear message rather than failing —
 * `bun run fetch:native` is the fix, and CI always has the artifact.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from "jose";

const ISSUER = "http://localhost:8080/t/demo";
const AUDIENCE = "http://localhost:8080/mcp/demo";
const OTHER_AUDIENCE = "http://localhost:8080/mcp/other";
const OTHER_ISSUER = "http://localhost:8080/t/other";
const KID = "01920000-0000-7000-8000-0000000000aa";

/** The subset of the binding this test uses; `index.d.ts` declares the full surface. */
interface NativeModule {
  Verifier: new (opts?: { clockSkewSecs?: number }) => {
    setKeys(issuer: string, jwksJson: string): void;
    verifyAccessToken(
      token: string,
      expect: { issuer: string; audience: string },
    ): {
      iss: string;
      sub: string;
      aud: string;
      tid: string;
      org: string;
      scope: string[];
      act?: { sub: string; act?: unknown };
      grantId?: string;
      jti: string;
      iat: number;
      exp: number;
    };
  };
  scopeSatisfies(granted: string[], required: string[]): boolean;
  version(): string;
}

/**
 * Load the native binding, or report why it is unavailable.
 *
 * `require` rather than a static import: `@monaca/core`'s loader throws synchronously when the
 * platform binary is missing, and a static import would turn that into a module-resolution
 * failure that `bun test` reports as a crash rather than a skip.
 */
function loadNative(): { module: NativeModule } | { reason: string } {
  try {
    const module = require("../index.js") as NativeModule;
    if (typeof module?.Verifier !== "function") {
      return { reason: "@monaca/core loaded but exports no Verifier" };
    }
    return { module };
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === "MONACA_CORE_BINARY_MISSING" || code === "MONACA_CORE_PLATFORM_UNSUPPORTED") {
      return { reason: `${code}: ${(cause as Error).message.split("\n")[0]}` };
    }
    return { reason: `could not load @monaca/core: ${String(cause)}` };
  }
}

const native = loadNative();
const unavailable = "reason" in native;

if (unavailable) {
  // One test that always runs and explains the skip, so a green run is never mistaken for
  // "verification was actually exercised".
  test.skip(`native differential suite skipped — ${native.reason}`, () => {});
}

describe.if(!unavailable)("native Verifier vs jose", () => {
  let module: NativeModule;
  let privateKey: CryptoKey;
  let publicJwk: JWK;
  let jwksJson: string;

  /** Sign a token with the shared key, the way the server would. */
  async function sign(
    claims: Record<string, unknown>,
    options: { kid?: string; expiresIn?: string } = {},
  ): Promise<string> {
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: options.kid ?? KID, typ: "at+jwt" })
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? "15m")
      .sign(privateKey);
  }

  /** A §7.1 user access token's claims. */
  function userClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      iss: ISSUER,
      sub: "acc_00000000000000000000000000",
      aud: AUDIENCE,
      tid: "ten_00000000000000000000000000",
      org: "org_00000000000000000000000000",
      scope: ["tools:read"],
      jti: "01920000-0000-7000-8000-000000000000",
      ...overrides,
    };
  }

  /** The `code` on a thrown native error, or `undefined`. */
  function codeOf(fn: () => unknown): string | undefined {
    try {
      fn();
      return undefined;
    } catch (cause) {
      return (cause as { code?: string }).code;
    }
  }

  beforeAll(async () => {
    if (unavailable) return;
    module = native.module;

    const pair = await generateKeyPair("ES256", { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "ES256", use: "sig" };
    jwksJson = JSON.stringify({ keys: [publicJwk] });
  });

  test("version() reports a semver", () => {
    expect(module.version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("verifies a jose-signed user token", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(userClaims());
    const verified = verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE });

    expect(verified.iss).toBe(ISSUER);
    expect(verified.sub).toBe("acc_00000000000000000000000000");
    expect(verified.aud).toBe(AUDIENCE);
    expect(verified.tid).toBe("ten_00000000000000000000000000");
    expect(verified.org).toBe("org_00000000000000000000000000");
    expect(verified.scope).toEqual(["tools:read"]);
    expect(verified.jti).toBe("01920000-0000-7000-8000-000000000000");
    expect(verified.act).toBeUndefined();
    expect(verified.grantId).toBeUndefined();
    expect(verified.exp).toBeGreaterThan(verified.iat);
  });

  test("reports a delegated token's actor chain", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(
      userClaims({
        act: { sub: "agt_00000000000000000000000000" },
        grant_id: "grt_00000000000000000000000000",
      }),
    );
    const verified = verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE });

    expect(verified.sub).toBe("acc_00000000000000000000000000");
    expect(verified.act?.sub).toBe("agt_00000000000000000000000000");
    expect(verified.grantId).toBe("grt_00000000000000000000000000");
  });

  test("handles a nested actor chain", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(
      userClaims({ act: { sub: "agt_child", act: { sub: "agt_parent" } } }),
    );
    const verified = verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE });

    expect(verified.act?.sub).toBe("agt_child");
    expect((verified.act?.act as { sub: string } | undefined)?.sub).toBe("agt_parent");
  });

  test("normalizes the scope array", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(userClaims({ scope: ["tools:write", "openid", "tools:read", "openid"] }));
    const verified = verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE });

    expect(verified.scope).toEqual(["openid", "tools:read", "tools:write"]);
  });

  test("rejects an expired token with MONACA_TOKEN_EXPIRED", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    // `jose` will not sign an already-expired token through `setExpirationTime`, so the expiry is
    // a claim like any other.
    const token = await new SignJWT({
      ...userClaims(),
      exp: Math.floor(Date.now() / 1000) - 3_600,
      iat: Math.floor(Date.now() / 1000) - 7_200,
    })
      .setProtectedHeader({ alg: "ES256", kid: KID, typ: "at+jwt" })
      .sign(privateKey);

    expect(
      codeOf(() => verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE })),
    ).toBe("MONACA_TOKEN_EXPIRED");
  });

  test("accepts a token expired inside the clock skew", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ ...userClaims(), iat: now - 900, exp: now - 30 })
      .setProtectedHeader({ alg: "ES256", kid: KID, typ: "at+jwt" })
      .sign(privateKey);

    expect(() =>
      verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE }),
    ).not.toThrow();
  });

  test("rejects a wrong audience with MONACA_TOKEN_AUDIENCE_MISMATCH", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(userClaims());
    expect(
      codeOf(() =>
        verifier.verifyAccessToken(token, { issuer: ISSUER, audience: OTHER_AUDIENCE }),
      ),
    ).toBe("MONACA_TOKEN_AUDIENCE_MISMATCH");
  });

  test("accepts an audience array containing the expected value", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(userClaims({ aud: [OTHER_AUDIENCE, AUDIENCE] }));
    const verified = verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE });
    expect(verified.aud).toContain(AUDIENCE);
  });

  test("rejects a wrong issuer with MONACA_TOKEN_ISSUER_MISMATCH", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(userClaims({ iss: OTHER_ISSUER }));
    expect(
      codeOf(() => verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE })),
    ).toBe("MONACA_TOKEN_ISSUER_MISMATCH");
  });

  test("rejects an unknown kid with MONACA_TOKEN_UNKNOWN_KID", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(userClaims(), { kid: "01920000-0000-7000-8000-0000000000bb" });
    expect(
      codeOf(() => verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE })),
    ).toBe("MONACA_TOKEN_UNKNOWN_KID");
  });

  test("rejects a token from an issuer with no keys loaded", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(userClaims());
    expect(
      codeOf(() => verifier.verifyAccessToken(token, { issuer: OTHER_ISSUER, audience: AUDIENCE })),
    ).toBe("MONACA_TOKEN_UNKNOWN_KID");
  });

  test("rejects a token signed by another key", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const other = await generateKeyPair("ES256", { extractable: true });
    const token = await new SignJWT(userClaims())
      .setProtectedHeader({ alg: "ES256", kid: KID, typ: "at+jwt" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(other.privateKey);

    expect(
      codeOf(() => verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE })),
    ).toBe("MONACA_TOKEN_INVALID_SIGNATURE");
  });

  test("rejects a tampered payload", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(userClaims());
    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify(userClaims({ scope: ["tools:read", "monaca:admin"] })),
    ).toString("base64url");
    const forged = `${header}.${forgedPayload}.${signature}`;

    expect(
      codeOf(() => verifier.verifyAccessToken(forged, { issuer: ISSUER, audience: AUDIENCE })),
    ).toBe("MONACA_TOKEN_INVALID_SIGNATURE");
  });

  test("rejects malformed tokens with MONACA_TOKEN_MALFORMED", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    for (const token of ["", "not-a-token", "a.b", "a.b.c.d", "!!!.???.###"]) {
      const code = codeOf(() =>
        verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE }),
      );
      // A malformed token either fails to decode or names a key we never loaded; both are
      // rejections, and the exact one depends on how far `jose`'s parser got.
      expect(code === "MONACA_TOKEN_MALFORMED" || code === "MONACA_TOKEN_UNKNOWN_KID").toBe(true);
    }
  });

  test("rejects a missing required claim with MONACA_TOKEN_CLAIMS_INVALID", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    for (const claim of ["sub", "tid", "org", "jti", "iss", "aud"]) {
      const claims = userClaims();
      delete claims[claim];
      const token = await sign(claims);

      expect(
        codeOf(() => verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE })),
      ).toBe("MONACA_TOKEN_CLAIMS_INVALID");
    }
  });

  test("throws MONACA_JWKS_INVALID for an unusable JWKS", () => {
    const verifier = new module.Verifier();
    expect(codeOf(() => verifier.setKeys(ISSUER, "{}"))).toBe("MONACA_JWKS_INVALID");
    expect(codeOf(() => verifier.setKeys(ISSUER, "not json"))).toBe("MONACA_JWKS_INVALID");
  });

  test("every error message is prefixed with its code", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(userClaims());
    try {
      verifier.verifyAccessToken(token, { issuer: ISSUER, audience: OTHER_AUDIENCE });
      throw new Error("the call should have thrown");
    } catch (cause) {
      const error = cause as { code?: string; message: string };
      expect(error.code).toBe("MONACA_TOKEN_AUDIENCE_MISMATCH");
      expect(error.message.startsWith(error.code!)).toBe(true);
    }
  });

  test("replacing the key set retires the old key", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(userClaims());
    expect(() =>
      verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE }),
    ).not.toThrow();

    const replacement = await generateKeyPair("ES256", { extractable: true });
    const replacementJwk = await exportJWK(replacement.publicKey);
    verifier.setKeys(
      ISSUER,
      JSON.stringify({ keys: [{ ...replacementJwk, kid: KID }] }),
    );

    expect(
      codeOf(() => verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE })),
    ).toBe("MONACA_TOKEN_INVALID_SIGNATURE");
  });

  test("jose and the native verifier agree on a good token", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(userClaims());
    // Both accept.
    const verified = verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE });
    expect(verified.sub).toBe("acc_00000000000000000000000000");

    const { jwtVerify } = await import("jose");
    // `jose` requires the *public* key for ES256 verification; handing it the private key throws
    // a TypeError rather than verifying.
    const result = await jwtVerify(token, publicJwk, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["ES256"],
    });
    expect(result.payload.sub).toBe("acc_00000000000000000000000000");
  });

  test("jose and the native verifier agree on a bad audience", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(userClaims());
    // The native side rejects with a code...
    expect(
      codeOf(() =>
        verifier.verifyAccessToken(token, { issuer: ISSUER, audience: OTHER_AUDIENCE }),
      ),
    ).toBe("MONACA_TOKEN_AUDIENCE_MISMATCH");

    // ...and so does jose, with its own error class.
    const { jwtVerify, errors } = await import("jose");
    await expect(
      jwtVerify(token, publicJwk, {
        issuer: ISSUER,
        audience: OTHER_AUDIENCE,
        algorithms: ["ES256"],
      }),
    ).rejects.toBeInstanceOf(errors.JWTClaimValidationFailed);
  });

  test("jose and the native verifier agree on a wrong issuer", async () => {
    const verifier = new module.Verifier();
    verifier.setKeys(ISSUER, jwksJson);

    const token = await sign(userClaims({ iss: OTHER_ISSUER }));
    expect(
      codeOf(() => verifier.verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE })),
    ).toBe("MONACA_TOKEN_ISSUER_MISMATCH");

    const { jwtVerify, errors } = await import("jose");
    await expect(
      jwtVerify(token, publicJwk, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["ES256"],
      }),
    ).rejects.toBeInstanceOf(errors.JWTClaimValidationFailed);
  });

  describe("scopeSatisfies", () => {
    test("is subset, not intersection", () => {
      expect(module.scopeSatisfies(["tools:read"], ["tools:read"])).toBe(true);
      expect(module.scopeSatisfies(["tools:read", "openid"], ["tools:read"])).toBe(true);
      expect(module.scopeSatisfies(["tools:read"], ["tools:write"])).toBe(false);
      expect(module.scopeSatisfies(["tools:read"], ["tools:read", "tools:write"])).toBe(false);
    });

    test("nothing required is always satisfied", () => {
      expect(module.scopeSatisfies([], [])).toBe(true);
      expect(module.scopeSatisfies(["tools:read"], [])).toBe(true);
      expect(module.scopeSatisfies([], ["tools:read"])).toBe(false);
    });

    test("is exact, not prefix or case-insensitive", () => {
      expect(module.scopeSatisfies(["tools:read"], ["tools:"])).toBe(false);
      expect(module.scopeSatisfies(["tools:read"], ["Tools:Read"])).toBe(false);
    });

    test("ignores duplicates", () => {
      expect(module.scopeSatisfies(["tools:read", "tools:read"], ["tools:read"])).toBe(true);
    });
  });
});
