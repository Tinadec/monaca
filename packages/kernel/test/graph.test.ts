import { describe, expect, test } from "bun:test";
import {
  defineModule,
  KernelError,
  ModuleGraphError,
  orderModules,
  type ModuleDefinition,
} from "../src/index.ts";

const mod = (name: string, dependsOn: string[] = [], extra: Partial<ModuleDefinition> = {}) =>
  defineModule({ name, version: "1.0.0", dependsOn, ...extra });

const names = (modules: readonly { name: string }[]) => modules.map((m) => m.name);

describe("defineModule validation", () => {
  test("rejects bad names", () => {
    for (const bad of ["", "Upper", "1abc", "has space", "a_b", "x".repeat(41)]) {
      expect(() => defineModule({ name: bad, version: "1.0.0" })).toThrow(KernelError);
    }
  });

  test("rejects bad versions", () => {
    expect(() => defineModule({ name: "a", version: "1.0" })).toThrow(/semver/);
    expect(() => defineModule({ name: "a", version: "" })).toThrow(/semver/);
  });

  test("accepts prerelease versions", () => {
    expect(defineModule({ name: "a", version: "1.2.3-beta.1+build.5" }).version).toBe("1.2.3-beta.1+build.5");
  });

  test("self-dependency and duplicate dependency are rejected with the module name", () => {
    expect(() => mod("a", ["a"])).toThrow(/"a".*cannot depend on itself/);
    expect(() => mod("a", ["b", "b"])).toThrow(/"a".*lists "b" twice/);
  });

  test("mount paths: absolute, no trailing slash, no root, no dot segments", () => {
    for (const bad of ["x", "/", "/x/", "/a//b", "/a/../b", "/a/./b", "/a b", "/a?x=1"]) {
      expect(() => mod("a", [], { mountPath: bad })).toThrow(/mountPath/);
    }
    expect(mod("a", [], { mountPath: "/mcp/demo" }).mountPath).toBe("/mcp/demo");
  });

  test("migration versions must strictly increase", () => {
    const m = (version: number) => ({ version, description: "d", sql: "select 1" });
    expect(() => mod("a", [], { migrations: [m(1), m(1)] })).toThrow(/strictly increasing/);
    expect(() => mod("a", [], { migrations: [m(2), m(1)] })).toThrow(/strictly increasing/);
    expect(() => mod("a", [], { migrations: [m(0)] })).toThrow(/strictly increasing/);
    expect(mod("a", [], { migrations: [m(1), m(2)] }).migrations).toHaveLength(2);
  });

  test("the returned module is frozen and dependsOn is always an array", () => {
    const module = mod("a");
    expect(module.dependsOn).toEqual([]);
    expect(Object.isFrozen(module)).toBe(true);
    expect(Object.isFrozen(module.dependsOn)).toBe(true);
  });
});

describe("orderModules", () => {
  test("keeps registration order when there are no dependencies", () => {
    expect(names(orderModules([mod("c"), mod("a"), mod("b")]))).toEqual(["c", "a", "b"]);
  });

  test("puts dependencies first even when registered later", () => {
    expect(names(orderModules([mod("app", ["db"]), mod("db")]))).toEqual(["db", "app"]);
  });

  test("diamond: base, then left/right in registration order, then top", () => {
    const order = names(
      orderModules([mod("top", ["left", "right"]), mod("right", ["base"]), mod("left", ["base"]), mod("base")]),
    );
    expect(order).toEqual(["base", "right", "left", "top"]);
    expect(order.indexOf("base")).toBeLessThan(order.indexOf("left"));
    expect(order.indexOf("left")).toBeLessThan(order.indexOf("top"));
    expect(order.indexOf("right")).toBeLessThan(order.indexOf("top"));
  });

  test("a long chain registered in reverse resolves fully", () => {
    const chain = [mod("d", ["c"]), mod("c", ["b"]), mod("b", ["a"]), mod("a")];
    expect(names(orderModules(chain))).toEqual(["a", "b", "c", "d"]);
  });

  test("unrelated modules interleave deterministically around a dependency", () => {
    expect(names(orderModules([mod("x", ["z"]), mod("y"), mod("z")]))).toEqual(["y", "z", "x"]);
  });

  test("duplicate module names are an error naming the module", () => {
    try {
      orderModules([mod("a"), mod("a")]);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleGraphError);
      expect((error as ModuleGraphError).kind).toBe("duplicate");
      expect((error as ModuleGraphError).message).toContain('"a"');
    }
  });

  test("missing dependency names both the dependent and the absent module", () => {
    try {
      orderModules([mod("app", ["ghost"])]);
      throw new Error("expected throw");
    } catch (error) {
      const graph = error as ModuleGraphError;
      expect(graph).toBeInstanceOf(ModuleGraphError);
      expect(graph.kind).toBe("missing-dependency");
      expect(graph.code).toBe("MODULE_GRAPH_MISSING_DEPENDENCY");
      expect(graph.message).toBe('module "app" depends on "ghost", which is not registered');
      expect(graph.modules).toEqual(["app", "ghost"]);
    }
  });

  test("every missing dependency is reported, not just the first", () => {
    try {
      orderModules([mod("a", ["x"]), mod("b", ["y"])]);
      throw new Error("expected throw");
    } catch (error) {
      const graph = error as ModuleGraphError;
      expect(graph.message).toContain('"a" depends on "x"');
      expect(graph.message).toContain('"b" depends on "y"');
    }
  });

  test("two-module cycle shows the cycle path", () => {
    try {
      orderModules([mod("a", ["b"]), mod("b", ["a"])]);
      throw new Error("expected throw");
    } catch (error) {
      const graph = error as ModuleGraphError;
      expect(graph.kind).toBe("cycle");
      expect(graph.message).toBe('module dependency cycle: "a" -> "b" -> "a"');
      expect(graph.modules).toEqual(["a", "b", "a"]);
    }
  });

  test("three-module cycle behind an innocent module still names only the cycle", () => {
    try {
      orderModules([mod("entry", ["a"]), mod("a", ["b"]), mod("b", ["c"]), mod("c", ["a"])]);
      throw new Error("expected throw");
    } catch (error) {
      const graph = error as ModuleGraphError;
      expect(graph.kind).toBe("cycle");
      expect(graph.message).toBe('module dependency cycle: "a" -> "b" -> "c" -> "a"');
      expect(graph.message).not.toContain("entry");
    }
  });

  test("a cycle is reported even when other modules order fine", () => {
    expect(() => orderModules([mod("ok"), mod("a", ["b"]), mod("b", ["a"])])).toThrow(/cycle/);
  });
});
