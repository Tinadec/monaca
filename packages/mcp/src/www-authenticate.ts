export type BearerError = "invalid_token" | "insufficient_scope";

export interface ChallengeOptions {
  /** RFC 9728 metadata URL; always sent so clients can discover the authorization server. */
  resourceMetadataUrl: string;
  error?: BearerError;
  /** Space-delimited scopes needed (RFC 6750 §3); sent with `insufficient_scope`. */
  scope?: readonly string[];
}

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Build a `WWW-Authenticate: Bearer ...` value in the exact order docs/contracts/m0.md §9 shows:
 * `error`, `scope`, then `resource_metadata`.
 *
 *   Bearer resource_metadata="…"
 *   Bearer error="invalid_token", resource_metadata="…"
 *   Bearer error="insufficient_scope", scope="tools:write", resource_metadata="…"
 */
export function buildWwwAuthenticate(options: ChallengeOptions): string {
  const params: string[] = [];
  if (options.error !== undefined) params.push(`error=${quote(options.error)}`);
  if (options.scope !== undefined && options.scope.length > 0) params.push(`scope=${quote(options.scope.join(" "))}`);
  params.push(`resource_metadata=${quote(options.resourceMetadataUrl)}`);
  return `Bearer ${params.join(", ")}`;
}
