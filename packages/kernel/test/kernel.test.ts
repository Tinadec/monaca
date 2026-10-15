import { describe, expect, test } from "bun:test";
import {
  createLogger,
  createToken,
  defineModule,
  Kernel,
  KernelError,
  KernelStopError,
  ModuleGraphError,
  ModuleLifecycleError,
  VerifierUnavailableError,
  type AccessTokenVerifier,
  type LogRecord,
  type ModuleContext,
  type ModuleDefinition,
  type VerifiedToken,
} from "../src/index.ts";

/** Records every hook call, in order, so tests can assert the whole lifecycle sequence. */
function recorder() {
  const events: string[] = [];
  const hooks = (name: string, extra: { failIn?: "init" | "routes" | "start" | "stop" } = {}) => ({
    init: () => {
      events.push(`init:${name}`);
      if (extra.failIn === "init") throw new Error(`${name} init exploded`);
    },
    start: async () => {
      await Promise.resolve();
      events.push(`start:${name}`);
      if (extra.failIn === "start") throw new Error(`${name} start exploded`);
    },
    stop: () => {
      events.push(`stop:${name}`);
      if (extra.failIn === "stop") throw new Error(`${name} stop exploded`);
    },
  });
  return { events, hooks };
}

const mod = (name: string, dependsOn: string[], extra: Partial<ModuleDefinition> = {}) =>
  defineModule({ name, version: "1.0.0", dependsOn, ...extra });

describe("lifecycle", () => {
  test("init all, then start all (dependency order), stop in reverse", async () => {
    const { events, hooks } = recorder();
    const kernel = new Kernel();
    kernel.register(
      mod("app", ["db", "cache"], hooks("app")),
      mod("cache", ["db"], hooks("cache")),
      mod("db", [], hooks("db")),
    );
    await kernel.boot();
    expect(kernel.state).toBe("running");
    expect(kernel.order).toEqual(["db", "cache", "app"]);
    expect(events).toEqual([
      "init:db", "init:cache", "init:app",
      "start:db", "start:cache", "start:app",
    ]);

    events.length = 0;
    await kernel.stop();
    expect(kernel.state).toBe("stopped");
    expect(events).toEqual(["stop:app", "stop:cache", "stop:db"]);
  });

  test("routes are mounted after every init and before any start", async () => {
    const events: string[] = [];
    const kernel = new Kernel();
    kernel.register(
      mod("a", [], {
        init: () => void events.push("init:a"),
        routes: () => void events.push("routes:a"),
        start: () => void events.push("start:a"),
      }),
      mod("b", ["a"], {
        init: () => void events.push("init:b"),
        routes: () => void events.push("routes:b"),
        start: () => void events.push("start:b"),
      }),
    );
    await kernel.boot();
    expect(events).toEqual(["init:a", "init:b", "routes:a", "routes:b", "start:a", "start:b"]);
  });

  test("hooks are all optional", async () => {
    const kernel = new Kernel().register(mod("bare", []));
    await kernel.boot();
    await kernel.stop();
    expect(kernel.state).toBe("stopped");
  });

  test("hooks receive a context with config, logger, registry, verifier and module identity", async () => {
    const seen: ModuleContext[] = [];
    const kernel = new Kernel({ config: { MONACA_X: "1" } });
    kernel.register(mod("probe", [], { mountPath: "/probe", init: (ctx) => void seen.push(ctx) }));
    await kernel.boot();
    const ctx = seen[0] as ModuleContext;
    expect(ctx.module).toEqual({ name: "probe", version: "1.0.0" });
    expect(ctx.config.get("MONACA_X")).toBe("1");
    expect(ctx.registry).toBe(kernel.registry);
    expect(ctx.verifier).toBe(kernel.verifier);
    expect(ctx.mountPath).toBe("/probe");
    expect(typeof ctx.logger.info).toBe("function");
  });

  test("the module logger is tagged with the module name", async () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: "debug", sink: (_line, record) => void records.push(record) });
    const kernel = new Kernel({ logger });
    kernel.register(mod("tagged", [], { init: (ctx) => ctx.logger.info("hello") }));
    await kernel.boot();
    expect(records.find((r) => r.message === "hello")?.fields.module).toBe("tagged");
  });

  test("boot is idempotent while running and rejects reuse after stop", async () => {
    const { events, hooks } = recorder();
    const kernel = new Kernel().register(mod("a", [], hooks("a")));
    const first = kernel.boot();
    const second = kernel.boot();
    expect(second).toBe(first);
    await first;
    expect(events.filter((e) => e === "init:a")).toHaveLength(1);
    await kernel.stop();
    await expect(kernel.boot()).rejects.toThrow(KernelError);
  });

  test("register is refused once booting has begun", async () => {
    const kernel = new Kernel().register(mod("a", []));
    const booting = kernel.boot();
    expect(() => kernel.register(mod("late", []))).toThrow(/cannot register/);
    await booting;
  });

  test("stop on a kernel that never booted, or twice, is a no-op", async () => {
    const { events, hooks } = recorder();
    const kernel = new Kernel().register(mod("a", [], hooks("a")));
    await kernel.stop();
    expect(events).toEqual([]);
    await kernel.boot();
    await kernel.stop();
    await kernel.stop();
    expect(events.filter((e) => e === "stop:a")).toHaveLength(1);
  });

  test("async hooks are awaited sequentially", async () => {
    const events: string[] = [];
    const slow = (name: string) =>
      mod(name, name === "second" ? ["first"] : [], {
        init: async () => {
          events.push(`begin:${name}`);
          await new Promise((resolve) => setTimeout(resolve, 15));
          events.push(`end:${name}`);
        },
      });
    await new Kernel().register(slow("second"), slow("first")).boot().then(() => undefined);
    expect(events).toEqual(["begin:first", "end:first", "begin:second", "end:second"]);
  });
});

describe("graph errors surface from boot, before any hook runs", () => {
  test("cycle", async () => {
    const { events, hooks } = recorder();
    const kernel = new Kernel().register(mod("a", ["b"], hooks("a")), mod("b", ["a"], hooks("b")));
    const error = await kernel.boot().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModuleGraphError);
    expect((error as ModuleGraphError).kind).toBe("cycle");
    expect((error as Error).message).toContain('"a" -> "b" -> "a"');
    expect(events).toEqual([]);
    expect(kernel.state).toBe("failed");
  });

  test("missing dependency", async () => {
    const kernel = new Kernel().register(mod("app", ["db"]));
    const error = await kernel.boot().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModuleGraphError);
    expect((error as Error).message).toBe('module "app" depends on "db", which is not registered');
  });

  test("duplicate registration", async () => {
    const kernel = new Kernel().register(mod("a", []), mod("a", []));
    await expect(kernel.boot()).rejects.toThrow('module "a" is registered more than once');
  });
});

describe("failure handling", () => {
  test("an init failure rolls back earlier modules in reverse and keeps the original cause", async () => {
    const { events, hooks } = recorder();
    const kernel = new Kernel().register(
      mod("a", [], hooks("a")),
      mod("b", ["a"], hooks("b", { failIn: "init" })),
      mod("c", ["b"], hooks("c")),
    );
    const error = (await kernel.boot().catch((e: unknown) => e)) as ModuleLifecycleError;
    expect(error).toBeInstanceOf(ModuleLifecycleError);
    expect(error.module).toBe("b");
    expect(error.phase).toBe("init");
    expect((error.cause as Error).message).toBe("b init exploded");
    expect(error.message).toBe('module "b" failed in init: b init exploded');
    // b's init threw, so b never completed init and gets no stop; only a is rolled back.
    expect(events).toEqual(["init:a", "init:b", "stop:a"]);
    expect(kernel.state).toBe("failed");
  });

  test("a start failure stops every initialised module, including the one that failed to start", async () => {
    const { events, hooks } = recorder();
    const kernel = new Kernel().register(
      mod("a", [], hooks("a")),
      mod("b", ["a"], hooks("b", { failIn: "start" })),
      mod("c", ["b"], hooks("c")),
    );
    const error = (await kernel.boot().catch((e: unknown) => e)) as ModuleLifecycleError;
    expect(error.module).toBe("b");
    expect(error.phase).toBe("start");
    expect(events).toEqual([
      "init:a", "init:b", "init:c",
      "start:a", "start:b",
      "stop:c", "stop:b", "stop:a",
    ]);
  });

  test("rollback failures are attached to the boot error, not swallowed", async () => {
    const { hooks } = recorder();
    const kernel = new Kernel().register(
      mod("a", [], hooks("a", { failIn: "stop" })),
      mod("b", ["a"], hooks("b", { failIn: "start" })),
    );
    const error = (await kernel.boot().catch((e: unknown) => e)) as ModuleLifecycleError;
    expect(error.module).toBe("b");
    expect(error.rollbackFailures.map((f) => f.module)).toEqual(["a"]);
    expect((error.rollbackFailures[0]?.error as Error).message).toBe("a stop exploded");
    expect(error.message).toContain("rollback also failed for: a");
  });

  test("a throwing routes() fails boot with phase=routes and mounts nothing from that module", async () => {
    const kernel = new Kernel();
    kernel.register(
      mod("a", [], {
        routes: (app) => {
          app.get("/hello", (c) => c.text("hi"));
          throw new Error("routes exploded");
        },
      }),
    );
    const error = (await kernel.boot().catch((e: unknown) => e)) as ModuleLifecycleError;
    expect(error.phase).toBe("routes");
    expect((await kernel.app.request("/modules/a/hello")).status).toBe(404);
  });

  test("stop runs every module even when some throw, then reports all failures", async () => {
    const { events, hooks } = recorder();
    const kernel = new Kernel().register(
      mod("a", [], hooks("a", { failIn: "stop" })),
      mod("b", ["a"], hooks("b")),
      mod("c", ["b"], hooks("c", { failIn: "stop" })),
    );
    await kernel.boot();
    events.length = 0;
    const error = (await kernel.stop().then(
      () => undefined,
      (e: unknown) => e,
    )) as KernelStopError;
    expect(error).toBeInstanceOf(KernelStopError);
    expect(events).toEqual(["stop:c", "stop:b", "stop:a"]);
    expect(error.failures.map((f) => f.module)).toEqual(["c", "a"]);
    expect(error.message).toContain('"c": c stop exploded');
    expect(error.message).toContain('"a": a stop exploded');
    expect(kernel.state).toBe("stopped");
    // Reported once; a second stop does not replay the failure.
    await kernel.stop();
  });

  test("a single stop failure keeps that error as the cause", async () => {
    const { hooks } = recorder();
    const kernel = new Kernel().register(mod("a", [], hooks("a", { failIn: "stop" })));
    await kernel.boot();
    const error = (await kernel.stop().then(
      () => undefined,
      (e: unknown) => e,
    )) as KernelStopError;
    expect((error.cause as Error).message).toBe("a stop exploded");
  });

  test("stop failures are also logged", async () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: "error", sink: (_l, r) => void records.push(r) });
    const { hooks } = recorder();
    const kernel = new Kernel({ logger }).register(mod("a", [], hooks("a", { failIn: "stop" })));
    await kernel.boot();
    await kernel.stop().catch(() => undefined);
    expect(records.map((r) => r.message)).toEqual(["module stop failed"]);
    expect(records[0]?.fields.module).toBe("a");
  });

  test("stop() during a boot waits for it to settle", async () => {
    const { events, hooks } = recorder();
    const kernel = new Kernel().register(
      mod("a", [], { ...hooks("a"), init: async () => void (await new Promise((r) => setTimeout(r, 20)), events.push("init:a")) }),
    );
    const booting = kernel.boot();
    await kernel.stop();
    await booting;
    expect(events).toEqual(["init:a", "start:a", "stop:a"]);
  });
});

describe("dependency injection through modules", () => {
  const CLOCK = createToken<{ now(): number }>("clock");

  test("a dependency provides in init and its dependent resolves in its own init", async () => {
    let resolved = -1;
    const kernel = new Kernel();
    kernel.register(
      mod("consumer", ["provider"], {
        init: (ctx) => void (resolved = ctx.registry.resolve(CLOCK).now()),
      }),
      mod("provider", [], { init: (ctx) => ctx.registry.provide(CLOCK, { now: () => 42 }) }),
    );
    await kernel.boot();
    expect(resolved).toBe(42);
  });

  test("resolving a token nobody provided fails boot and names the token and the module", async () => {
    const kernel = new Kernel().register(mod("consumer", [], { init: (ctx) => void ctx.registry.resolve(CLOCK) }));
    const error = (await kernel.boot().catch((e: unknown) => e)) as ModuleLifecycleError;
    expect(error.module).toBe("consumer");
    expect(error.message).toContain('"clock"');
  });

  test("routes can use services provided during init", async () => {
    const kernel = new Kernel();
    kernel.register(
      mod("svc", [], {
        init: (ctx) => ctx.registry.provide(CLOCK, { now: () => 7 }),
        routes: (app, ctx) => void app.get("/now", (c) => c.text(String(ctx.registry.resolve(CLOCK).now()))),
      }),
    );
    await kernel.boot();
    const res = await kernel.app.request("/modules/svc/now");
    expect(await res.text()).toBe("7");
  });
});

describe("route mounting", () => {
  test("default prefix is /modules/<name>", async () => {
    const kernel = new Kernel();
    kernel.register(mod("notes", [], { routes: (app) => void app.get("/ping", (c) => c.json({ ok: 1 })) }));
    await kernel.boot();
    expect((await kernel.app.request("/modules/notes/ping")).status).toBe(200);
    expect((await kernel.app.request("/ping")).status).toBe(404);
  });

  test("the module's declared mountPath wins over the default", async () => {
    const kernel = new Kernel();
    kernel.register(
      mod("mcp-demo", [], {
        mountPath: "/mcp/demo",
        routes: (app) => void app.all("/", (c) => c.text("root")),
      }),
    );
    await kernel.boot();
    const res = await kernel.app.request("/mcp/demo");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("root");
  });

  test("a kernel override beats the module's mountPath", async () => {
    const kernel = new Kernel({ mountOverrides: { notes: "/custom" } });
    kernel.register(mod("notes", [], { mountPath: "/declared", routes: (app) => void app.get("/x", (c) => c.text("x")) }));
    await kernel.boot();
    expect((await kernel.app.request("/custom/x")).status).toBe(200);
    expect((await kernel.app.request("/declared/x")).status).toBe(404);
  });

  test("an invalid override is rejected with the module name", async () => {
    const kernel = new Kernel({ mountOverrides: { notes: "no-slash" } });
    kernel.register(mod("notes", [], { routes: () => undefined }));
    await expect(kernel.boot()).rejects.toThrow(/"notes".*mountPath/);
  });

  test("rootRoutes mount at the origin root, outside the prefix", async () => {
    const kernel = new Kernel();
    kernel.register(
      mod("mcp-demo", [], {
        mountPath: "/mcp/demo",
        routes: (app) => void app.get("/", (c) => c.text("mcp")),
        rootRoutes: (app) =>
          void app.get("/.well-known/oauth-protected-resource/mcp/demo", (c) => c.json({ resource: "r" })),
      }),
    );
    await kernel.boot();
    expect(await (await kernel.app.request("/.well-known/oauth-protected-resource/mcp/demo")).json()).toEqual({
      resource: "r",
    });
  });

  test("rootRoutes outside /.well-known/ are rejected so a module cannot shadow gateway paths", async () => {
    for (const path of ["/healthz", "/v1/accounts", "/.well-known", "/*"]) {
      const kernel = new Kernel();
      kernel.register(mod("rogue", [], { rootRoutes: (app) => void app.get(path, (c) => c.text("pwned")) }));
      const error = (await kernel.boot().catch((e: unknown) => e)) as ModuleLifecycleError;
      expect(error).toBeInstanceOf(ModuleLifecycleError);
      expect(error.phase).toBe("routes");
      expect((error.cause as KernelError).code).toBe("MODULE_ROUTE_FORBIDDEN");
      expect(error.message).toContain(path);
    }
  });

  test("modules mount side by side without leaking into each other", async () => {
    const kernel = new Kernel();
    kernel.register(
      mod("a", [], { routes: (app) => void app.get("/who", (c) => c.text("a")) }),
      mod("b", [], { routes: (app) => void app.get("/who", (c) => c.text("b")) }),
    );
    await kernel.boot();
    expect(await (await kernel.app.request("/modules/a/who")).text()).toBe("a");
    expect(await (await kernel.app.request("/modules/b/who")).text()).toBe("b");
  });

  test("equal or nested mount paths are a conflict naming both modules", async () => {
    for (const [first, second] of [["/x", "/x"], ["/x", "/x/y"], ["/x/y", "/x"]] as const) {
      const kernel = new Kernel();
      kernel.register(
        mod("one", [], { mountPath: first, routes: () => undefined }),
        mod("two", [], { mountPath: second, routes: () => undefined }),
      );
      const error = (await kernel.boot().catch((e: unknown) => e)) as ModuleGraphError;
      expect(error).toBeInstanceOf(ModuleGraphError);
      expect(error.kind).toBe("mount-conflict");
      expect(error.message).toContain('"one"');
      expect(error.message).toContain('"two"');
    }
  });

  test("sibling paths that merely share a string prefix do not conflict", async () => {
    const kernel = new Kernel();
    kernel.register(
      mod("one", [], { mountPath: "/mcp", routes: (app) => void app.get("/a", (c) => c.text("one")) }),
      mod("two", [], { mountPath: "/mcp-demo", routes: (app) => void app.get("/a", (c) => c.text("two")) }),
    );
    await kernel.boot();
    expect(await (await kernel.app.request("/mcp-demo/a")).text()).toBe("two");
  });

  test("modules without routes claim no mount path", async () => {
    const kernel = new Kernel();
    kernel.register(mod("one", [], { mountPath: "/x" }), mod("two", [], { mountPath: "/x", routes: () => undefined }));
    await kernel.boot();
    expect(kernel.state).toBe("running");
  });
});

describe("verifier slot", () => {
  const token: VerifiedToken = {
    iss: "i", sub: "acc_x", aud: "a", tid: "ten_x", org: "org_x", scope: ["tools:read"], jti: "j", iat: 1, exp: 2,
  };
  const expectations = { issuer: "i", audience: "a" };

  test("defaults to a fail-closed unavailable verifier", () => {
    const kernel = new Kernel();
    expect(() => kernel.verifier.verifyAccessToken("t", expectations)).toThrow(VerifierUnavailableError);
    try {
      kernel.verifier.verifyAccessToken("t", expectations);
    } catch (error) {
      expect((error as VerifierUnavailableError).code).toBe("MONACA_VERIFIER_UNAVAILABLE");
    }
  });

  test("an injected verifier is used, and swapping it is visible to holders of the slot", async () => {
    const calls: string[] = [];
    const first: AccessTokenVerifier = { verifyAccessToken: (t) => (calls.push(`first:${t}`), token) };
    const second: AccessTokenVerifier = { verifyAccessToken: (t) => (calls.push(`second:${t}`), token) };
    const kernel = new Kernel({ verifier: first });
    let captured: ModuleContext["verifier"] | undefined;
    kernel.register(mod("m", [], { init: (ctx) => void (captured = ctx.verifier) }));
    await kernel.boot();

    expect(await captured?.verifyAccessToken("1", expectations)).toBe(token);
    kernel.verifier.set(second);
    expect(await captured?.verifyAccessToken("2", expectations)).toBe(token);
    expect(calls).toEqual(["first:1", "second:2"]);
    expect(kernel.verifier.get()).toBe(second);
  });
});

describe("migrations", () => {
  test("exposed in boot order with the module's table prefix", () => {
    const kernel = new Kernel().register(
      mod("mcp-demo", ["base"], { migrations: [{ version: 1, description: "notes", sql: "create table mod_mcp_demo_notes()" }] }),
      mod("base", []),
    );
    expect(kernel.migrations()).toEqual([
      { module: "base", tablePrefix: "mod_base_", migrations: [] },
      {
        module: "mcp-demo",
        tablePrefix: "mod_mcp_demo_",
        migrations: [{ version: 1, description: "notes", sql: "create table mod_mcp_demo_notes()" }],
      },
    ]);
  });
});
