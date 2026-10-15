/** Outcome of reading an `Authorization` header. */
export type BearerExtraction =
  /** No credentials offered, or a scheme other than Bearer: treat as unauthenticated. */
  | { kind: "none" }
  /** `Bearer` scheme present but the token part is empty or not a single token68 value. */
  | { kind: "malformed" }
  | { kind: "token"; token: string };

// RFC 6750 §2.1: b64token = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" ) *"="
// JWTs are base64url with dots, which fits; anything else (spaces, quotes, commas) is rejected.
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

/**
 * Pull a bearer token out of an `Authorization` header value. The scheme match is
 * case-insensitive (RFC 9110 §11.1). Tokens are accepted from the header only; a token in the
 * query string or body is never looked at, matching `bearer_methods_supported: ["header"]`.
 */
export function extractBearer(header: string | null | undefined): BearerExtraction {
  if (header === null || header === undefined) return { kind: "none" };
  const trimmed = header.trim();
  const space = trimmed.search(/\s/);
  const scheme = space === -1 ? trimmed : trimmed.slice(0, space);
  if (scheme.toLowerCase() !== "bearer") return { kind: "none" };

  const credentials = space === -1 ? "" : trimmed.slice(space).trim();
  if (credentials === "" || !B64TOKEN.test(credentials)) return { kind: "malformed" };
  return { kind: "token", token: credentials };
}
