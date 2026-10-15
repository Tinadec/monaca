import { ModuleGraphError } from "./errors.ts";
import type { Module } from "./module.ts";

/**
 * Order modules so every module comes after the modules it `dependsOn`. Among modules that are
 * ready at the same time, registration order wins, so the result is deterministic.
 *
 * Throws {@link ModuleGraphError} naming the modules involved for a duplicate name, a dependency
 * that is not registered (all of them are reported at once), or a cycle (the cycle path is shown).
 */
export function orderModules(modules: readonly Module[]): Module[] {
  const byName = new Map<string, Module>();
  const index = new Map<string, number>();
  for (const [position, module] of modules.entries()) {
    if (byName.has(module.name)) {
      throw new ModuleGraphError(
        "duplicate",
        [module.name],
        `module "${module.name}" is registered more than once`,
      );
    }
    byName.set(module.name, module);
    index.set(module.name, position);
  }

  const missing: string[] = [];
  const involved: string[] = [];
  for (const module of modules) {
    for (const dependency of module.dependsOn) {
      if (!byName.has(dependency)) {
        missing.push(`module "${module.name}" depends on "${dependency}", which is not registered`);
        involved.push(module.name, dependency);
      }
    }
  }
  if (missing.length > 0) {
    throw new ModuleGraphError("missing-dependency", [...new Set(involved)], missing.join("; "));
  }

  const remaining = new Map<string, Set<string>>();
  for (const module of modules) remaining.set(module.name, new Set(module.dependsOn));

  const ordered: Module[] = [];
  while (remaining.size > 0) {
    let next: string | undefined;
    for (const [name, pending] of remaining) {
      if (pending.size > 0) continue;
      if (next === undefined || (index.get(name) ?? 0) < (index.get(next) ?? 0)) next = name;
    }
    if (next === undefined) {
      const cycle = findCycle(remaining);
      throw new ModuleGraphError(
        "cycle",
        cycle,
        `module dependency cycle: ${cycle.map((name) => `"${name}"`).join(" -> ")}`,
      );
    }
    remaining.delete(next);
    for (const pending of remaining.values()) pending.delete(next);
    ordered.push(byName.get(next) as Module);
  }
  return ordered;
}

/** Walk `depends on` edges among the unresolved modules until a node repeats; returns a -> ... -> a. */
function findCycle(remaining: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const start = remaining.keys().next().value as string;
  const path: string[] = [];
  const position = new Map<string, number>();
  let current = start;
  for (;;) {
    const seenAt = position.get(current);
    if (seenAt !== undefined) return [...path.slice(seenAt), current];
    position.set(current, path.length);
    path.push(current);
    // Every unresolved module has at least one unresolved dependency, or it would have been ordered.
    current = remaining.get(current)?.values().next().value as string;
  }
}
