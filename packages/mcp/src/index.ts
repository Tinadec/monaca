/**
 * @monaca/mcp — the MCP resource-server guard (docs/contracts/m0.md §9, docs/architecture.md §6).
 *
 * Barrel over the four pure modules plus the Hono guard middleware:
 *
 *  - `bearer.ts`           RFC 6750 §2.1 token extraction from the Authorization header
 *  - `problem.ts`          RFC 9457 problem+json bodies with stable `MONACA_*` codes
 *  - `www-authenticate.ts` `WWW-Authenticate: Bearer ...` challenges in the contract's exact order
 *  - `types.ts`            the verifier / audit-sink / scope-map shapes (no native import)
 *  - `guard.ts`            the middleware that ties them together, fail-closed
 */
export { extractBearer, type BearerExtraction } from "./bearer.ts";
export { problemBody, problemResponse, problemSlug, type ProblemOptions } from "./problem.ts";
export type {
  ActorChain,
  GuardLogger,
  ToolAuditRecord,
  ToolAuditSink,
  ToolDenialReason,
  ToolScopeMap,
  TokenVerifier,
  VerifiedToken,
  VerifyExpectations,
} from "./types.ts";
export { buildWwwAuthenticate, type BearerError, type ChallengeOptions } from "./www-authenticate.ts";
export {
  findToolCalls,
  MCP_GUARD_KEY,
  resourceGuard,
  scopesCover,
  type McpGuardContext,
  type ResourceGuardOptions,
} from "./guard.ts";
