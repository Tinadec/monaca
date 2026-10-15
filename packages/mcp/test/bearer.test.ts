import { describe, expect, test } from "bun:test";
import { extractBearer } from "../src/bearer.ts";

describe("extractBearer (RFC 6750 §2.1)", () => {
  test("absent header is unauthenticated, not an error", () => {
    expect(extractBearer(null)).toEqual({ kind: "none" });
    expect(extractBearer(undefined)).toEqual({ kind: "none" });
  });

  test("other schemes are ignored; a bare bearer scheme with no credentials is malformed", () => {
    expect(extractBearer("Basic dXNlcjpwYXNz")).toEqual({ kind: "none" });
    expect(extractBearer("bearer")).toEqual({ kind: "malformed" });
  });

  test("scheme match is case-insensitive and tolerant of padding spaces", () => {
    expect(extractBearer("bEaReR  abc.def")).toEqual({ kind: "token", token: "abc.def" });
  });

  test("a JWT-shaped token is extracted", () => {
    const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhY2NfMSJ9.c2ln";
    expect(extractBearer(`Bearer ${jwt}`)).toEqual({ kind: "token", token: jwt });
  });

  test("an empty or non-token credentials part is malformed", () => {
    expect(extractBearer("Bearer")).toEqual({ kind: "malformed" });
    expect(extractBearer("Bearer   ")).toEqual({ kind: "malformed" });
    expect(extractBearer("Bearer two tokens")).toEqual({ kind: "malformed" });
    expect(extractBearer('Bearer "quoted"')).toEqual({ kind: "malformed" });
  });
});
