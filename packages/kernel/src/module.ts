import type { Hono } from "hono";
import type { Config } from "./config.ts";
import { KernelError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import type { Registry } from "./registry.ts";
import type { VerifierSlot } from "./verifier.ts";

export type ModuleApp = Hono;

/** What a module hook receives. One instance per module; `logger` is already tagged with its name. */
export interface ModuleContext {
  readonly module: { readonly name: string; readonly version: string };
  readonly config: Config;
  readonly logger: Logger;
  readonly registry: Registry;
  readonly verifier: VerifierSlot;
  /** Absolute path prefix `routes` is mounted under, e.g. `/mcp/demo`. */
  readonly mountPath: string;
}

/**
 * A SQL migration owned by a module. Applied by the Rust orchestrator in the next run
 * (docs/architecture.md §3); until then the kernel only validates and exposes them.
 * Modules may touch only `mod_<name>_*` tables (see {@link moduleTablePrefix}).
 */
export interface ModuleMigration {
  /** Strictly increasing within a module. */
  readonly version: number;
  readonly description: string;
  readonly sql: string;
}

export interface ModuleDefinition {
  /** Lowercase kebab-case, unique per kernel. */
  readonly name: string;
  /** Semver, informational. */
  readonly version: string;
  /** Names of modules that must be initialised and started before this one. */
  readonly dependsOn?: readonly string[];
  /** Where `routes` is mounted. Default: `/modules/<name>`. A kernel option can override it. */
  readonly mountPath?: string;
  /** Register routes on `app`, which is mounted at `ctx.mountPath`. Runs after every module's `init`. */
  routes?(app: ModuleApp, ctx: ModuleContext): void | Promise<void>;
  /**
   * Register routes at the origin root for protocol-mandated paths that cannot live under the
   * mount prefix, e.g. `/.well-known/oauth-protected-resource/...` (RFC 9728). The kernel rejects
   * any path outside `/.well-known/`, so a module cannot shadow `/v1`, `/t`, `/bff` or `/healthz`.
   */
  rootRoutes?(app: ModuleApp, ctx: ModuleContext): void | Promise<void>;
  /** Acquire resources and `provide` services. Runs in dependency order, before any `start`. */
  init?(ctx: ModuleContext): void | Promise<void>;
  /** Begin background work. Runs in dependency order, after every `init` and after routes are mounted. */
  start?(ctx: ModuleContext): void | Promise<void>;
  /**
   * Release resources. Runs in reverse dependency order for every module whose `init` completed,
   * so it must tolerate being called when `start` never ran.
   */
  stop?(ctx: ModuleContext): void | Promise<void>;
  readonly migrations?: readonly ModuleMigration[];
}

/** A validated, normalised module. Produced only by {@link defineModule}. */
export interface Module extends ModuleDefinition {
  readonly dependsOn: readonly string[];
}

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

/** `mcp-demo` -> `mod_mcp_demo_`, the only table-name prefix the module may write. */
export function moduleTablePrefix(name: string): string {
  return `mod_${name.replaceAll("-", "_")}_`;
}

/** Validates a mount path: absolute, no trailing slash, no dot segments, not the root. */
export function assertValidMountPath(moduleName: string, mountPath: string): void {
  const problem = mountPathProblem(mountPath);
  if (problem !== null) {
    throw new KernelError("MODULE_INVALID", `module "${moduleName}": mountPath "${mountPath}" ${problem}`);
  }
}

function mountPathProblem(mountPath: string): string | null {
  if (!mountPath.startsWith("/")) return "must start with /";
  if (mountPath === "/") return "must not be the root; use rootRoutes for root-level routes";
  if (mountPath.endsWith("/")) return "must not end with /";
  if (mountPath.includes("//")) return "must not contain empty segments";
  if (mountPath.split("/").some((segment) => segment === "." || segment === "..")) {
    return "must not contain dot segments";
  }
  if (!/^[A-Za-z0-9\-._~/]+$/.test(mountPath)) return "may contain only unreserved URL characters and /";
  return null;
}

/**
 * Validate a module definition and return the normalised, frozen module.
 * Everything checkable without a kernel is checked here, so a bad definition fails at import time
 * with the module's name in the message.
 */
export function defineModule(definition: ModuleDefinition): Module {
  const { name } = definition;
  const fail = (problem: string): never => {
    throw new KernelError("MODULE_INVALID", `module "${String(name)}": ${problem}`);
  };

  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    fail("name must match /^[a-z][a-z0-9-]{0,39}$/");
  }
  if (typeof definition.version !== "string" || !VERSION_PATTERN.test(definition.version)) {
    fail(`version "${String(definition.version)}" is not a semver string`);
  }

  const dependsOn = [...(definition.dependsOn ?? [])];
  const seen = new Set<string>();
  for (const dependency of dependsOn) {
    if (!NAME_PATTERN.test(dependency)) fail(`dependsOn entry "${dependency}" is not a valid module name`);
    if (dependency === name) fail("a module cannot depend on itself");
    if (seen.has(dependency)) fail(`dependsOn lists "${dependency}" twice`);
    seen.add(dependency);
  }

  if (definition.mountPath !== undefined) assertValidMountPath(name, definition.mountPath);

  let previous = 0;
  for (const migration of definition.migrations ?? []) {
    if (!Number.isInteger(migration.version) || migration.version <= previous) {
      fail(`migration versions must be strictly increasing integers (got ${migration.version} after ${previous})`);
    }
    if (migration.description.trim() === "" || migration.sql.trim() === "") {
      fail(`migration ${migration.version} needs a description and SQL`);
    }
    previous = migration.version;
  }

  return Object.freeze({ ...definition, dependsOn: Object.freeze(dependsOn) });
}
