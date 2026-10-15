// Process supervision for `bun run dev`: one coloured name prefix per child, every stdout/stderr
// line forwarded, and an ordered shutdown that takes the whole tree down (a `bun --watch` parent
// does not reap the process it spawned, and Windows has no process groups).
import { spawn, type Subprocess } from "bun";

export type ChildColor = "cyan" | "magenta" | "yellow" | "green" | "blue" | "red";

const ANSI: Record<ChildColor, string> = {
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

/** Colour is disabled by NO_COLOR, and by a non-TTY stdout unless FORCE_COLOR asks for it. */
const colorEnabled = (): boolean =>
  process.env.NO_COLOR === undefined && (process.stdout.isTTY === true || process.env.FORCE_COLOR === "1");

export interface ChildSpec {
  /** Prefix printed on every line, and the handle's identity in logs. */
  name: string;
  color: ChildColor;
  cmd: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** How long to wait after SIGTERM before escalating, in ms. */
  killGraceMs?: number;
}

export interface ChildHandle {
  readonly name: string;
  readonly pid: number;
  /** Exit code, or null while running. */
  readonly exitCode: number | null;
  /** Resolves with the exit code (never rejects). */
  readonly exited: Promise<number>;
  /** SIGTERM (tree), then SIGKILL after the grace period. Idempotent. */
  stop(): Promise<number>;
}

function writeLine(color: ChildColor, name: string, line: string): void {
  const label = colorEnabled() ? `${ANSI[color]}${name}${RESET}` : name;
  process.stdout.write(`${label} ${DIM}│${RESET} ${line}\n`);
}

/** Splits a byte stream into lines, keeping the final unterminated fragment. */
async function pump(stream: ReadableStream<Uint8Array>, sink: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? "";
      for (const part of parts) if (part !== "") sink(part);
    }
    pending += decoder.decode();
    if (pending !== "") sink(pending);
  } catch {
    // The stream is torn down when the child dies; nothing to report.
  }
}

/**
 * Asks the OS to terminate `pid` and the whole tree beneath it.
 *
 * Windows, measured on this machine: `process.kill(pid, …)` reaches only the direct child when
 * that child is a `.cmd`/`.bat` shim — the real server underneath survives — and the call itself
 * occasionally blocks the event loop for ~5 s. `taskkill /pid <n> /t /f` is the one primitive that
 * reliably walks the tree (measured ~4 s for `bun → cmd shim → node → bun`). It is spawned in the
 * background; the returned process **must be awaited**, because the direct child dies long before
 * the walk reaches its descendants.
 *
 * POSIX: the child was spawned detached, so signalling its process group takes the whole tree
 * synchronously and there is nothing to await.
 */
function killTree(pid: number, signal: "SIGTERM" | "SIGKILL"): Subprocess<"ignore", "ignore", "ignore"> | undefined {
  if (process.platform === "win32") {
    try {
      return spawn(["taskkill", "/pid", String(pid), "/t", "/f"], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
    } catch {
      // taskkill itself failed to launch; the caller's liveness poll reports the outcome.
      return undefined;
    }
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
  return undefined;
}

/**
 * Synchronous last resort for a tree the tree kill left behind. On Windows it reaches the direct
 * child and, because Bun puts its children in a Windows job object, normally the tree with it.
 */
function forceKill(pid: number): void {
  if (process.platform === "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
    return;
  }
  killTree(pid, "SIGKILL");
}

/** True while `pid` exists, as observed by the OS rather than by our own bookkeeping. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function startChild(spec: ChildSpec): ChildHandle {
  const proc: Subprocess<"ignore", "pipe", "pipe"> = spawn({
    cmd: spec.cmd,
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // A detached child on POSIX gets its own process group so the whole tree can be signalled.
    detached: process.platform !== "win32",
  });

  const pid = proc.pid;
  const exited = proc.exited.then(
    (code) => code,
    () => 1,
  );
  void pump(proc.stdout, (line) => writeLine(spec.color, spec.name, line));
  void pump(proc.stderr, (line) => writeLine(spec.color, spec.name, line));

  let code: number | null = null;
  void exited.then((c) => {
    code = c;
  });

  // `proc.exited` is documented below as a poor liveness signal; this is the good one.
  let observedDead = false;
  void exited.then(() => {
    observedDead = true;
  });
  const poll = setInterval(() => {
    if (!isAlive(pid)) {
      observedDead = true;
      clearInterval(poll);
    }
  }, 250);
  void exited.then(() => clearInterval(poll));

  /**
   * Waits for the child to stop existing. `proc.exited` alone is not enough: Bun closes a
   * dead child's pipes on its own schedule (measured ~5 s after a SIGKILL on this machine), so
   * the polled `isAlive` check is what makes shutdown feel immediate.
   */
  const waitGone = async (timeoutMs: number): Promise<boolean> => {
    if (observedDead) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (observedDead || !isAlive(pid)) return true;
      await Bun.sleep(25);
    }
    return false;
  };

  let stopping: Promise<number> | undefined;
  const stop = (): Promise<number> => {
    stopping ??= (async () => {
      // The tree walk runs even when the direct child is already gone: `bun --watch` leaves its
      // script's descendants alive after the script dies, and those descendants are what hold the
      // ports. There is no cheap way to ask Windows "does this pid still have children?" — the
      // WMI query takes ~30 s — and the whole shutdown already spends ~10 s in `pg_ctl stop`, so
      // the unconditional walk (measured ~4 s) is the right trade.
      //
      // Windows has no SIGTERM and `taskkill /f` is already both the ask and the insist, so there
      // is nothing to escalate to; POSIX gets a grace period before SIGKILL.
      const tree = killTree(pid, "SIGTERM");
      // Awaiting the tree kill is what makes shutdown correct: on Windows the direct child dies
      // within milliseconds of taskkill starting, but its descendants — vite is `bun → cmd → node`
      // — only die when the walk reaches them, seconds later. Returning early would leave them
      // holding their ports.
      if (tree) await tree.exited.catch(() => 1);
      if (!(await waitGone(spec.killGraceMs ?? 10_000))) {
        writeLine(spec.color, spec.name, `tree kill did not stop pid ${pid}; forcing`);
        forceKill(pid);
        if (!(await waitGone(5_000))) {
          writeLine(spec.color, spec.name, `pid ${pid} is still running; it may be holding a port`);
        }
      }
      return finish();
    })();
    return stopping;
  };

  /** The exit code, waiting briefly for Bun to report it once the process is known dead. */
  async function finish(): Promise<number> {
    if (code !== null) return code;
    await Promise.race([exited, Bun.sleep(500)]);
    return code ?? 0;
  }

  return {
    name: spec.name,
    pid,
    get exitCode() {
      return code;
    },
    exited,
    stop,
  };
}

export interface RunResult {
  code: number;
  ms: number;
}

/**
 * Runs a command to completion, forwarding its output under the same coloured prefix.
 * `timeoutMs` returns code 124 (the shell convention) instead of hanging forever.
 */
export async function runChild(spec: ChildSpec & { timeoutMs?: number }): Promise<RunResult> {
  const t0 = performance.now();
  const child = startChild(spec);
  let code: number;
  if (spec.timeoutMs === undefined) {
    code = await child.exited;
  } else {
    const raced = await Promise.race([child.exited, Bun.sleep(spec.timeoutMs).then(() => null)]);
    if (raced === null) {
      writeLine(spec.color, spec.name, `timed out after ${spec.timeoutMs} ms; stopping`);
      await child.stop();
      code = 124;
    } else {
      code = raced;
    }
  }
  return { code, ms: Math.round(performance.now() - t0) };
}

/** The process supervisor: ordered shutdown, at most once. */
export class Supervisor {
  readonly #children: ChildHandle[] = [];
  #shuttingDown: Promise<void> | undefined;

  add(child: ChildHandle): ChildHandle {
    this.#children.push(child);
    return child;
  }

  get size(): number {
    return this.#children.length;
  }

  /**
   * Registers SIGINT/SIGTERM so a console Ctrl-C runs `onSignal` instead of killing us outright.
   * The handler does not exit and does not touch the children itself: `onSignal` owns the whole
   * ordered shutdown, and the caller's top-level control flow decides the exit code afterwards.
   * Re-entrant signals (a second Ctrl-C) join the same promise rather than starting a second stop.
   */
  install(onSignal: () => Promise<void>): void {
    const handler = (): void => {
      this.#shuttingDown ??= Promise.resolve().then(onSignal);
      void this.#shuttingDown.catch(() => undefined);
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    if (process.platform === "win32") process.on("SIGBREAK", handler);
  }

  /** The in-flight shutdown started by a signal, or undefined if none has begun. */
  get shuttingDown(): Promise<void> | undefined {
    return this.#shuttingDown;
  }

  /** Stops every child. Idempotent, so it is safe to call from the shutdown and the failure path. */
  async stopAll(): Promise<void> {
    await Promise.allSettled(this.#children.map((c) => c.stop()));
  }
}
