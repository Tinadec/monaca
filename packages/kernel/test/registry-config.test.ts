import { describe, expect, test } from "bun:test";
import {
  createToken,
  DuplicateTokenError,
  MissingTokenError,
  Registry,
  createConfig,
  ConfigError,
  createLogger,
  parseLogLevel,
  type LogRecord,
} from "../src/index.ts";

describe("Registry", () => {
  const GREETER = createToken<{ hi(): string }>("greeter");
  const PORT = createToken<number>("port");

  test("provide then resolve returns the same value, typed", () => {
    const registry = new Registry();
    const greeter = { hi: () => "hello" };
    registry.provide(GREETER, greeter);
    registry.provide(PORT, 8080);
    expect(registry.resolve(GREETER)).toBe(greeter);
    expect(registry.resolve(GREETER).hi()).toBe("hello");
    const port: number = registry.resolve(PORT);
    expect(port).toBe(8080);
  });

  test("resolving a missing token throws and names the token", () => {
    const registry = new Registry();
    expect(() => registry.resolve(GREETER)).toThrow(MissingTokenError);
    expect(() => registry.resolve(GREETER)).toThrow('"greeter"');
    try {
      registry.resolve(GREETER);
    } catch (error) {
      expect((error as MissingTokenError).token).toBe("greeter");
      expect((error as MissingTokenError).code).toBe("DI_TOKEN_MISSING");
    }
  });

  test("the error lists what is provided, to make typos obvious", () => {
    const registry = new Registry();
    registry.provide(PORT, 1);
    expect(() => registry.resolve(GREETER)).toThrow(/provided: "port"/);
  });

  test("providing a token twice is an error", () => {
    const registry = new Registry();
    registry.provide(PORT, 1);
    expect(() => registry.provide(PORT, 2)).toThrow(DuplicateTokenError);
    expect(registry.resolve(PORT)).toBe(1);
  });

  test("tokens are compared by identity, not by name", () => {
    const a = createToken<number>("same");
    const b = createToken<number>("same");
    const registry = new Registry();
    registry.provide(a, 1);
    expect(registry.has(a)).toBe(true);
    expect(registry.has(b)).toBe(false);
    expect(() => registry.resolve(b)).toThrow(MissingTokenError);
  });

  test("falsy values are valid providers", () => {
    const zero = createToken<number>("zero");
    const empty = createToken<string>("empty");
    const registry = new Registry();
    registry.provide(zero, 0);
    registry.provide(empty, "");
    expect(registry.resolve(zero)).toBe(0);
    expect(registry.resolve(empty)).toBe("");
    expect(registry.tryResolve(zero)).toBe(0);
  });

  test("tryResolve returns undefined for a missing token", () => {
    expect(new Registry().tryResolve(PORT)).toBeUndefined();
  });

  test("a token needs a name", () => {
    expect(() => createToken("  ")).toThrow(TypeError);
  });
});

describe("Config", () => {
  test("empty string counts as unset", () => {
    const config = createConfig({ A: "", B: "x" });
    expect(config.get("A")).toBeUndefined();
    expect(config.get("B")).toBe("x");
    expect(config.getOr("A", "fallback")).toBe("fallback");
  });

  test("require names the variable but never the value", () => {
    const config = createConfig({ SECRET: "" });
    expect(() => config.require("SECRET")).toThrow(ConfigError);
    expect(() => config.require("SECRET")).toThrow("SECRET: required but not set");
  });

  test("int and bool parse strictly", () => {
    const config = createConfig({ N: "12", BAD: "12abc", T: "1", F: "false", WEIRD: "maybe" });
    expect(config.int("N", 0)).toBe(12);
    expect(config.int("MISSING", 7)).toBe(7);
    expect(() => config.int("BAD", 0)).toThrow("BAD: must be an integer");
    expect(config.bool("T", false)).toBe(true);
    expect(config.bool("F", true)).toBe(false);
    expect(config.bool("MISSING", true)).toBe(true);
    expect(() => config.bool("WEIRD", false)).toThrow("WEIRD");
    expect(() => config.bool("WEIRD", false)).not.toThrow("maybe");
  });
});

describe("logger", () => {
  const collect = () => {
    const lines: string[] = [];
    const records: LogRecord[] = [];
    return { lines, records, sink: (line: string, record: LogRecord) => (lines.push(line), records.push(record)) };
  };

  test("filters below the configured level", () => {
    const { records, sink } = collect();
    const log = createLogger({ level: "warn", sink });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(records.map((r) => r.level)).toEqual(["warn", "error"]);
  });

  test("child bindings are merged into every record", () => {
    const { records, sink } = collect();
    createLogger({ sink }).child({ module: "m" }).info("hi", { n: 1 });
    expect(records[0]?.fields).toEqual({ module: "m", n: 1 });
  });

  test("json format serialises errors with code", () => {
    const { lines, sink } = collect();
    const error = Object.assign(new Error("boom"), { code: "X_CODE" });
    createLogger({ format: "json", sink }).error("failed", { error });
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.msg).toBe("failed");
    expect(parsed.level).toBe("error");
    expect(parsed.error).toMatchObject({ name: "Error", message: "boom", code: "X_CODE" });
  });

  test("pretty format tags the module", () => {
    const { lines, sink } = collect();
    createLogger({ sink }).child({ module: "mcp-demo" }).info("ready", { port: 1 });
    expect(lines[0]).toContain("[mcp-demo] ready port=1");
  });

  test("parseLogLevel accepts EnvFilter-style values", () => {
    expect(parseLogLevel("info,monaca_store=debug")).toBe("info");
    expect(parseLogLevel("DEBUG")).toBe("debug");
    expect(parseLogLevel("trace")).toBe("debug");
    expect(parseLogLevel("silent")).toBe("silent");
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("nonsense")).toBe("info");
  });
});
