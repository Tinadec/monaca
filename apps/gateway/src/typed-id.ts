/**
 * Typed IDs, encode-only — the subset the gateway needs: `evt_…` ids for audit events it
 * submits to `/internal/audit` (contract §8.1).
 *
 * Same format as the console's copy (apps/console/src/lib/typed-id.ts, kept for its mock layer)
 * and the authoritative Rust implementation in `monaca-types` (§5.2): `<prefix>_<suffix>`, the
 * suffix being the TypeID v0.3 encoding of a UUIDv7 — the UUID as a 128-bit big-endian integer
 * with two zero padding bits, then 26 symbols of 5 bits each in lowercase Crockford base32
 * `0123456789abcdefghjkmnpqrstvwxyz` (no `i l o u`).
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A UUIDv7: 48-bit big-endian millisecond timestamp, version nibble 7, RFC 4122 variant bits. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const ms = BigInt(now);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Encode a UUIDv7 (canonical hyphenated form) as a 26-symbol TypeID suffix. */
export function encodeTypeIdSuffix(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`not a 32-hex-digit UUID: ${uuid}`);
  }

  let value = BigInt(`0x${hex}`);
  // 130 bits = 26 symbols x 5 bits; the two leading zero bits are TypeID's padding.
  const symbols = new Array<string>(26);
  for (let index = 25; index >= 0; index -= 1) {
    const symbol = ALPHABET[Number(value & 0x1fn)];
    if (symbol === undefined) throw new Error("base32 index out of range");
    symbols[index] = symbol;
    value >>= 5n;
  }
  return symbols.join("");
}

/** A fresh typed id, e.g. `newTypedId("evt")` → `evt_0000…` (26 symbols). */
export function newTypedId(prefix: string, now?: number): string {
  return `${prefix}_${encodeTypeIdSuffix(uuidv7(now))}`;
}
