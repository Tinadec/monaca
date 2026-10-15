import { describe, expect, test } from "bun:test";

import { GENESIS_HASH, canonicalize, chainHash, fromHex, toHex } from "./jcs";

describe("canonicalize — RFC 8785 §3.2.3 sorting", () => {
  test("sorts member names by UTF-16 code unit, not by collation", () => {
    // The example from RFC 8785 Appendix A. Plain alphabetical or locale ordering would put "€"
    // before "ö" or the control character last; code-unit order does neither.
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "\u{1f600}": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis",' +
        '"€":"Euro Sign","\u{1f600}":"Emoji: Grinning Face"}',
    );
  });

  test("sorts nested objects too", () => {
    expect(canonicalize({ b: { z: 1, a: 2 }, a: 0 })).toBe('{"a":0,"b":{"a":2,"z":1}}');
  });
});

describe("canonicalize — literals", () => {
  test("emits RFC 8785 Appendix A number forms", () => {
    expect(canonicalize(1e21)).toBe("1e+21");
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(5e-324)).toBe("5e-324");
    expect(canonicalize(1.5)).toBe("1.5");
    expect(canonicalize(0.000001)).toBe("0.000001");
    expect(canonicalize(1e-7)).toBe("1e-7");
  });

  test("maps non-finite numbers to null, as JSON does", () => {
    expect(canonicalize(Number.NaN)).toBe("null");
    expect(canonicalize(Number.POSITIVE_INFINITY)).toBe("null");
  });

  test("drops undefined members and normalizes array holes", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalize([1, undefined, 3])).toBe("[1,null,3]");
  });

  test("escapes strings to their shortest JSON form", () => {
    // RFC 8785 §3.2.2.2: only the short escapes; other control characters as \u00xx, lowercase.
    expect(canonicalize("\u000f")).toBe('"\\u000f"');
    expect(canonicalize("\b\f\n\r\t")).toBe('"\\b\\f\\n\\r\\t"');
    expect(canonicalize("\u007f")).toBe('"\u007f"');
    // A quote and a backslash: the two characters JSON must escape that are not control codes.
    expect(canonicalize(String.fromCharCode(0x22, 0x5c))).toBe('"\\"\\\\"');
  });

  test("has no whitespace anywhere", () => {
    expect(canonicalize({ a: [1, { b: "c" }], d: true, e: null })).toBe(
      '{"a":[1,{"b":"c"}],"d":true,"e":null}',
    );
  });
});

describe("chainHash — contract §8.2", () => {
  const event = {
    id: "evt_00000000000000000000000000",
    at: "2026-01-01T00:00:00.000Z",
    action: "agent.token.issued",
    payload: { aud: "http://localhost:8080/mcp/demo", scope: ["tools:read"] },
  };

  test("hashes the raw 32 prev bytes, not the 64-char hex text", async () => {
    const hex = await chainHash(GENESIS_HASH, event);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);

    // Byte-exact control: sha256(32 zero bytes || jcs(event)).
    const independent = toHex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new Uint8Array([...new Uint8Array(32), ...new TextEncoder().encode(canonicalize(event))]),
        ),
      ),
    );
    expect(hex).toBe(independent);

    // And the wrong-but-plausible reading — concatenating the hex *text* — must differ.
    const asText = toHex(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(GENESIS_HASH + canonicalize(event))),
      ),
    );
    expect(hex).not.toBe(asText);
  });

  test("is deterministic regardless of member insertion order", async () => {
    const shuffled = { payload: event.payload, action: event.action, at: event.at, id: event.id };
    expect(await chainHash(GENESIS_HASH, shuffled)).toBe(await chainHash(GENESIS_HASH, event));
  });

  test("changes when the previous hash changes", async () => {
    expect(await chainHash(GENESIS_HASH, event)).not.toBe(await chainHash("f".repeat(64), event));
  });

  test("rejects a prev hash that is not 32 bytes", async () => {
    await expect(chainHash("00", event)).rejects.toThrow(/32 bytes/);
  });

  test("links: each digest consumes the previous one", async () => {
    const first = await chainHash(GENESIS_HASH, { ...event, action: "grant.created" });
    const second = await chainHash(first, event);
    expect(await chainHash(GENESIS_HASH, { ...event, action: "grant.created" })).toBe(first);
    expect(await chainHash(first, event)).toBe(second);
  });
});

describe("hex helpers", () => {
  test("round-trip", () => {
    expect(toHex(fromHex("00ff10"))).toBe("00ff10");
  });

  test("reject malformed input", () => {
    expect(() => fromHex("abc")).toThrow(/not hex/);
    expect(() => fromHex("zz")).toThrow(/not hex/);
  });
});
