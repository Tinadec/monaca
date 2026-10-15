import { jwkThumbprintHex, publicEcJwk } from "@monaca/ui";

/**
 * ES256 key generation in the browser.
 *
 * The security property this file exists to preserve: **the private key never leaves this tab.**
 * `generateKey` is called with `extractable: true` only because the user is offered a download of
 * the private JWK — the file they keep is the agent's sole credential, and the server only ever
 * receives the public half (§6.2 rejects anything with a `d` member).
 *
 * That makes the download the sensitive moment, so it is the one place this module is careful about
 * object URLs and about what it tells the caller: `privateJwk` is returned separately from
 * `publicJwk` and is never placed in a reactive `ref` that could be serialized by a devtools
 * plugin or a state-dumping error reporter. The page holds it in a plain local variable.
 */
export interface GeneratedKey {
  /** Sent to `POST /v1/orgs/{org}/agents/{agent}/keys`. Contains no private component. */
  publicJwk: JsonWebKey;
  /** Held in memory for the download only. Never uploaded, never persisted. */
  privateJwk: JsonWebKey;
  /** Lowercase hex sha256 of the canonical public JWK — exactly what the server stores. */
  fingerprint: string;
  /** The `kid` registered with the key. Generated here, unique per key. */
  kid: string;
}

export type GenerateKeyErrorCode =
  | "MONACA_WEBCRYPTO_UNAVAILABLE"
  | "MONACA_KEY_GENERATION_FAILED";

export class GenerateKeyError extends Error {
  readonly code: GenerateKeyErrorCode;

  constructor(code: GenerateKeyErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code} ${message}`, options);
    this.name = "GenerateKeyError";
    this.code = code;
  }
}

/** `k1`, `k2`, … — short, because it travels in every JWS header for this agent. */
export function nextKeyId(existing: readonly { kid: string }[]): string {
  let highest = 0;
  for (const key of existing) {
    const match = /^k(\d+)$/.exec(key.kid);
    if (match?.[1]) highest = Math.max(highest, Number.parseInt(match[1], 10));
  }
  return `k${highest + 1}`;
}

export async function generateEs256Key(existing: readonly { kid: string }[] = []): Promise<GeneratedKey> {
  // WebCrypto is only exposed on a secure context. `http://localhost` counts, which covers dev, but
  // a deployed console on plain HTTP would silently lose the capability — so say why, not just that
  // it failed.
  if (!globalThis.crypto?.subtle) {
    throw new GenerateKeyError(
      "MONACA_WEBCRYPTO_UNAVAILABLE",
      "WebCrypto needs a secure context. Open the console over HTTPS or via localhost.",
    );
  }

  let pair: CryptoKeyPair;
  try {
    pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
  } catch (cause) {
    throw new GenerateKeyError("MONACA_KEY_GENERATION_FAILED", "the browser refused to generate an ES256 key pair", {
      cause,
    });
  }

  const publicJwk = publicEcJwk(await crypto.subtle.exportKey("jwk", pair.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

  return {
    publicJwk,
    privateJwk,
    fingerprint: await jwkThumbprintHex(publicJwk),
    kid: nextKeyId(existing),
  };
}

/**
 * Hand the private JWK to the user as a file.
 *
 * `application/json` and a `.json` extension: the user will feed this to their own tooling, and a
 * file that opens in an editor is worth more than one that does not. The object URL is revoked on
 * the next tick — long enough for the download to start, short enough that the secret is not
 * reachable from the document for the rest of the session.
 */
export function downloadPrivateJwk(jwk: JsonWebKey, filename: string): void {
  const blob = new Blob([`${JSON.stringify(jwk, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
