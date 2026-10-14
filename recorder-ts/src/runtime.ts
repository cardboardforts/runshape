// What instrumented code calls (as globalThis.__runshape): spans, lines, objects and wiring,
// collected per scenario (one test) into trace format version 2 (docs/trace-format.md).
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export interface SymbolDto {
  namespace: string[];
  container: string[];
  name: string;
  kind: "function" | "method" | "constructor" | "initializer" | "nested";
  ownerType: string | null;
}

export interface FunctionDto {
  role: "source" | "test";
  symbol: SymbolDto;
  file: string | null;
  firstLine: number;
  landmarkKind: null;
}

export type EventDto =
  | ["P", number, string]
  | ["S", number, number, number, number | null, number, number | null]
  | ["X", number, number]
  | ["L", number, number]
  | ["O", number, number, string[], number | null]
  | ["W", number, number, string, number];

export interface ScenarioDto {
  nodeid: string;
  outcome: string;
  durationUs: number;
  functions: FunctionDto[];
  events: EventDto[];
  recorderErrors: string[];
}

/** Everything runs on one thread here; the format still has the field. */
const MAIN_THREAD = 0;
/** The span of a call that isn't recorded: nothing under it is either. */
const NOT_RECORDED = -1;

/**
 * What AsyncLocalStorage holds while a function runs: its call, and the calls it runs inside.
 * A line mark walks up to its own function's frame; a frame from a finished scenario is ignored.
 */
interface Frame {
  scenario: Scenario;
  span: number;
  fn: number;
  parent: Frame | null;
}

export interface Limits {
  /** Calls of one function from one calling span that are recorded; later ones are counted. */
  callsPerCaller: number;
  /** After this many events, a scenario records nothing more and says so. */
  eventsPerScenario: number;
}

/** Enough for any test's real paths; a loop over thousands of items is kept to its first calls. */
export const DEFAULT_LIMITS: Limits = { callsPerCaller: 50, eventsPerScenario: 500_000 };

class Scenario {
  readonly events: EventDto[] = [];
  readonly functions: FunctionDto[] = [];
  readonly rootSpan = 0;
  private readonly localIndex = new Map<number, number>();
  private readonly objectIds = new WeakMap<object, number>();
  private readonly wired = new Set<string>();
  /** Lines each open span has recorded: a line is recorded once per call. */
  private readonly linesBySpan = new Map<number, Set<number>>();
  /** "caller span:function" -> calls seen, recorded or not. */
  private readonly callsByCaller = new Map<string, number>();
  private readonly skipped = new Map<string, { calls: number; caller: number; fn: number }>();
  private full = false;
  private droppedWhenFull = 0;
  private nextSpan = 1;
  private nextObject = 1;
  private readonly startedAt = performance.now();

  constructor(
    readonly nodeid: string,
    private readonly registry: FunctionDto[],
    private readonly classes: WeakMap<Function, string[]>,
    private readonly limits: Limits,
  ) {}

  /** Whether a call of `fn` from `parent` is recorded; counts the ones that aren't. */
  admits(parent: number, fn: number): boolean {
    if (this.isFull()) {
      this.droppedWhenFull += 1;
      return false;
    }
    const key = `${parent}:${fn}`;
    const calls = (this.callsByCaller.get(key) ?? 0) + 1;
    this.callsByCaller.set(key, calls);
    if (calls <= this.limits.callsPerCaller) return true;
    const skipped = this.skipped.get(key) ?? { calls: 0, caller: parent, fn };
    skipped.calls += 1;
    this.skipped.set(key, skipped);
    return false;
  }

  line(span: number, line: number): void {
    let lines = this.linesBySpan.get(span);
    if (lines === undefined) {
      lines = new Set();
      this.linesBySpan.set(span, lines);
    }
    if (lines.has(line) || this.isFull()) return;
    lines.add(line);
    this.events.push(["L", span, line]);
  }

  ended(span: number): void {
    this.linesBySpan.delete(span);
  }

  /** What the limits left out, in words, for recorderErrors. */
  omissions(nameOfSpan: (span: number) => string): string[] {
    const notes = [...this.skipped.values()].map(
      ({ calls, caller, fn }) =>
        `${calls} more calls of ${nameOf(this.registry[fn]!.symbol)} from ${nameOfSpan(caller)} were not recorded (limit ${this.limits.callsPerCaller} per caller)`,
    );
    if (this.full) notes.push(`stopped recording after ${this.limits.eventsPerScenario} events: ${this.droppedWhenFull} later calls were not recorded`);
    return notes;
  }

  private isFull(): boolean {
    if (this.events.length >= this.limits.eventsPerScenario) this.full = true;
    return this.full;
  }

  now(): number {
    return Math.round((performance.now() - this.startedAt) * 1000);
  }

  newSpan(): number {
    return this.nextSpan++;
  }

  local(globalId: number): number {
    let index = this.localIndex.get(globalId);
    if (index === undefined) {
      index = this.functions.push(this.registry[globalId]!) - 1;
      this.localIndex.set(globalId, index);
    }
    return index;
  }

  /** The id of a project object (an instance of a catalogued class), seen for the first time now if new. */
  objectId(value: unknown, builtBy: number | null = null): number | null {
    if (typeof value !== "object" || value === null) return null;
    const known = this.objectIds.get(value);
    if (known !== undefined) return known;
    const type = this.classes.get(value.constructor);
    if (type === undefined || this.isFull()) return null;
    const id = this.nextObject++;
    this.objectIds.set(value, id);
    this.events.push(["O", this.now(), id, type, builtBy]);
    return id;
  }

  /** A constructor finished: the object exists, and its fields say what it was wired to. */
  built(value: object, span: number): void {
    const id = this.objectId(value, span);
    if (id === null) return;
    // Data fields only: reading an accessor would run the app's code, outside any span.
    for (const [attribute, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor)) continue;
      const target = this.objectId(descriptor.value);
      if (target === null || this.wired.has(`${id}.${attribute}`) || this.isFull()) continue;
      this.wired.add(`${id}.${attribute}`);
      this.events.push(["W", this.now(), id, attribute, target]);
    }
  }
}

function nameOf(symbol: SymbolDto): string {
  return [...symbol.container, symbol.name].join(".");
}

export class Recorder {
  private readonly registry: FunctionDto[] = [];
  private readonly classes = new WeakMap<Function, string[]>();
  private readonly current = new AsyncLocalStorage<Frame>();
  private scenario: Scenario | null = null;

  constructor(private readonly limits: Limits = DEFAULT_LIMITS) {}

  /** Called once per instrumented module: its functions, in catalog order; returns their ids. */
  functions(entries: { symbol: SymbolDto; file: string; firstLine: number }[]): number[] {
    return entries.map((entry) => this.registry.push({ role: "source", landmarkKind: null, ...entry }) - 1);
  }

  /** A catalogued class, so its instances are recorded as project objects. */
  cls(type: Function, segments: string[]): void {
    this.classes.set(type, segments);
  }

  run<T>(fn: number, receiver: unknown, body: () => T, built?: () => object): T {
    const scenario = this.scenario;
    if (scenario === null) return body();
    const frame = this.open(scenario, fn, receiver);
    if (frame.span === NOT_RECORDED) return this.current.run(frame, body);
    let completed = false;
    try {
      const result = this.current.run(frame, body);
      completed = true;
      return result;
    } finally {
      // A constructor that threw built nothing, though `this` existed.
      this.close(scenario, frame.span, completed ? built : undefined);
    }
  }

  /** As run, but the span lasts until the returned promise settles. */
  runAsync<T>(fn: number, receiver: unknown, body: () => Promise<T>): Promise<T> {
    const scenario = this.scenario;
    if (scenario === null) return body();
    const frame = this.open(scenario, fn, receiver);
    if (frame.span === NOT_RECORDED) return this.current.run(frame, body);
    return this.current.run(frame, body).finally(() => this.close(scenario, frame.span));
  }

  /** Line `line` of function `fn` ran: recorded on fn's innermost call in progress, if any. */
  l(line: number, fn: number): void {
    const scenario = this.scenario;
    let frame = this.current.getStore() ?? null;
    if (scenario === null || frame === null || frame.scenario !== scenario) return;
    while (frame !== null && frame.fn !== fn) frame = frame.parent;
    if (frame !== null && frame.span !== NOT_RECORDED) scenario.line(frame.span, line);
  }

  /** `path` is the test's describe blocks and name. */
  startScenario(nodeid: string, testFile: string, path: string[]): void {
    const scenario = new Scenario(nodeid, this.registry, this.classes, this.limits);
    const symbol: SymbolDto = {
      namespace: testFile.replace(/\.[cm]?[jt]sx?$/, "").split("/"),
      container: path.slice(0, -1),
      name: path.at(-1) ?? nodeid,
      kind: "function",
      ownerType: null,
    };
    const testFunction = this.registry.push({ role: "test", symbol, file: testFile, firstLine: 1, landmarkKind: null }) - 1;
    scenario.events.push(["P", 0, "call"]);
    scenario.events.push(["S", 0, scenario.rootSpan, scenario.local(testFunction), null, MAIN_THREAD, null]);
    this.scenario = scenario;
  }

  finishScenario(outcome: string): ScenarioDto {
    const scenario = this.scenario;
    if (scenario === null) throw new Error("runshape: no scenario to finish");
    this.scenario = null;
    const durationUs = scenario.now();
    scenario.events.push(["X", durationUs, scenario.rootSpan]);
    const functionOfSpan = new Map<number, number>();
    for (const event of scenario.events) if (event[0] === "S") functionOfSpan.set(event[2], event[3]);
    const nameOfSpan = (span: number) => nameOf(scenario.functions[functionOfSpan.get(span)!]!.symbol);
    return {
      nodeid: scenario.nodeid,
      outcome,
      durationUs,
      functions: scenario.functions,
      events: scenario.events,
      recorderErrors: scenario.omissions(nameOfSpan),
    };
  }

  private open(scenario: Scenario, fn: number, receiver: unknown): Frame {
    const parent = this.current.getStore() ?? null;
    // Work a finished test left running (an un-awaited promise) belongs to no scenario.
    const leftOver = parent !== null && parent.scenario !== scenario;
    const parentSpan = parent === null ? scenario.rootSpan : parent.span;
    if (leftOver || parentSpan === NOT_RECORDED || !scenario.admits(parentSpan, fn)) {
      return { scenario, span: NOT_RECORDED, fn, parent };
    }
    const span = scenario.newSpan();
    scenario.events.push(["S", scenario.now(), span, scenario.local(fn), parentSpan, MAIN_THREAD, scenario.objectId(receiver)]);
    return { scenario, span, fn, parent };
  }

  private close(scenario: Scenario, span: number, built?: () => object): void {
    if (built !== undefined) {
      try {
        scenario.built(built(), span);
      } catch {
        // The constructor threw before `this` existed (or before super() ran): nothing was built.
      }
    }
    scenario.events.push(["X", scenario.now(), span]);
    scenario.ended(span);
  }
}
