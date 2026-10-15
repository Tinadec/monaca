import { Hono } from "hono";
import { Config, createConfig, type EnvLike } from "./config.ts";
import {
  KernelError,
  KernelStopError,
  ModuleGraphError,
  ModuleLifecycleError,
  type LifecyclePhase,
  type ModuleFailure,
} from "./errors.ts";
import { orderModules } from "./graph.ts";
import { createLogger, parseLogLevel, silentLogger, type Logger } from "./logger.ts";
import { assertValidMountPath, moduleTablePrefix, type Module, type ModuleContext, type ModuleMigration } from "./module.ts";
import { Registry } from "./registry.ts";
import { createVerifierSlot, type AccessTokenVerifier, type VerifierSlot } from "./verifier.ts";

/** rootRoutes are for RFC 8615 well-known URIs only; every other root path is owned by the gateway. */
const WELL_KNOWN_PREFIX = "/.well-known/";

export type KernelState = "created" | "booting" | "running" | "stopping" | "stopped" | "failed";

export interface KernelOptions {
  config?: EnvLike | Config;
  logger?: Logger;
  /** Initial verifier for the slot. Default: fail-closed "unavailable". */
  verifier?: AccessTokenVerifier;
  registry?: Registry;
  /** Root Hono app to mount onto. Default: a new one. */
  app?: Hono;
  /** Per-module mount path overrides, keyed by module name (e.g. from `MONACA_MCP_DEMO_MOUNT`). */
  mountOverrides?: Readonly<Record<string, string>>;
}

export interface ModuleMigrations {
  readonly module: string;
  /** The only table-name prefix this module may write. */
  readonly tablePrefix: string;
  readonly migrations: readonly ModuleMigration[];
}

/**
 * Hosts modules. Lifecycle: `register` -> `boot` (init all, mount routes, start all, each in
 * dependency order) -> `stop` (reverse order, every module, errors collected). A failed boot rolls
 * back by stopping every module whose `init` completed, then leaves the kernel in `failed`; a
 * kernel is not reusable after that.
 */
export class Kernel {
  readonly app: Hono;
  readonly config: Config;
  readonly logger: Logger;
  readonly registry: Registry;
  readonly verifier: VerifierSlot;

  readonly #modules: Module[] = [];
  readonly #mountOverrides: Readonly<Record<string, string>>;
  #state: KernelState = "created";
  #order: Module[] = [];
  #contexts = new Map<string, ModuleContext>();
  /** Modules whose `init` completed; these (and only these) get `stop`. */
  #initialised: Module[] = [];
  #bootPromise: Promise<void> | null = null;

  constructor(options: KernelOptions = {}) {
    this.app = options.app ?? new Hono();
    this.config = createConfig(options.config ?? {});
    this.logger = options.logger ?? silentLogger;
    this.registry = options.registry ?? new Registry();
    this.verifier = createVerifierSlot(options.verifier);
    this.#mountOverrides = options.mountOverrides ?? {};
  }

  get state(): KernelState {
    return this.#state;
  }

  /** Module names in the order they were booted; empty before `boot`. */
  get order(): readonly string[] {
    return this.#order.map((module) => module.name);
  }

  register(...modules: Module[]): this {
    if (this.#state !== "created") {
      throw new KernelError("KERNEL_STATE", `cannot register modules while the kernel is ${this.#state}`);
    }
    this.#modules.push(...modules);
    return this;
  }

  /** Resolved mount path for a registered module (override > definition > `/modules/<name>`). */
  mountPathOf(module: Module): string {
    const path = this.#mountOverrides[module.name] ?? module.mountPath ?? `/modules/${module.name}`;
    assertValidMountPath(module.name, path);
    return path;
  }

  /** Every module's migrations in boot order; handed to the Rust orchestrator in the next run. */
  migrations(): ModuleMigrations[] {
    return this.#resolve().map((module) => ({
      module: module.name,
      tablePrefix: moduleTablePrefix(module.name),
      migrations: module.migrations ?? [],
    }));
  }

  /** Boot once. Calling it again while booting or running returns the same promise. */
  boot(): Promise<void> {
    if (this.#bootPromise !== null && (this.#state === "booting" || this.#state === "running")) {
      return this.#bootPromise;
    }
    if (this.#state !== "created") {
      return Promise.reject(new KernelError("KERNEL_STATE", `cannot boot a kernel that is ${this.#state}`));
    }
    this.#state = "booting";
    this.#bootPromise = this.#runBoot();
    return this.#bootPromise;
  }

  /**
   * Stop every module whose `init` completed, in reverse boot order. All of them are attempted;
   * if any throw, a {@link KernelStopError} listing every failure is thrown at the end.
   * Calling `stop` on a kernel that is not running is a no-op.
   */
  async stop(): Promise<void> {
    if (this.#state === "booting" && this.#bootPromise !== null) {
      // boot() reports its own failure to its caller; here we only need it to settle.
      await this.#bootPromise.catch(() => undefined);
    }
    if (this.#state !== "running") return;
    this.#state = "stopping";
    const failures = await this.#stopModules(this.#initialised);
    this.#state = "stopped";
    if (failures.length > 0) throw new KernelStopError(failures);
  }

  #resolve(): Module[] {
    const ordered = orderModules(this.#modules);
    this.#assertNoMountConflicts(ordered);
    return ordered;
  }

  #assertNoMountConflicts(ordered: readonly Module[]): void {
    const claimed: Array<{ module: string; path: string }> = [];
    for (const module of ordered) {
      if (module.routes === undefined) continue;
      const path = this.mountPathOf(module);
      for (const other of claimed) {
        if (path === other.path || path.startsWith(`${other.path}/`) || other.path.startsWith(`${path}/`)) {
          throw new ModuleGraphError(
            "mount-conflict",
            [other.module, module.name],
            `modules "${other.module}" (${other.path}) and "${module.name}" (${path}) have overlapping mount paths`,
          );
        }
      }
      claimed.push({ module: module.name, path });
    }
  }

  async #runBoot(): Promise<void> {
    let phase: LifecyclePhase = "init";
    let current: Module | undefined;
    try {
      this.#order = this.#resolve();
      for (const module of this.#order) {
        this.#contexts.set(module.name, this.#contextFor(module));
      }

      phase = "init";
      for (const module of this.#order) {
        current = module;
        this.logger.debug("init", { module: module.name });
        await module.init?.(this.#contexts.get(module.name) as ModuleContext);
        this.#initialised.push(module);
      }

      phase = "routes";
      for (const module of this.#order) {
        current = module;
        await this.#mountRoutes(module, this.#contexts.get(module.name) as ModuleContext);
      }

      phase = "start";
      for (const module of this.#order) {
        current = module;
        this.logger.debug("start", { module: module.name });
        await module.start?.(this.#contexts.get(module.name) as ModuleContext);
      }

      this.#state = "running";
      this.logger.info("kernel running", { modules: this.order.join(",") });
    } catch (error) {
      this.#state = "failed";
      // Graph errors happen before any hook runs and name the modules themselves.
      if (current === undefined || error instanceof ModuleGraphError) throw error;
      const rollbackFailures = await this.#stopModules(this.#initialised);
      throw new ModuleLifecycleError(current.name, phase, error, rollbackFailures);
    }
  }

  async #mountRoutes(module: Module, ctx: ModuleContext): Promise<void> {
    if (module.routes !== undefined) {
      // Build on a scratch app so a throwing `routes` never leaves half a module mounted.
      const scoped = new Hono();
      await module.routes(scoped, ctx);
      this.app.route(ctx.mountPath, scoped);
      this.logger.debug("routes mounted", { module: module.name, path: ctx.mountPath });
    }
    if (module.rootRoutes !== undefined) {
      const scoped = new Hono();
      await module.rootRoutes(scoped, ctx);
      const stray = scoped.routes.find((route) => !route.path.startsWith(WELL_KNOWN_PREFIX));
      if (stray !== undefined) {
        throw new KernelError(
          "MODULE_ROUTE_FORBIDDEN",
          `rootRoutes may only register paths under ${WELL_KNOWN_PREFIX} (got ${stray.method} ${stray.path}); ` +
            "everything else belongs under the module mount path",
        );
      }
      this.app.route("/", scoped);
    }
  }

  /** Reverse-order stop of `modules`; returns every failure instead of throwing on the first. */
  async #stopModules(modules: readonly Module[]): Promise<ModuleFailure[]> {
    const failures: ModuleFailure[] = [];
    for (const module of [...modules].reverse()) {
      if (module.stop === undefined) continue;
      try {
        this.logger.debug("stop", { module: module.name });
        await module.stop(this.#contexts.get(module.name) as ModuleContext);
      } catch (error) {
        failures.push({ module: module.name, error });
        this.logger.error("module stop failed", { module: module.name, error });
      }
    }
    return failures;
  }

  #contextFor(module: Module): ModuleContext {
    return {
      module: { name: module.name, version: module.version },
      config: this.config,
      logger: this.logger.child({ module: module.name }),
      registry: this.registry,
      verifier: this.verifier,
      mountPath: this.mountPathOf(module),
    };
  }
}

/** Convenience for entry points: a kernel with a logger configured from `MONACA_LOG_*`. */
export function createKernel(options: KernelOptions = {}): Kernel {
  if (options.logger !== undefined) return new Kernel(options);
  const config = createConfig(options.config ?? {});
  return new Kernel({
    ...options,
    config,
    logger: createLogger({
      level: parseLogLevel(config.get("MONACA_LOG_LEVEL")),
      format: config.get("MONACA_LOG_FORMAT") === "json" ? "json" : "pretty",
    }),
  });
}
