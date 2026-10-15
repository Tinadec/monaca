// Spike #3 (contract §9, §12 steps 4/4b): does the `@monaca/mcp` guard actually enforce the
// tool→scope map end-to-end on the real MCP Streamable HTTP surface of `@monaca/module-mcp-demo`?
//
//   bun scripts/spikes/mcp-guard.ts [--verbose]
//
// The whole real stack runs in-process — kernel + mcp-demo module + guard — with two test
// doubles standing in for what this machine does not have:
//
//  * a verifier that verifies locally minted ES256 tokens with `jose` (the real one is
//    `@monaca/core`'s native Verifier, a CI artifact);
//  * an audit sink that records in memory (the real one POSTs to `/internal/audit`).
//
// Exit 0 only when every check passed. The three headline scenarios are the contract's §12
// step 4 / 4b pair plus the unauthenticated case; the rest pin the surrounding behaviour.
import { SignJWT, exportJWK, generateKeyPair, jwtVerify, type JWTPayload } from "jose";
import { createKernel, createConfig, type EnvLike } from "@monaca/kernel";
import { mcpDemoModule, AUDIT_SINK_TOKEN } from "@monaca/module-mcp-demo";
import type { TokenVerifier, VerifiedToken } from "@monaca/mcp";

const BASE = "http://localhost:8080";
const MOUNT = "/mcp/demo";
const ISSUER = `${BASE}/t/demo`;
const AUDIENCE = `${BASE}${MOUNT}`;
const METADATA_URL = `${BASE}/.well-known/oauth-protected-resource${MOUNT}`;

const verbose = process.argv.includes("--verbose");

interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
  error?: string;
}

const results: CheckResult[] = [];

async function check<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const t0 = performance.now();
  try {
    const detail = await fn();
    const ms = Math.round(performance.now() - t0);
    results.push({ name, ok: true, ms, detail });
    console.log(`  ok    ${name} (${ms} ms)${detail === undefined || !verbose ? "" : `  ${JSON.stringify(detail)}`}`);
    return detail;
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    const error = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, ms, error });
    console.log(`  FAIL  ${name} (${ms} ms)  ${error}`);
    throw err;
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function codeError(code: string, cause?: unknown): Error {
  const error = new Error(`${code}${cause instanceof Error ? `: ${cause.message}` : ""}`, { cause });
  (error as Error & { code?: string }).code = code;
  return error;
}

// ---------------------------------------------------------------------------
// the token mint: a local ES256 key pair stands in for the tenant signing key
// ---------------------------------------------------------------------------

const { publicKey, privateKey } = await generateKeyPair("ES256");
const publicJwk = { ...(await exportJWK(publicKey)), alg: "ES256", use: "sig" };

interface MintOverrides {
  scope?: string[];
  iss?: string;
  aud?: string;
}

async function mintToken(overrides: MintOverrides = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    tid: "ten_00000000000000000000000001",
    org: "org_00000000000000000000000001",
    scope: overrides.scope ?? ["tools:read"],
    act: { sub: "agt_00000000000000000000000001" },
    grant_id: "grt_00000000000000000000000001",
  })
    .setProtectedHeader({ alg: "ES256", kid: "spike-k1", typ: "at+jwt" })
    .setSubject("acc_00000000000000000000000001")
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setJti(crypto.randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

/** Verifies signature and the claims the guard relies on; throws `MONACA_TOKEN_*` like the native one. */
const localVerifier: TokenVerifier = {
  async verifyAccessToken(token: string, expect): Promise<VerifiedToken> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, publicKey));
    } catch (cause) {
      throw codeError("MONACA_TOKEN_INVALID_SIGNATURE", cause);
    }
    if (payload.iss !== expect.issuer) throw codeError("MONACA_TOKEN_ISSUER_MISMATCH");
    if (payload.aud !== expect.audience) throw codeError("MONACA_TOKEN_AUDIENCE_MISMATCH");
    if (typeof payload.sub !== "string" || !Array.isArray(payload.scope)) throw codeError("MONACA_TOKEN_CLAIMS_INVALID");
    return {
      iss: String(payload.iss),
      sub: payload.sub,
      aud: String(payload.aud),
      tid: String(payload.tid ?? ""),
      org: String(payload.org ?? ""),
      scope: payload.scope as string[],
      ...(payload.act === undefined ? {} : { act: payload.act as VerifiedToken["act"] }),
      ...(payload.grant_id === undefined ? {} : { grantId: String(payload.grant_id) }),
      jti: String(payload.jti ?? ""),
      iat: Number(payload.iat ?? 0),
      exp: Number(payload.exp ?? 0),
    };
  },
};

// ---------------------------------------------------------------------------
// the stack: real kernel, real module, in-memory audit sink
// ---------------------------------------------------------------------------

interface AuditEntry {
  action: string;
  decision: string;
  tool: string;
  reason?: string;
  sub: string;
}

const auditLog: AuditEntry[] = [];
let auditShouldFail = false;

const auditSink = {
  record(entry: { action: string; decision: string; tool: string; reason?: string; token: VerifiedToken }): void {
    if (auditShouldFail) throw new Error("audit backend down (spike)");
    auditLog.push({
      action: entry.action,
      decision: entry.decision,
      tool: entry.tool,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      sub: entry.token.sub,
    });
  },
};

const config: EnvLike = {
  MONACA_PUBLIC_BASE_URL: BASE,
  MONACA_MCP_DEMO_TENANT: "demo",
  MONACA_MCP_DEMO_RESOURCE: AUDIENCE,
  MONACA_LOG_LEVEL: verbose ? "debug" : "error",
};

// The kernel builds its own root Hono app; the spike drives it directly (no port, no server).
const kernel = createKernel({
  config: createConfig(config),
  verifier: localVerifier,
  mountOverrides: { "mcp-demo": MOUNT },
});
kernel.registry.provide(AUDIT_SINK_TOKEN, auditSink);
kernel.register(mcpDemoModule);
await kernel.boot();
assert(kernel.state === "running", `kernel is ${kernel.state}`);

// ---------------------------------------------------------------------------
// request helpers — the transport requires both Accept types on POST
// ---------------------------------------------------------------------------

const POST_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function rpc(method: string, params?: unknown, authorization?: string): Request {
  return new Request(`${BASE}${MOUNT}`, {
    method: "POST",
    headers: { ...POST_HEADERS, ...(authorization === undefined ? {} : { authorization }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
}

interface JsonRpcResult {
  result?: { content?: { type: string; text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

async function callRpc(method: string, params: unknown | undefined, authorization: string): Promise<{ res: Response; body: JsonRpcResult }> {
  const res = await kernel.app.request(rpc(method, params, authorization));
  const body = (await res.json()) as JsonRpcResult;
  return { res, body };
}

// ---------------------------------------------------------------------------
// the checks
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log(`spike: @monaca/mcp guard + mcp-demo on ${process.platform}-${process.arch}, Bun ${Bun.version}`);

  const readToken = await mintToken();
  const writeToken = await mintToken({ scope: ["tools:read", "tools:write"] });

  // --- headline scenario 1: no token ------------------------------------------------
  await check("no token → 401 with the bare resource_metadata challenge", async () => {
    const { res, body } = await callRpc("tools/call", { name: "list_notes" }, "");
    assert(res.status === 401, `status ${res.status}`);
    assert(res.headers.get("www-authenticate") === `Bearer resource_metadata="${METADATA_URL}"`, "challenge mismatch");
    assert((body as unknown as { monaca_error_code?: string }).monaca_error_code === "MONACA_TOKEN_MISSING", "problem code");
    return { challenge: res.headers.get("www-authenticate") };
  });

  // --- headline scenario 2: tools:read token calls list_notes ------------------------
  await check("tools:read token → initialize + tools/call list_notes succeed", async () => {
    const init = await callRpc(
      "initialize",
      { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "spike", version: "0.1.0" } },
      `Bearer ${readToken}`,
    );
    assert(init.res.status === 200, `initialize status ${init.res.status}`);
    assert(init.body.result !== undefined, "initialize has no result");

    const list = await callRpc("tools/call", { name: "list_notes", arguments: {} }, `Bearer ${readToken}`);
    assert(list.res.status === 200, `tools/call status ${list.res.status}`);
    const text = list.body.result?.content?.[0]?.text ?? "";
    const notes = JSON.parse(text) as { notes: { id: string }[] };
    assert(notes.notes.some((n) => n.id === "note_welcome"), "seeded note missing from list_notes");
    return { notes: notes.notes.length };
  });

  // --- headline scenario 3: the same token is refused delete_note --------------------
  await check("tools:read-only token → tools/call delete_note → 403 insufficient_scope", async () => {
    const { res, body } = await callRpc("tools/call", { name: "delete_note", arguments: { id: "note_welcome" } }, `Bearer ${readToken}`);
    assert(res.status === 403, `status ${res.status}`);
    const challenge = res.headers.get("www-authenticate") ?? "";
    assert(challenge.includes('error="insufficient_scope"'), `challenge missing error: ${challenge}`);
    assert(challenge.includes('scope="tools:write"'), `challenge missing scope: ${challenge}`);
    assert(challenge.includes(`resource_metadata="${METADATA_URL}"`), `challenge missing metadata: ${challenge}`);
    assert((body as unknown as { monaca_error_code?: string }).monaca_error_code === "MONACA_INSUFFICIENT_SCOPE", "problem code");
    return { challenge };
  });

  // --- surrounding behaviour ---------------------------------------------------------

  await check("RFC 9728 metadata document is exact", async () => {
    const res = await kernel.app.request(new Request(`${BASE}/.well-known/oauth-protected-resource${MOUNT}`));
    assert(res.status === 200, `status ${res.status}`);
    const doc = (await res.json()) as Record<string, unknown>;
    assert(JSON.stringify(doc) === JSON.stringify({
      resource: AUDIENCE,
      authorization_servers: [ISSUER],
      scopes_supported: ["tools:read", "tools:write"],
      bearer_methods_supported: ["header"],
    }), `metadata mismatch: ${JSON.stringify(doc)}`);
    return doc;
  });

  await check("a token minted for another audience is rejected 401 invalid_token", async () => {
    const foreign = await mintToken({ aud: "http://evil.example/mcp/demo" });
    const { res } = await callRpc("tools/call", { name: "list_notes" }, `Bearer ${foreign}`);
    assert(res.status === 401, `status ${res.status}`);
    assert((res.headers.get("www-authenticate") ?? "").includes('error="invalid_token"'), "challenge missing error");
    return { status: res.status };
  });

  await check("a tool outside the fixed map is denied 403 unknown tool", async () => {
    const { res, body } = await callRpc("tools/call", { name: "admin_nuke" }, `Bearer ${readToken}`);
    assert(res.status === 403, `status ${res.status}`);
    assert((body as unknown as { monaca_error_code?: string }).monaca_error_code === "MONACA_TOOL_UNKNOWN", "problem code");
    return { status: res.status };
  });

  await check("tools:write token → delete_note executes and the note is really gone", async () => {
    const del = await callRpc("tools/call", { name: "delete_note", arguments: { id: "note_agents" } }, `Bearer ${writeToken}`);
    assert(del.res.status === 200, `status ${del.res.status}`);
    assert(del.body.result?.isError !== true, "delete reported a tool error");
    const list = await callRpc("tools/call", { name: "list_notes", arguments: {} }, `Bearer ${writeToken}`);
    const notes = JSON.parse(list.body.result?.content?.[0]?.text ?? "{}") as { notes: { id: string }[] };
    assert(!notes.notes.some((n) => n.id === "note_agents"), "note_agents still listed after delete");
    return { remaining: notes.notes.map((n) => n.id) };
  });

  await check("audit saw tool.invoked and tool.denied before the responses", async () => {
    const invoked = auditLog.filter((e) => e.action === "tool.invoked");
    const denied = auditLog.filter((e) => e.action === "tool.denied");
    assert(invoked.length >= 2, `expected ≥2 invoked records, got ${invoked.length}`);
    assert(denied.some((e) => e.tool === "delete_note" && e.reason === "insufficient_scope"), "no denied delete_note record");
    assert(invoked.every((e) => e.decision === "allow") && denied.every((e) => e.decision === "deny"), "decision mismatch");
    return { invoked: invoked.length, denied: denied.length };
  });

  await check("a failing audit sink fails the request closed (503), tool never runs", async () => {
    auditShouldFail = true;
    try {
      const { res, body } = await callRpc("tools/call", { name: "list_notes", arguments: {} }, `Bearer ${writeToken}`);
      assert(res.status === 503, `status ${res.status}`);
      assert((body as unknown as { monaca_error_code?: string }).monaca_error_code === "MONACA_AUDIT_UNAVAILABLE", "problem code");
    } finally {
      auditShouldFail = false;
    }
    return { status: 503 };
  });

  await kernel.stop().catch(() => undefined);

  const ok = results.every((r) => r.ok);
  console.log(
    JSON.stringify({
      spike: "mcp-guard",
      ok,
      platform: `${process.platform}-${process.arch}`,
      bun: Bun.version,
      mcp_sdk: "1.32.1",
      public_jwk: publicJwk,
      checks: results.length,
      results,
    }),
  );
  return ok ? 0 : 1;
}

process.exit(await main());
