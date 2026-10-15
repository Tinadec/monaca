export type ScopeState = "granted" | "required" | "dropped" | "denied";

/** Partition `scopes` in-place-free: returns unique, sorted-ish groups for display. */
export function partitionScopes(candidate: readonly string[], parent: readonly string[]): {
  retained: string[];
  added: string[];
} {
  const parentSet = new Set(parent);
  const retained: string[] = [];
  const added: string[] = [];
  for (const scope of dedupe(candidate)) (parentSet.has(scope) ? retained : added).push(scope);
  return { retained, added };
}

export function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** True when every child scope is also a parent scope — the attenuation invariant. */
export function narrowsOnly(child: readonly string[], parent: readonly string[]): boolean {
  const parentSet = new Set(parent);
  return child.every((scope) => parentSet.has(scope));
}
