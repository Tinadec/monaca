import { describe, expect, test } from "bun:test";
import { problemBody, problemResponse, problemSlug } from "../src/problem.ts";

describe("problem+json (RFC 9457, contract §6.1)", () => {
  test("slug strips the MONACA_ prefix and lowercases", () => {
    expect(problemSlug("MONACA_INSUFFICIENT_SCOPE")).toBe("insufficient_scope");
  });

  test("body carries type, title, status and monaca_error_code", () => {
    expect(problemBody({ code: "MONACA_INSUFFICIENT_SCOPE", status: 403 })).toEqual({
      type: "https://monaca.dev/errors/insufficient_scope",
      title: "Insufficient scope",
      status: 403,
      monaca_error_code: "MONACA_INSUFFICIENT_SCOPE",
    });
  });

  test("detail and instance appear only when supplied", () => {
    expect(problemBody({ code: "MONACA_TOKEN_MISSING", status: 401, detail: "d", instance: "/mcp/demo" })).toEqual({
      type: "https://monaca.dev/errors/token_missing",
      title: "Token missing",
      status: 401,
      detail: "d",
      instance: "/mcp/demo",
      monaca_error_code: "MONACA_TOKEN_MISSING",
    });
  });

  test("response is problem+json with no-store and custom headers", async () => {
    const res = problemResponse({
      code: "MONACA_INSUFFICIENT_SCOPE",
      status: 403,
      headers: { "www-authenticate": 'Bearer error="insufficient_scope"' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("www-authenticate")).toBe('Bearer error="insufficient_scope"');
    const body = (await res.json()) as { monaca_error_code: string };
    expect(body.monaca_error_code).toBe("MONACA_INSUFFICIENT_SCOPE");
  });
});
