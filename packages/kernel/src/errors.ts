/** Base class for every error the kernel raises on its own behalf. `code` is stable and greppable. */
export class KernelError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export type LifecyclePhase = "init" | "routes" | "start" | "stop";

export interface ModuleFailure {
  readonly module: string;
  readonly error: unknown;
}

/** A module's own hook failed. `cause` is the original error, never replaced. */
export class ModuleLifecycleError extends KernelError {
  readonly module: string;
  readonly phase: LifecyclePhase;
  /** Failures from rolling back already-initialised modules after this one failed. */
  readonly rollbackFailures: readonly ModuleFailure[];

  constructor(
    module: string,
    phase: LifecyclePhase,
    cause: unknown,
    rollbackFailures: readonly ModuleFailure[] = [],
  ) {
    super(
      "MODULE_LIFECYCLE_FAILED",
      `module "${module}" failed in ${phase}: ${describe(cause)}` +
        (rollbackFailures.length > 0
          ? ` (rollback also failed for: ${rollbackFailures.map((f) => f.module).join(", ")})`
          : ""),
      { cause },
    );
    this.module = module;
    this.phase = phase;
    this.rollbackFailures = rollbackFailures;
  }
}

/** One or more modules threw from `stop`. Every module is still stopped; nothing is swallowed. */
export class KernelStopError extends KernelError {
  readonly failures: readonly ModuleFailure[];

  constructor(failures: readonly ModuleFailure[]) {
    super(
      "KERNEL_STOP_FAILED",
      `${failures.length} module(s) failed to stop cleanly: ` +
        failures.map((f) => `"${f.module}": ${describe(f.error)}`).join("; "),
      {
        cause:
          failures.length === 1 ? failures[0]?.error : new AggregateError(failures.map((f) => f.error)),
      },
    );
    this.failures = failures;
  }
}

export type ModuleGraphProblem = "duplicate" | "missing-dependency" | "cycle" | "mount-conflict";

/** The registered modules cannot be ordered or mounted. Raised before any hook runs. */
export class ModuleGraphError extends KernelError {
  readonly kind: ModuleGraphProblem;
  /** Modules involved, in the order they appear in the message (for a cycle: the cycle path). */
  readonly modules: readonly string[];

  constructor(kind: ModuleGraphProblem, modules: readonly string[], message: string) {
    super(`MODULE_GRAPH_${kind.toUpperCase().replaceAll("-", "_")}`, message);
    this.kind = kind;
    this.modules = modules;
  }
}

/** A required configuration value is absent or malformed. Names the variable, never its value. */
export class ConfigError extends KernelError {
  readonly variable: string;

  constructor(variable: string, problem: string) {
    super("CONFIG_INVALID", `${variable}: ${problem}`);
    this.variable = variable;
  }
}

/** `Registry.resolve` found no provider; the message names the token. */
export class MissingTokenError extends KernelError {
  readonly token: string;

  constructor(token: string, provided: readonly string[]) {
    super(
      "DI_TOKEN_MISSING",
      `no provider registered for token "${token}"` +
        (provided.length > 0
          ? ` (provided: ${provided.map((n) => `"${n}"`).join(", ")})`
          : " (registry is empty)"),
    );
    this.token = token;
  }
}

export class DuplicateTokenError extends KernelError {
  readonly token: string;

  constructor(token: string) {
    super("DI_TOKEN_DUPLICATE", `token "${token}" already has a provider`);
    this.token = token;
  }
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
