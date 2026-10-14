/**
 * The TypeScript recorder: instrument.ts rewrites a source file so each named function,
 * method and constructor reports its calls and lines to the runtime (runtime.ts), which turns
 * them into a scenario in trace format version 2 (docs/trace-format.md).
 *
 * These tests instrument a small sample, run it, and read the scenario back as a call tree.
 */
import ts from "typescript";
import { describe, expect, test } from "vitest";

import { instrument } from "../src/instrument";
import { Recorder, ScenarioDto } from "../src/runtime";

const SAMPLE = `export class Repository {
  constructor(private readonly rows: string[]) {}
  find(name: string): string | undefined {
    return this.rows.find((row) => row === name);
  }
  get size(): number {
    return this.rows.length;
  }
}

export class Service {
  readonly repository: Repository;
  constructor(rows: string[]) {
    this.repository = new Repository(rows);
  }
  lookup(name: string): string {
    const found = this.repository.find(name);
    return found ?? describe(name);
    function describe(missing: string): string {
      return \`no \${missing}\`;
    }
  }
  async later(name: string): Promise<string> {
    await Promise.resolve();
    return this.lookup(name);
  }
  count = (): number => this.repository.size;
}

export const shout = (text: string) => text.toUpperCase();

export function* ids() {
  yield 1;
}
`;

/** Instruments the sample, transpiles it as TypeScript would, and loads it against `recorder`. */
function load(recorder: Recorder): Record<string, any> {
  return loadSource(recorder, SAMPLE);
}

function loadSource(recorder: Recorder, source: string): Record<string, any> {
  const { code } = instrument("app/sample.ts", source);
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  (globalThis as any).__runshape = recorder;
  new Function("exports", js)(exports);
  return exports;
}

/** The scenario as an indented call tree, then objects and wiring: what the viewer will be given. */
function describeScenario(scenario: ScenarioDto): string[] {
  const nameOf = (fn: number) => {
    const { container, name } = scenario.functions[fn]!.symbol;
    return [...container, name].join(".");
  };
  const depth = new Map<number, number>();
  const lines = new Map<number, number[]>();
  for (const event of scenario.events) if (event[0] === "L") lines.set(event[1], [...(lines.get(event[1]) ?? []), event[2]]);
  const objects = new Map<number, string>();
  const out: string[] = [];
  for (const event of scenario.events) {
    if (event[0] === "O") objects.set(event[2], `${event[3].at(-1)}#${event[2]}`);
    if (event[0] === "S") {
      const [, , span, fn, parent, , object] = event;
      depth.set(span, parent === null ? 0 : depth.get(parent)! + 1);
      const on = object === null ? "" : ` on ${objects.get(object) ?? `?${object}`}`;
      out.push(`${"  ".repeat(depth.get(span)!)}${nameOf(fn)}${on} ${JSON.stringify(lines.get(span) ?? [])}`);
    }
  }
  for (const event of scenario.events) {
    if (event[0] === "O") out.push(`built ${objects.get(event[2])} (${event[3].join(".")})`);
    if (event[0] === "W") out.push(`wired ${objects.get(event[2])}.${event[3]} -> ${objects.get(event[4])}`);
  }
  return out;
}

describe("instrument", () => {
  test("catalogues named functions, methods and constructors with their executable lines; callbacks and generators are not their own", () => {
    const { functions, code } = instrument("app/sample.ts", SAMPLE);

    expect(
      functions.map(({ symbol, firstLine, lines }) => {
        const owner = symbol.ownerType ? ` of ${symbol.ownerType}` : "";
        return `${[...symbol.container, symbol.name].join(".")}: ${symbol.kind}${owner}, line ${firstLine}, runs ${JSON.stringify(lines)}`;
      }),
    ).toEqual([
      "Repository.constructor: constructor of Repository, line 2, runs []",
      // The arrow passed to find() is part of find: its lines count as find's.
      "Repository.find: method of Repository, line 3, runs [4]",
      "Repository.get size: method of Repository, line 6, runs [7]",
      "Service.constructor: constructor of Service, line 13, runs [14]",
      // describe() is declared inside lookup: its own entry, nested, drawn in Service's box.
      "Service.lookup: method of Service, line 16, runs [17,18]",
      "Service.lookup.describe: nested of Service, line 19, runs [20]",
      "Service.later: method of Service, line 23, runs [24,25]",
      "Service.count: method of Service, line 27, runs [27]",
      "shout: function, line 30, runs [30]",
    ]);
    expect(functions.every(({ symbol }) => symbol.namespace.join("/") === "app/sample")).toBe(true);
    // Everything is inserted within existing lines, so stack traces and line events still match the source.
    expect(code.split("\n").length).toBe(SAMPLE.split("\n").length);
  });

  test("running the instrumented code records the call tree, the objects and their wiring", async () => {
    const recorder = new Recorder();
    const { Service, shout } = load(recorder);
    recorder.startScenario("app/sample.test.ts::looks things up", "app/sample.test.ts", ["looks things up"]);

    const service = new Service(["a", "b"]);
    service.lookup("a");
    service.lookup("z");
    await service.later("b");
    service.count();
    shout("x");

    const scenario = recorder.finishScenario("passed");
    expect(describeScenario(scenario)).toEqual([
      "looks things up []",
      // A constructor has no `this` until it runs, so its span carries no object; it built one.
      "  Service.constructor [14]",
      "    Repository.constructor []",
      "  Service.lookup on Service#2 [17,18]",
      "    Repository.find on Repository#1 [4]",
      "  Service.lookup on Service#2 [17,18]",
      "    Repository.find on Repository#1 [4]",
      "    Service.lookup.describe [20]",
      "  Service.later on Service#2 [24,25]",
      // Called after the await: still a child of later, not of whatever ran in between.
      "    Service.lookup on Service#2 [17,18]",
      "      Repository.find on Repository#1 [4]",
      "  Service.count on Service#2 [27]",
      "    Repository.get size on Repository#1 [7]",
      "  shout [30]",
      "built Repository#1 (app.sample.Repository)",
      "built Service#2 (app.sample.Service)",
      "wired Service#2.repository -> Repository#1",
    ]);
    expect(scenario.functions[0]).toMatchObject({ role: "test", symbol: { name: "looks things up" } });
  });

  test("a hot loop is recorded in part, and says how much it left out", () => {
    // Recording every call and every line of a loop made one of core's tests 27 million events.
    // Each line is recorded once per call, and a caller's first calls to a function are kept.
    const recorder = new Recorder({ callsPerCaller: 3, eventsPerScenario: 1_000 });
    const { code } = instrument(
      "app/loop.ts",
      `export function total(values: number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += double(value);
  }
  return sum;
}
export function double(value: number): number {
  return value * 2;
}
`,
    );
    const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: Record<string, any> = {};
    (globalThis as any).__runshape = recorder;
    new Function("exports", js)(exports);
    recorder.startScenario("app/loop.test.ts::sums", "app/loop.test.ts", ["sums"]);

    expect(exports.total([1, 2, 3, 4, 5])).toBe(30);

    const scenario = recorder.finishScenario("passed");
    expect(describeScenario(scenario)).toEqual([
      "sums []",
      "  total [2,3,4,6]",
      "    double [9]",
      "    double [9]",
      "    double [9]",
    ]);
    expect(scenario.recorderErrors).toEqual(["2 more calls of double from total were not recorded (limit 3 per caller)"]);
  });

  test("a callback's lines belong to the function that wrote it, even when another function runs it", () => {
    // Second-model review: `user` passes a callback to `each`; the callback's line was recorded
    // on `each`, so user's view showed it unreached and each's showed a line from elsewhere.
    const recorder = new Recorder();
    const { user } = loadSource(
      recorder,
      `export function each(values: number[], visit: (value: number) => void): void {
  for (const value of values) visit(value);
}
export function user(): number {
  let total = 0;
  each([1, 2], (value) => {
    total += value;
  });
  return total;
}
`,
    );
    recorder.startScenario("app/s.test.ts::sums", "app/s.test.ts", ["sums"]);
    expect(user()).toBe(3);
    expect(describeScenario(recorder.finishScenario("passed"))).toEqual(["sums []", "  user [5,6,7,9]", "    each [2]"]);
  });

  test("work a test left running is not recorded in the next test", async () => {
    const recorder = new Recorder();
    const { later } = loadSource(
      recorder,
      `export async function later(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  inner();
}
export function inner(): void {
  return;
}
`,
    );
    recorder.startScenario("app/s.test.ts::first", "app/s.test.ts", ["first"]);
    const unawaited = later();
    const first = recorder.finishScenario("passed");
    recorder.startScenario("app/s.test.ts::second", "app/s.test.ts", ["second"]);
    await unawaited;

    expect([describeScenario(first), describeScenario(recorder.finishScenario("passed"))]).toEqual([["first []", "  later [2]"], ["second []"]]);
  });

  test("names stay distinct: static and instance members, and functions in different namespaces", () => {
    const { functions } = instrument(
      "app/names.ts",
      `export class Factory {
  static make(): Factory {
    return new Factory();
  }
  make(): string {
    return "made";
  }
}
namespace A {
  export function f(): number {
    return 1;
  }
}
namespace B {
  export function f(): number {
    return 2;
  }
}
`,
    );

    expect(functions.map(({ symbol }) => [...symbol.container, symbol.name].join("."))).toEqual(["Factory.static make", "Factory.make", "A.f", "B.f"]);
  });

  test("a constructor that throws builds nothing; an object's getters are not run to read its wiring", () => {
    const recorder = new Recorder();
    const { Strict, Lazy } = loadSource(
      recorder,
      `export class Strict {
  constructor(value: number) {
    if (value < 0) throw new Error("negative");
  }
}
export class Lazy {
  reads = 0;
  constructor() {
    Object.defineProperty(this, "costly", { enumerable: true, get: () => ++this.reads });
  }
}
`,
    );
    recorder.startScenario("app/s.test.ts::builds", "app/s.test.ts", ["builds"]);
    expect(() => new Strict(-1)).toThrow("negative");
    const lazy = new Lazy();

    expect(describeScenario(recorder.finishScenario("passed"))).toEqual(["builds []", "  Strict.constructor [3]", "  Lazy.constructor [9]", "built Lazy#1 (app.sample.Lazy)"]);
    expect(lazy.reads).toBe(0);
  });

  test("files a plain loader can't run instrumented still load: a hashbang, an ambient class, no recorder at all", () => {
    const source = `#!/usr/bin/env node
declare class Ambient {}
export function answer(): number {
  return 42;
}
`;
    const { code } = instrument("app/cli.ts", source);
    expect(code.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(code.split("\n").length).toBe(source.split("\n").length);

    delete (globalThis as any).__runshape;
    const exports: Record<string, any> = {};
    const js = ts.transpileModule(code.replace(/^#!.*\n/, "\n"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("exports", js)(exports);
    expect(exports.answer()).toBe(42);
  });

  test("a full scenario says so, rather than blaming the per-caller limit", () => {
    const recorder = new Recorder({ callsPerCaller: 50, eventsPerScenario: 6 });
    const { many } = loadSource(
      recorder,
      `export function many(): void {
  for (let i = 0; i < 5; i += 1) one();
}
export function one(): void {
  return;
}
`,
    );
    recorder.startScenario("app/s.test.ts::fills", "app/s.test.ts", ["fills"]);
    many();

    expect(recorder.finishScenario("passed").recorderErrors).toEqual(["stopped recording after 6 events: 4 later calls were not recorded"]);
  });

  test("a derived class's constructor is its own span from super() on, and the object is credited to it", () => {
    const recorder = new Recorder();
    const source = `export class Base {
  constructor(protected readonly name: string) {}
}
export class Derived extends Base {
  readonly other: Base;
  constructor(name: string, private readonly extra: number) {
    super(name);
    this.other = new Base("other");
  }
}
`;
    const { Derived } = loadSource(recorder, source);
    recorder.startScenario("app/s.test.ts::builds", "app/s.test.ts", ["builds"]);
    const built = new Derived("a", 1);

    const scenario = recorder.finishScenario("passed");
    expect([built.name, built.extra, built.other.name]).toEqual(["a", 1, "other"]);
    // super(name) and anything before it run before the span opens: not lines it can reach.
    expect(instrument("app/sample.ts", source).functions.find((fn) => fn.symbol.container[0] === "Derived")!.lines).toEqual([8]);
    expect(describeScenario(scenario)).toEqual([
      "builds []",
      // super(name) runs before Derived's own span opens: the base's part comes first, beside it.
      "  Base.constructor []",
      "  Derived.constructor [8]",
      "    Base.constructor []",
      "built Derived#1 (app.sample.Derived)",
      "built Base#2 (app.sample.Base)",
      "wired Derived#1.other -> Base#2",
    ]);
    const derivedSpan = scenario.events.find((event) => event[0] === "S" && scenario.functions[event[3]]!.symbol.container[0] === "Derived")![2];
    expect(scenario.events.find((event) => event[0] === "O" && event[2] === 1)![4]).toBe(derivedSpan);
  });

  test("a branch or loop body without braces has its own line, so which branch ran is recorded", () => {
    const source = `export function sign(n: number): string {
  if (n < 0)
    return "negative";
  else if (n === 0)
    return "zero";
  for (const step of [1])
    n += step;
  return "positive";
}
`;
    const recorder = new Recorder();
    const { sign } = loadSource(recorder, source);
    recorder.startScenario("app/s.test.ts::signs", "app/s.test.ts", ["signs"]);
    const answers = [sign(-1), sign(0), sign(5)];

    expect(instrument("app/sample.ts", source).functions[0]!.lines).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect([answers, describeScenario(recorder.finishScenario("passed"))]).toEqual([
      ["negative", "zero", "positive"],
      ["signs []", "  sign [2,3]", "  sign [2,4,5]", "  sign [2,4,6,7,8]"],
    ]);
  });

  test("outside a scenario the instrumented code just runs", () => {
    const recorder = new Recorder();
    const { Service } = load(recorder);

    expect(new Service(["a"]).lookup("q")).toBe("no q");
  });
});
