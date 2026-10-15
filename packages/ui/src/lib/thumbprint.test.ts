import { describe, expect, test } from "bun:test";

import {
  JwkThumbprintError,
  canonicalJwkJson,
  jwkThumbprintHex,
  publicEcJwk,
} from "./thumbprint";

/** RFC 7638 §3.1 — the worked example from the specification itself. */
const RFC7638_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
};

describe("canonicalJwkJson", () => {
  test("emits only the required members, in lexicographic order, without whitespace", () => {
    expect(canonicalJwkJson(RFC7638_JWK)).toBe(
      '{"crv":"P-256","kty":"EC","x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",' +
        '"y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0"}',
    );
  });

  test("drops every optional member, so decoration cannot change the identity", () => {
    const decorated = {
      ...RFC7638_JWK,
      kid: "k1",
      alg: "ES256",
      use: "sig",
      key_ops: ["verify"],
      ext: true,
      d: "not-part-of-the-thumbprint",
    };
    expect(canonicalJwkJson(decorated)).toBe(canonicalJwkJson(RFC7638_JWK));
  });

  test("rejects a JWK with no kty, an unknown kty, or a missing required member", () => {
    expect(() => canonicalJwkJson({ crv: "P-256", x: "a", y: "b" } as JsonWebKey)).toThrow(
      JwkThumbprintError,
    );
    expect(() => canonicalJwkJson({ kty: "DSA" } as JsonWebKey)).toThrow(JwkThumbprintError);
    expect(() => canonicalJwkJson({ kty: "EC", crv: "P-256", x: "a" } as JsonWebKey)).toThrow(
      /required for EC/,
    );
  });
});

describe("jwkThumbprintHex", () => {
  test("matches the RFC 7638 §3.1 published thumbprint", async () => {
    // The RFC publishes the base64url form; the contract stores hex, so both are asserted.
    expect(await jwkThumbprintHex(RFC7638_JWK)).toBe(
      "a0a232c2f194a53553cb1310ddbc0821e414b9d7ebfc290b323084d7d1020fe5",
    );
  });

  test("is always 64 lowercase hex characters", async () => {
    const { publicKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const hex = await jwkThumbprintHex(await crypto.subtle.exportKey("jwk", publicKey));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is stable across an export/import round trip", async () => {
    const { publicKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const jwk = await crypto.subtle.exportKey("jwk", publicKey);
    const reimported = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    expect(await jwkThumbprintHex(await crypto.subtle.exportKey("jwk", reimported))).toBe(
      await jwkThumbprintHex(jwk),
    );
  });

  test("differs for two distinct keys", async () => {
    const a = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const b = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const [ha, hb] = await Promise.all([
      jwkThumbprintHex(await crypto.subtle.exportKey("jwk", a.publicKey)),
      jwkThumbprintHex(await crypto.subtle.exportKey("jwk", b.publicKey)),
    ]);
    expect(ha).not.toBe(hb);
  });
});

describe("publicEcJwk", () => {
  test("keeps exactly kty/crv/x/y, so a private component can never be uploaded", async () => {
    const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ]);
    const full = await crypto.subtle.exportKey("jwk", privateKey);
    expect(full.d).toBeDefined();

    const pub = publicEcJwk(full);
    expect(Object.keys(pub).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(pub.d).toBeUndefined();
    expect((pub as Record<string, unknown>)["kid"]).toBeUndefined();
  });
});
