import { connect } from "node:net";

function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (listening: boolean): void => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * True when something accepts TCP connections on `port`. Both loopback families are probed
 * because Vite (and Node generally) binds `localhost` to ::1 first on Windows.
 */
export async function isListening(port: number, timeoutMs = 500): Promise<boolean> {
  const results = await Promise.all([
    probe("127.0.0.1", port, timeoutMs),
    probe("::1", port, timeoutMs),
  ]);
  return results.some(Boolean);
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  /** Polling stops early (returning false) as soon as this reports false. */
  alive?: () => boolean;
}

/** Polls `url` until it answers 2xx. Returns false on timeout or when `alive` turns false. */
export async function waitForHttp(url: string, opts: WaitOptions): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  const interval = opts.intervalMs ?? 300;
  while (Date.now() < deadline) {
    if (opts.alive && !opts.alive()) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(interval);
  }
  return false;
}

/** Polls until `port` accepts connections. Same contract as `waitForHttp`. */
export async function waitForPort(port: number, opts: WaitOptions): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  const interval = opts.intervalMs ?? 300;
  while (Date.now() < deadline) {
    if (opts.alive && !opts.alive()) return false;
    if (await isListening(port)) return true;
    await Bun.sleep(interval);
  }
  return false;
}

/** Short human description of a fetch/socket failure, without a stack trace. */
export function describeNetError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    if (err.name === "TimeoutError") return "timed out";
    return typeof code === "string" && code !== "" ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
