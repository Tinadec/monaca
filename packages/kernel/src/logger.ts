export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `bindings` to every record. */
  child(bindings: LogFields): Logger;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly time: Date;
  readonly message: string;
  readonly fields: LogFields;
}

export interface LoggerOptions {
  /** Minimum level, or `silent` to drop everything. Default `info`. */
  level?: LogLevel | "silent";
  /** `pretty` (default) or `json`, matching `MONACA_LOG_FORMAT` (§2.2). */
  format?: "pretty" | "json";
  /** Where formatted lines go. Default: console. Tests inject a collector. */
  sink?: (line: string, record: LogRecord) => void;
  bindings?: LogFields;
}

const ORDER: Record<LogLevel | "silent", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export function parseLogLevel(raw: string | undefined): LogLevel | "silent" {
  const lowered = raw?.trim().toLowerCase();
  if (lowered === "silent") return "silent";
  // `MONACA_LOG_LEVEL` may carry Rust EnvFilter syntax ("info,monaca_store=debug"); take the head.
  const head = lowered?.split(",")[0]?.trim();
  if (head === "trace" || head === "debug") return "debug";
  if (head === "warn") return "warn";
  if (head === "error") return "error";
  return "info";
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = ORDER[options.level ?? "info"];
  const format = options.format ?? "pretty";
  const sink = options.sink ?? defaultSink;
  const bindings = options.bindings ?? {};

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (ORDER[level] < threshold) return;
    const record: LogRecord = { level, time: new Date(), message, fields: { ...bindings, ...fields } };
    sink(format === "json" ? formatJson(record) : formatPretty(record), record);
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}

/** A logger that discards everything; the default for tests. */
export const silentLogger: Logger = createLogger({ level: "silent" });

function defaultSink(line: string, record: LogRecord): void {
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line);
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return {
      name: value.name,
      message: value.message,
      ...(code === undefined ? {} : { code }),
      ...(value.stack === undefined ? {} : { stack: value.stack }),
    };
  }
  return value;
}

function formatJson(record: LogRecord): string {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.fields)) fields[key] = serialize(value);
  return JSON.stringify({ level: record.level, time: record.time.toISOString(), msg: record.message, ...fields });
}

function formatPretty(record: LogRecord): string {
  const { module, ...rest } = record.fields as { module?: unknown };
  const tag = module === undefined ? "" : ` [${String(module)}]`;
  const extras = Object.entries(rest)
    .map(([key, value]) => {
      const rendered = serialize(value);
      return `${key}=${typeof rendered === "string" ? rendered : JSON.stringify(rendered)}`;
    })
    .join(" ");
  const head = `${record.time.toISOString()} ${record.level.toUpperCase().padEnd(5)}${tag} ${record.message}`;
  return extras === "" ? head : `${head} ${extras}`;
}
