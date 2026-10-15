/**
 * The demo MCP resource server, mounted at `/mcp/demo` (contract §9, architecture §6).
 *
 * Built on the official `@modelcontextprotocol/sdk` (1.32.1) Streamable HTTP transport — the
 * `WebStandardStreamableHTTPServerTransport` variant, which is the one meant for Bun (the Node
 * `StreamableHTTPServerTransport` is a compatibility wrapper around it). Transport choice:
 * **stateless** (`sessionIdGenerator: undefined`, a fresh server+transport per request, which is
 * the SDK's documented stateless pattern) and **JSON responses** (`enableJsonResponse: true`, a
 * spec-legal alternative to SSE) — deterministic to test and no per-session stream lifecycle to
 * leak behind the gateway.
 *
 * Authorization is not this module's job: every request first passes the `@monaca/mcp` guard
 * (bearer → verification → per-tool scope → audit-before-response). The guard hands the verified
 * token to the route handler through the Hono context; the tool handlers only ever run for an
 * allowed call.
 *
 * M0 keeps the notes in module memory: one demo org, no `mod_mcp_demo_*` tables, no DB handle.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createToken, defineModule, type Module, type ModuleContext } from "@monaca/kernel";
import { MCP_GUARD_KEY, resourceGuard, type ToolAuditSink } from "@monaca/mcp";
import { type Context } from "hono";
import { z } from "zod";

/**
 * The audit sink the module writes every `tools/call` through (contract §9: before the response).
 * The gateway provides it over the kernel registry — it is the side that knows
 * `MONACA_SERVER_URL` and `MONACA_INTERNAL_SECRET`. Resolving a missing sink fails the boot:
 * an unaudited tool call must never be possible (fail closed by construction).
 */
export const AUDIT_SINK_TOKEN = createToken<ToolAuditSink>("mcp-demo:audit-sink");

/** The fixed M0 tool → scope map (contract §9). An empty list would mean "any authenticated caller". */
export const DEMO_TOOL_SCOPES = {
  list_notes: ["tools:read"],
  delete_note: ["tools:write"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export const MCP_DEMO_MODULE_NAME = "mcp-demo";
const MODULE_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// compile-time proof that the kernel's and @monaca/mcp's VerifiedToken copies
// stay assignable both ways (contract §4.2; packages/mcp/src/types.ts header).
// ---------------------------------------------------------------------------
import type { VerifiedToken as KernelVerifiedToken } from "@monaca/kernel";
import type { VerifiedToken as McpVerifiedToken } from "@monaca/mcp";

type AssertAssignable<From, To> = From extends To ? (To extends From ? true : never) : never;
export type VerifiedTokenCopiesMatch = [
  AssertAssignable<McpVerifiedToken, KernelVerifiedToken>,
  AssertAssignable<KernelVerifiedToken, McpVerifiedToken>,
];

// ---------------------------------------------------------------------------
// the in-memory note store (M0: one demo org, module-local)
// ---------------------------------------------------------------------------

interface Note {
  readonly id: string;
  title: string;
}

const notes = new Map<string, Note>([
  ["note_welcome", { id: "note_welcome", title: "Welcome to Monaca" }],
  ["note_agents", { id: "note_agents", title: "Agents get delegated tokens" }],
]);

/** Test seam: restore the seeded store. */
export function resetDemoNotes(): void {
  notes.clear();
  notes.set("note_welcome", { id: "note_welcome", title: "Welcome to Monaca" });
  notes.set("note_agents", { id: "note_agents", title: "Agents get delegated tokens" });
}

// ---------------------------------------------------------------------------
// config derivation
// ---------------------------------------------------------------------------

interface DemoConfig {
  readonly mountPath: string;
  readonly issuer: string;
  readonly audience: string;
  readonly resourceMetadataUrl: string;
}

function demoConfig(ctx: ModuleContext): DemoConfig {
  const publicBaseUrl = ctx.config.getOr("MONACA_PUBLIC_BASE_URL", "http://localhost:8080").replace(/\/+$/, "");
  const tenant = ctx.config.getOr("MONACA_MCP_DEMO_TENANT", "demo");
  const audience = ctx.config.getOr("MONACA_MCP_DEMO_RESOURCE", `${publicBaseUrl}${ctx.mountPath}`);
  return {
    mountPath: ctx.mountPath,
    issuer: `${publicBaseUrl}/t/${tenant}`,
    audience,
    // RFC 9728: the metadata document lives at this well-known path for the resource.
    resourceMetadataUrl: `${publicBaseUrl}/.well-known/oauth-protected-resource${ctx.mountPath}`,
  };
}

// ---------------------------------------------------------------------------
// the module
// ---------------------------------------------------------------------------

/**
 * A fresh MCP server per request (stateless pattern). Tool handlers are trivial; the guard has
 * already authenticated, scope-checked and audited the call by the time they run.
 */
async function handleMcpRequest(c: Context): Promise<Response> {
  const guardContext = c.get(MCP_GUARD_KEY);
  const server = new McpServer({ name: "monaca-mcp-demo", version: MODULE_VERSION });

  server.registerTool("list_notes", { title: "List notes", description: "List the demo notes." }, async () => ({
    content: [{ type: "text", text: JSON.stringify({ notes: [...notes.values()] }) }],
  }));

  server.registerTool(
    "delete_note",
    {
      title: "Delete note",
      description: "Delete one demo note by id.",
      inputSchema: z.object({ id: z.string().describe("The note id to delete.") }),
    },
    async ({ id }) => {
      const existed = notes.delete(id);
      if (!existed) return { content: [{ type: "text", text: `no such note: ${id}` }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify({ deleted: id }) }] };
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const parsedBody: unknown = guardContext.body;
  return transport.handleRequest(c.req.raw, parsedBody === undefined ? undefined : { parsedBody });
}

export const mcpDemoModule: Module = defineModule({
  name: MCP_DEMO_MODULE_NAME,
  version: MODULE_VERSION,
  // No mountPath here: the gateway passes it through kernel `mountOverrides`
  // (MONACA_MCP_DEMO_MOUNT, default `/mcp/demo`), which is the documented override point.

  routes(app, ctx): void {
    const config = demoConfig(ctx);
    const auditSink = ctx.registry.resolve(AUDIT_SINK_TOKEN);

    app.use(
      "*",
      resourceGuard({
        verifier: ctx.verifier,
        scopeMap: DEMO_TOOL_SCOPES,
        resourceMetadataUrl: config.resourceMetadataUrl,
        expect: { issuer: config.issuer, audience: config.audience },
        auditSink,
        logger: ctx.logger,
      }),
    );
    app.all("*", handleMcpRequest);
  },

  rootRoutes(app, ctx): void {
    // RFC 9728 Protected Resource Metadata — the only root path a module may claim
    // (the kernel rejects anything outside /.well-known/).
    const config = demoConfig(ctx);
    app.get(`/.well-known/oauth-protected-resource${ctx.mountPath}`, (c) =>
      c.json({
        resource: config.audience,
        authorization_servers: [config.issuer],
        scopes_supported: ["tools:read", "tools:write"],
        bearer_methods_supported: ["header"],
      }),
    );
  },
});
