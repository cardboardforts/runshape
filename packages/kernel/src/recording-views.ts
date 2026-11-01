// What the viewer's panels show of one recording: a function's lines and the tests through
// them, a test as a timeline, objects and what holds them. The visualizer builds these; the
// UI only draws them, over the UI protocol.
import type { FunctionRef } from "./trace/model/function-ref";
import type { Outcome, Role } from "./trace/model/trace";

/**
 * One function's source with, for every line, the scenarios (tests) whose execution passed
 * through it — the "bundle of wires" view. Lines no scenario reached are untested; scenarios
 * that took exactly the same path are candidates for consolidation.
 */
export interface FunctionView {
  symbol: FunctionRef;
  file: string;
  firstLine: number;
  lastLine: number;
  lines: LineView[];
  scenarios: ScenarioPath[];
  samePathGroups: string[][];
  untestedLines: number[];
  executableLineCount: number;
}

export interface LineView {
  number: number;
  text: string;
  executable: boolean;
  scenarioIds: string[];
  hits: number;
}

export interface ScenarioPath {
  scenarioId: string;
  name: string;
  outcome: Outcome;
  calls: number;
  /** Distinct lines reached, ascending. */
  lines: number[];
  /** Lines in execution order for the first call, consecutive repeats collapsed. */
  firstCallPath: number[];
}

/** One call on the timeline: when it started and ended, and when it was actually running. */
export interface TimelineBar {
  spanId: number;
  /**
   * The bar's row: below its caller, and below any bar of its row it overlaps in time (an
   * async generator dependency stays open beside the handler it serves). 0 is the top.
   */
  depth: number;
  startUs: number;
  endUs: number;
  /** Running intervals; gaps between them are a coroutine awaiting. */
  runs: readonly [startUs: number, endUs: number][];
  label: string;
  componentId: string;
  role: Role;
  symbol: FunctionRef;
}

/** An external call (database, HTTP): an instant, under the call that made it. */
export interface TimelineMark {
  tUs: number;
  depth: number;
  componentId: string;
  label: string;
}

export interface Timeline {
  scenarioId: string;
  startUs: number;
  endUs: number;
  depth: number;
  bars: TimelineBar[];
  externals: TimelineMark[];
}

/**
 * Who holds a reference to whom, as recorded when each object's __init__ finished (the `W`
 * events). For constructor-injected code this is the composition root's wiring diagram,
 * observed rather than read: OrderService#1.repository -> SqlOrderRepository#0.
 */
export interface ObjectNode {
  /** The recording's object id, unique within one scenario. */
  id: number;
  componentId: string;
  className: string;
  /** The function that constructed it, e.g. "compose" or "get_repository.<locals>._get_repo"; null if built outside project code. */
  builtBy: string | null;
  /** When it appeared, in the scenario's microseconds: a replay shows it from then on. */
  seenUs: number;
}

export interface ObjectWire {
  from: number;
  to: number;
  attribute: string;
  /** When the holder's __init__ finished: a replay draws the wire from then on. */
  atUs: number;
}

export interface ObjectGraph {
  scenarioId: string;
  objects: ObjectNode[];
  wires: ObjectWire[];
}

/** Across every scenario: component A's objects hold component B's objects, via these attributes. */
export interface ComponentWiring {
  from: string;
  to: string;
  attributes: string[];
  /** How many object-to-object references were seen, over all scenarios. */
  references: number;
  scenarioIds: string[];
}
