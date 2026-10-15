import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { MCP_GUARD_KEY, resourceGuard, type McpGuardContext } from "../src/guard.ts";
import type { ToolAuditRecord, TokenVerifier, VerifiedToken, VerifyExpectations } from "../src/types.ts";

const META = "http://localhost:8080/.well-known/oauth-protected-resource/mcp/demo";
const SCOPE_MAP = { list_notes: ["tools:read"], delete_note: ["tools:write"] } as const;

const TOKEN: VerifiedToken = {
  iss: "http://localhost:8080/t/demo",
  sub: "acc_00000000000000000000000001",
  aud: "http://localhost:8080/mcp/demo",
  tid: "ten_00000000000000000000000001",
  org: "org_00000000000000000000000001",
  scope: ["tools:read"],
  act: { sub: "agt_00000000000000000000000001" },
  grantId: "grt_00000000000000000000000001",
  jti: "01920000-0000-7000-8000-000000000001",
  iat: 1767225600,
  exp: 1767225900,
};

/** A verifier that hands out `token` — or throws `error` — for every call. */
function stubVerifier(token: VerifiedToken | Error): TokenVerifier {
  return {
    verifyAccessToken(_token: string, expect: VerifyExpectations): VerifiedToken {
      if (token instanceof Error) throw token;
      if (expect.issuer !== "http://localhost:8080/t/demo") throw new Error("issuer mismatch in test");
      if (expect.audience !== "http://localhost:8080/mcp/demo") throw new Error("audience mismatch in test");
      return token;
    },
  };
}

function codeError(code: string): Error {
  const error = new Error(`${code}: stub`);
  (error as Error & { code?: string }).code = code;
  return error;
}

interface Harness {
  app: Hono;
  records: ToolAuditRecord[];
  handled: () => number;
}

function harness(options: {
  verifier?: TokenVerifier;
  audit?: (entry: ToolAuditRecord) => void;
} = {}): Harness {
  const records: ToolAuditRecord[] = [];
  let handled = 0;
  const app = new Hono();
  app.use(
    "/mcp/demo",
    resourceGuard({
      verifier: options.verifier ?? stubVerifier(TOKEN),
      scopeMap: SCOPE_MAP,
      resourceMetadataUrl: META,
      expect: { issuer: "http://localhost:8080/t/demo", audience: "http://localhost:8080/mcp/demo" },
      auditSink: { record: (entry) => (options.audit ?? ((e) => records.push(e)))(entry) },
    }),
  );
  app.all("/mcp/demo", (c) => {
    handled += 1;
    return c.json({ ok: true, mcp: c.get(MCP_GUARD_KEY) satisfies McpGuardContext });
  });
  return { app, records, handled: () => handled };
}

const rpc = (method: string, name?: string, authorization = "Bearer t") =>
  new Request("http://test/mcp/demo", {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization === "" ? {} : { authorization }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(name === undefined ? {} : { params: { name } }) }),
  });

describe("resourceGuard: authentication (contract §9)", () => {
  test("no token → 401 with the bare challenge", async () => {
    const res = await harness().app.request(rpc("tools/call", "list_notes", ""));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${META}"`);
    expect((await res.json() as { monaca_error_code: string }).monaca_error_code).toBe("MONACA_TOKEN_MISSING");
  });

  test("malformed token → 401 with error=invalid_token", async () => {
    const res = await harness().app.request(
      new Request("http://test/mcp/demo", {
        method: "POST",
        headers: { authorization: "Bearer two tokens" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer error="invalid_token", resource_metadata="${META}"`);
    expect((await res.json() as { monaca_error_code: string }).monaca_error_code).toBe("MONACA_TOKEN_MALFORMED");
  });

  test("rejected token → 401 carrying the verifier's code", async () => {
    const res = await harness({ verifier: stubVerifier(codeError("MONACA_TOKEN_EXPIRED")) }).app.request(
      rpc("tools/call", "list_notes"),
    );
    expect(res.status).toBe(401);
    expect((await res.json() as { monaca_error_code: string }).monaca_error_code).toBe("MONACA_TOKEN_EXPIRED");
  });

  test("verifier unavailable → 503 fail-closed, never 401", async () => {
    const res = await harness({ verifier: stubVerifier(codeError("MONACA_VERIFIER_UNAVAILABLE")) }).app.request(
      rpc("tools/call", "list_notes"),
    );
    expect(res.status).toBe(503);
    expect((await res.json() as { monaca_error_code: string }).monaca_error_code).toBe("MONACA_VERIFIER_UNAVAILABLE");
  });
});

describe("resourceGuard: scope enforcement (contract §9)", () => {
  test("list_notes with tools:read is allowed and audited as tool.invoked", async () => {
    const h = harness();
    const res = await h.app.request(rpc("tools/call", "list_notes"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; mcp: McpGuardContext };
    expect(body.ok).toBe(true);
    expect(body.mcp.token.sub).toBe(TOKEN.sub);
    expect(h.handled()).toBe(1);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ action: "tool.invoked", decision: "allow", tool: "list_notes" });
  });

  test("delete_note with only tools:read → 403 with the exact challenge and body", async () => {
    const h = harness();
    const res = await h.app.request(rpc("tools/call", "delete_note"));
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", scope="tools:write", resource_metadata="${META}"`,
    );
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect((await res.json() as { monaca_error_code: string }).monaca_error_code).toBe("MONACA_INSUFFICIENT_SCOPE");
    expect(h.handled()).toBe(0);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ action: "tool.denied", decision: "deny", reason: "insufficient_scope" });
  });

  test("a tool outside the fixed map is denied as unknown_tool", async () => {
    const h = harness();
    const res = await h.app.request(rpc("tools/call", "admin_nuke"));
    expect(res.status).toBe(403);
    expect((await res.json() as { monaca_error_code: string }).monaca_error_code).toBe("MONACA_TOOL_UNKNOWN");
    expect(h.records[0]).toMatchObject({ action: "tool.denied", reason: "unknown_tool" });
  });

  test("a batch with one allowed and one denied call is denied whole, with no false invoked record", async () => {
    const h = harness();
    const res = await h.app.request(
      new Request("http://test/mcp/demo", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_notes" } },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_note" } },
        ]),
      }),
    );
    expect(res.status).toBe(403);
    expect(h.handled()).toBe(0);
    // Only the refused call is audited: the allowed one never ran, so it has no invoked record.
    expect(h.records.map((r) => r.action)).toEqual(["tool.denied"]);
    expect(h.records[0]).toMatchObject({ tool: "delete_note", reason: "insufficient_scope" });
  });

  test("non-tools/call requests are authenticated but not audited", async () => {
    const h = harness();
    const res = await h.app.request(rpc("tools/list"));
    expect(res.status).toBe(200);
    expect(h.records).toHaveLength(0);
  });

  test("a GET without a body still requires a token", async () => {
    const h = harness();
    const res = await h.app.request(new Request("http://test/mcp/demo", { method: "GET" }));
    expect(res.status).toBe(401);
    const ok = await h.app.request(
      new Request("http://test/mcp/demo", { method: "GET", headers: { authorization: "Bearer t" } }),
    );
    expect(ok.status).toBe(200);
  });
});

describe("resourceGuard: audit fail-closed", () => {
  test("a throwing sink fails the request 503 and the handler never runs", async () => {
    const h = harness({
      audit: () => {
        throw new Error("audit backend down");
      },
    });
    const res = await h.app.request(rpc("tools/call", "list_notes"));
    expect(res.status).toBe(503);
    expect((await res.json() as { monaca_error_code: string }).monaca_error_code).toBe("MONACA_AUDIT_UNAVAILABLE");
    expect(h.handled()).toBe(0);
  });

  test("a throwing sink also fails the deny path 503", async () => {
    const h = harness({
      audit: () => {
        throw new Error("audit backend down");
      },
    });
    const res = await h.app.request(rpc("tools/call", "delete_note"));
    expect(res.status).toBe(503);
    expect(h.handled()).toBe(0);
  });
});
