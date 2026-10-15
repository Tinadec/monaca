import { describe, expect, test } from "bun:test";

import { encodeTypeIdSuffix, idPrefix, newId, typedId, uuidv7 } from "./typed-id";

describe("encodeTypeIdSuffix", () => {
  // The three vectors published in docs/contracts/m0.md §5.2. Both the Rust and the TS
  // implementation must reproduce them exactly.
  test("encodes the contract's test vectors", () => {
    expect(encodeTypeIdSuffix("00000000-0000-0000-0000-000000000000")).toBe("00000000000000000000000000");
    expect(encodeTypeIdSuffix("01890a5d-ac96-774b-bcce-b302099a8057")).toBe("01h455vb4pex5vsknk084sn02q");
    expect(encodeTypeIdSuffix("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe("7zzzzzzzzzzzzzzzzzzzzzzzzz");
  });

  test("always emits 26 symbols whose first is 0-7", () => {
    for (let i = 0; i < 200; i += 1) {
      const suffix = encodeTypeIdSuffix(uuidv7());
      expect(suffix).toHaveLength(26);
      expect(suffix).toMatch(/^[0-7][0-9abcdefghjkmnpqrstvwxyz]{25}$/);
    }
  });

  test("uses no i, l, o or u", () => {
    for (let i = 0; i < 200; i += 1) expect(encodeTypeIdSuffix(uuidv7())).not.toMatch(/[ilou]/);
  });

  test("rejects anything that is not a UUID", () => {
    expect(() => encodeTypeIdSuffix("not-a-uuid")).toThrow(/32-hex-digit/);
    expect(() => encodeTypeIdSuffix("01890a5d-ac96-774b-bcce-b302099a805")).toThrow();
  });
});

describe("typedId", () => {
  test("joins prefix and suffix with an underscore", () => {
    expect(typedId("acc", "01890a5d-ac96-774b-bcce-b302099a8057")).toBe("acc_01h455vb4pex5vsknk084sn02q");
  });

  test("round-trips its prefix through idPrefix", () => {
    expect(idPrefix(newId("grt"))).toBe("grt");
    expect(idPrefix("not-typed")).toBe(null);
  });
});

describe("uuidv7", () => {
  test("sets version 7 and the RFC 4122 variant", () => {
    for (let i = 0; i < 100; i += 1) {
      const uuid = uuidv7();
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  test("encodes the millisecond timestamp in the leading 48 bits", () => {
    // 2026-01-01T00:00:00.000Z = 1767225600000 ms = 0x019b_76da_a800
    const uuid = uuidv7(1767225600000);
    expect(uuid.startsWith("019b76da-a800-7")).toBe(true);
  });

  test("sorts lexicographically by time", () => {
    const early = uuidv7(1_000_000_000_000);
    const late = uuidv7(1_000_000_001_000);
    expect(early < late).toBe(true);
  });

  test("does not repeat across a burst", () => {
    const ids = new Set(Array.from({ length: 500 }, () => uuidv7()));
    expect(ids.size).toBe(500);
  });
});
