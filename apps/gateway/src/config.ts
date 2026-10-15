/**
 * Gateway configuration — every `MONACA_*` variable the gateway reads, resolved once with the
 * contract's dev defaults (docs/contracts/m0.md §2.2) through the kernel's `Config` (an empty
 * string counts as unset, error messages name the variable but never echo its value).
 *
 * The gateway is the single public origin in dev (§2.1): browser-facing values come from
 * `MONACA_PUBLIC_BASE_URL`, and `MONACA_SERVER_URL` is used only for server-to-server hops
 * (token exchange, JWKS sync, `/internal/*`).
 */
import { createConfig, type Config, type EnvLike } from "@monaca/kernel";

export type GatewayEnv = "dev" | "ci" | "prod";

export interface GatewayConfig {
  readonly raw: Config;
  readonly env: GatewayEnv;
  readonly hostname: string;
  readonly port: number;
  /** Server-to-server hops only: the Rust server's direct address. */
  readonly serverUrl: string;
  /** The single public origin; source of every `iss` and every browser-visible URL. */
  readonly publicBaseUrl: string;
  readonly consoleUrl: string;
  readonly authUiUrl: string;
  readonly tenant: string;
  readonly consoleClientId: string;
  readonly consoleClientSecret: string;
  /** The BFF's own callback on the public origin (registered per §5.7). */
  readonly consoleRedirectUri: string;
  /** The console client's registered scope set (§5.7). */
  readonly consoleScopes: string;
  readonly sessionCookieName: string;
  readonly sessionTtlSecs: number;
  readonly sessionSecureCookie: boolean;
  readonly internalSecret: string;
  readonly devProxy: boolean;
  readonly jwksRefreshSecs: number;
  readonly clockSkewSecs: number;
  readonly mcpDemoMount: string;
  readonly mcpDemoResource: string;
  readonly mcpDemoTenant: string;
  /** Org slug the demo resource server's audit events are written under (§9 audit sink). */
  readonly mcpDemoOrg: string;
  /** Org slug the console BFF looks the signed-in user up in (§6.2 has no "my orgs" endpoint). */
  readonly bffDefaultOrg: string;
}

/** The console client's registered scopes (§5.7 bootstrap table). */
export const CONSOLE_SCOPES = "openid profile email offline_access monaca:admin";

function parseAddr(raw: string | undefined, fallbackHost: string, fallbackPort: number): { hostname: string; port: number } {
  const value = raw ?? `${fallbackHost}:${fallbackPort}`;
  const separator = value.lastIndexOf(":");
  if (separator === -1) return { hostname: value, port: fallbackPort };
  const hostname = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  // Port 0 is allowed: it means "ephemeral", which is how tests bind a scratch server.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`MONACA_GATEWAY_ADDR: "${value}" does not end in a valid port`);
  }
  return { hostname: hostname === "" ? fallbackHost : hostname, port };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveGatewayConfig(env: EnvLike): GatewayConfig {
  const raw = createConfig(env);
  const gatewayEnv = raw.getOr("MONACA_ENV", "dev");
  if (gatewayEnv !== "dev" && gatewayEnv !== "ci" && gatewayEnv !== "prod") {
    throw new Error(`MONACA_ENV: must be dev, ci or prod (got "${gatewayEnv}")`);
  }

  const { hostname, port } = parseAddr(raw.get("MONACA_GATEWAY_ADDR"), "127.0.0.1", 8080);
  const publicBaseUrl = stripTrailingSlash(raw.getOr("MONACA_PUBLIC_BASE_URL", "http://localhost:8080"));
  const serverUrl = stripTrailingSlash(raw.getOr("MONACA_SERVER_URL", "http://127.0.0.1:8081"));
  const mcpDemoMount = raw.getOr("MONACA_MCP_DEMO_MOUNT", "/mcp/demo");

  // `__Host-` cookies require Secure + Path=/ and no Domain, so they are a production-only
  // shape; on plain http://localhost the plain name from the env table is used (§9).
  const sessionCookieName =
    gatewayEnv === "prod" ? "__Host-monaca_session" : raw.getOr("MONACA_SESSION_COOKIE_NAME", "monaca_session");

  return {
    raw,
    env: gatewayEnv,
    hostname,
    port,
    serverUrl,
    publicBaseUrl,
    consoleUrl: stripTrailingSlash(raw.getOr("MONACA_CONSOLE_URL", "http://localhost:5173")),
    authUiUrl: stripTrailingSlash(raw.getOr("MONACA_AUTH_UI_URL", "http://localhost:5174")),
    tenant: raw.getOr("MONACA_CONSOLE_TENANT", "demo"),
    consoleClientId: raw.getOr("MONACA_CONSOLE_CLIENT_ID", "monaca-console"),
    consoleClientSecret: raw.get("MONACA_CONSOLE_CLIENT_SECRET") ?? "",
    consoleRedirectUri: raw.getOr("MONACA_CONSOLE_REDIRECT_URI", `${publicBaseUrl}/bff/callback`),
    consoleScopes: CONSOLE_SCOPES,
    sessionCookieName,
    sessionTtlSecs: raw.int("MONACA_SESSION_TTL_SECS", 28_800),
    sessionSecureCookie: gatewayEnv === "prod",
    internalSecret: raw.get("MONACA_INTERNAL_SECRET") ?? "",
    devProxy: raw.bool("MONACA_DEV_PROXY", false),
    jwksRefreshSecs: raw.int("MONACA_JWKS_REFRESH_SECS", 300),
    clockSkewSecs: raw.int("MONACA_CLOCK_SKEW_SECS", 60),
    mcpDemoMount,
    mcpDemoResource: raw.getOr("MONACA_MCP_DEMO_RESOURCE", `${publicBaseUrl}${mcpDemoMount}`),
    mcpDemoTenant: raw.getOr("MONACA_MCP_DEMO_TENANT", "demo"),
    mcpDemoOrg: raw.getOr("MONACA_MCP_DEMO_ORG", "acme"),
    bffDefaultOrg: raw.getOr("MONACA_BFF_DEFAULT_ORG", "acme"),
  };
}
