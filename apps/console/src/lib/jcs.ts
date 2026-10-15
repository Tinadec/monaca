/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * The audit chain hash is `sha256(prev_hash_bytes || jcs_bytes)` (docs/contracts/m0.md §8.2), so
 * the mock layer needs the same canonicalization the server's `serde_jcs` performs — otherwise the
 * fixtures would show a chain that does not actually verify.
 *
 * JCS fixes two things plain `JSON.stringify` leaves free:
 *
 * 1. **Member order.** Objects are serialized with their names sorted by UTF-16 code unit. Note
 *    this is not alphabetical in any locale sense: U+000D < "1" < U+0080 < "ö" < "€" < U+FB33.
 * 2. **Number formatting.** ECMAScript `Number::toString`, which `JSON.stringify` already emits,
 *    except that `-0` becomes `0` and non-finite values become `null`.
 *
 * Cost is inherent to the scheme: sorting a fresh copy of every object, so canonicalization is not
 * free. The server pays it once per append, which is the right place.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalNumber(value);
    case "string":
      return JSON.stringify(value);
    case "bigint":
      throw new TypeError("JCS cannot serialize a bigint");
    case "object":
      break;
    default:
      throw new TypeError(`JCS cannot serialize a ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item === undefined ? null : item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const names: string[] = [];
  for (const name of Object.keys(record)) {
    // `undefined` has no JSON representation, so the member is dropped rather than emitted as null.
    if (record[name] !== undefined) names.push(name);
  }
  // The default Array sort compares by UTF-16 code unit, which is exactly what RFC 8785 §3.2.3 asks
  // for — and deliberately not `localeCompare`, which would order by collation.
  names.sort();

  const members = names.map((name) => `${JSON.stringify(name)}:${canonicalize(record[name])}`);
  return `{${members.join(",")}}`;
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) return "null";
  // `JSON.stringify(-0)` is "0" already, but being explicit documents the rule JCS imposes.
  if (Object.is(value, -0)) return "0";
  return JSON.stringify(value);
}

/**
 * `hash = hex(sha256(prev_hash_bytes || jcs_bytes))`, §8.2. `prevHashHex` is the raw 32-byte
 * previous hash in hex (64 zeros at genesis); the digest is taken over its **bytes**, not its hex
 * text — getting that wrong still produces plausible-looking output, which is why the tests below
 * assert the genesis case explicitly.
 */
export async function chainHash(prevHashHex: string, event: unknown): Promise<string> {
  const prev = fromHex(prevHashHex);
  if (prev.length !== 32) throw new Error(`prev_hash must be 32 bytes, got ${prev.length}`);

  const body = new TextEncoder().encode(canonicalize(event));
  const input = new Uint8Array(prev.length + body.length);
  input.set(prev, 0);
  input.set(body, prev.length);

  const digest = await crypto.subtle.digest("SHA-256", input);
  return toHex(new Uint8Array(digest));
}

export const GENESIS_HASH = "0".repeat(64);

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`not hex: ${hex}`);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
