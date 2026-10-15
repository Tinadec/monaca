/**
 * RFC 7638 JWK thumbprint — the canonical identity of a public key.
 *
 * The contract (docs/contracts/m0.md §5.7, `agent_keys.fingerprint`) stores "hex sha256 of the
 * canonical JWK (thumbprint, RFC 7638)". So this function returns **lowercase hex**, never the
 * base64url form that most JWT libraries hand back.
 *
 * Two properties matter and are tested:
 *
 * - The hash is taken over the *canonical* JSON, not over the JWK as received. Members are
 *   exactly the required ones (EC: `crv`, `kty`, `x`, `y`; RSA: `e`, `kty`, `n`; oct: `k`, `kty`),
 *   in lexicographic order, with no whitespace. `kid`, `alg`, `use`, `key_ops` and any extra
 *   member are excluded by RFC 7638 §3.2 — which is what makes the thumbprint stable across
 *   clients that decorate their JWKs differently.
 * - It throws on a key it cannot thumbprint rather than hashing a partial object. A fingerprint
 *   that silently covers the wrong bytes is worse than no fingerprint.
 */

/** The members RFC 7638 requires, per key type, in the order they must be serialized. */
const REQUIRED_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  // `crv` < `kty` < `x` < `y` lexicographically.
  EC: ["crv", "kty", "x", "y"],
  // `e` < `kty` < `n`.
  RSA: ["e", "kty", "n"],
  // `k` < `kty`.
  oct: ["k", "kty"],
  // `kty` only.
  OKP: ["crv", "kty", "x"],
};

export class JwkThumbprintError extends Error {
  readonly code = "MONACA_JWK_UNTHUMBPRINTABLE";

  constructor(message: string) {
    super(`MONACA_JWK_UNTHUMBPRINTABLE ${message}`);
    this.name = "JwkThumbprintError";
  }
}

/**
 * Serialize a JWK into the RFC 7638 canonical form. Exported because the console shows it to the
 * user when they want to verify a fingerprint against another implementation.
 */
export function canonicalJwkJson(jwk: JsonWebKey): string {
  const kty = jwk.kty;
  if (typeof kty !== "string" || kty.length === 0) {
    throw new JwkThumbprintError("the JWK has no `kty` member");
  }
  const members = REQUIRED_MEMBERS[kty];
  if (!members) {
    throw new JwkThumbprintError(`key type ${JSON.stringify(kty)} has no required-member set`);
  }

  const parts: string[] = [];
  for (const name of members) {
    const value = (jwk as Record<string, unknown>)[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new JwkThumbprintError(`the JWK has no string \`${name}\` member, required for ${kty}`);
    }
    parts.push(`${JSON.stringify(name)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Lowercase hex sha256 of the RFC 7638 canonical JWK. This is what the server stores. */
export async function jwkThumbprintHex(jwk: JsonWebKey): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJwkJson(jwk)));
  return toHex(new Uint8Array(digest));
}

/**
 * The public half of an EC key, in the member order WebCrypto emits. Used to build the upload
 * payload: the server rejects a JWK carrying `d` with `MONACA_PRIVATE_KEY_SUBMITTED` (§6.2), so
 * constructing the public JWK explicitly — rather than deleting `d` from a copy — is the safer
 * shape. A spread-and-delete would keep any member we failed to anticipate.
 */
export function publicEcJwk(jwk: JsonWebKey): JsonWebKey {
  if (!jwk.x || !jwk.y || !jwk.crv) {
    throw new JwkThumbprintError("the EC JWK is missing `crv`, `x` or `y`");
  }
  return { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y };
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
