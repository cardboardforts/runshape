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
  const { code } = instrument("app/sample.ts", SAMPLE);
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

  test("outside a scenario the instrumented code just runs", () => {
    const recorder = new Recorder();
    const { Service } = load(recorder);

    expect(new Service(["a"]).lookup("q")).toBe("no q");
  });
});
