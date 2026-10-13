import { Outcome, Phase, Role, Run, Scenario } from "../model";
import { componentOf, FINE_GROUPING, Grouping } from "./components";
import { buildReplay, StepKind } from "./replay";
import { RingRules } from "../rings";
import { buildSystemGraph, GraphEdge, GraphNode } from "./system-graph";

/**
 * What a code change did to behaviour: the same tests recorded before and after, compared
 * flow by flow. This is the review aid for a change you didn't write line by line (an AI
 * agent's, say): which requests now take a different route, touch the database
 * differently, or run different lines.
 */
export enum Change {
  Added = "added",
  Removed = "removed",
  Changed = "changed",
  Unchanged = "unchanged",
}

export interface DiffNode extends GraphNode {
  change: Change;
}

export interface DiffEdge extends GraphEdge {
  change: Change;
  callsBefore: number;
}

export interface FunctionChange {
  module: string;
  qualname: string;
  /** Lines (in the new code) whose statement didn't run before. */
  linesNowReached: number[];
  /** Lines (in the old code) whose statement no longer runs. */
  linesNoLongerReached: number[];
}

export interface ScenarioDiff {
  id: string;
  name: string;
  change: Change;
  outcomeBefore: Outcome | null;
  outcomeAfter: Outcome | null;
  hopsAdded: string[];
  hopsRemoved: string[];
  statementsAdded: string[];
  statementsRemoved: string[];
  functionsChanged: FunctionChange[];
}

export interface RunDiff {
  /** Reasons the two recordings may differ that have nothing to do with the code. */
  caveats: string[];
  nodes: DiffNode[];
  edges: DiffEdge[];
  scenarios: ScenarioDiff[];
}

export interface DiffOptions {
  phases?: Phase[];
  grouping?: Grouping;
  rules?: RingRules;
}

export function diffRuns(before: Run, after: Run, options: DiffOptions = {}): RunDiff {
  const phases = options.phases ?? [Phase.Call];
  const grouping = options.grouping ?? FINE_GROUPING;
  const rules = options.rules ?? RingRules.none();
  const graphBefore = buildSystemGraph(before, { phases, grouping, rules });
  const graphAfter = buildSystemGraph(after, { phases, grouping, rules });

  const nodes = mergeById(graphBefore.nodes, graphAfter.nodes, (node, change) => ({ ...node, change }));
  const edges = mergeById(graphBefore.edges, graphAfter.edges, (edge, change, previous) => ({
    ...edge,
    change,
    callsBefore: previous?.calls ?? 0,
  }));

  const scenarioIds = new Set([...before.scenarios.map((s) => s.nodeid), ...after.scenarios.map((s) => s.nodeid)]);
  const scenarios: ScenarioDiff[] = [];
  // Only catalogued functions: import-time module code that happened to run mid-request
  // isn't something a reviewer can act on.
  const catalogued = new Set([...before.catalog, ...after.catalog].map((fn) => `${fn.module}:${fn.qualname}`));
  for (const id of scenarioIds) {
    const [textBefore, textAfter] = lineTexts(before, after);
    scenarios.push(diffScenario(before.scenario(id) ?? null, after.scenario(id) ?? null, phases, grouping, catalogued, textBefore, textAfter));
  }
  return { caveats: caveatsFor(before, after), nodes, edges, scenarios };
}

function caveatsFor(before: Run, after: Run): string[] {
  const caveats: string[] = [];
  if (before.recorderVersion !== after.recorderVersion) {
    caveats.push(
      `Recorded by different recorder versions (${before.recorderVersion ?? "unknown"} → ${after.recorderVersion ?? "unknown"}); ` +
        "some differences may come from the recorder, not the code.",
    );
  }
  if (before.backend !== after.backend || before.python !== after.python) {
    caveats.push(`Recorded on different interpreters (${before.python}/${before.backend} → ${after.python}/${after.backend}).`);
  }
  return caveats;
}

function diffScenario(
  before: Scenario | null,
  after: Scenario | null,
  phases: Phase[],
  grouping: Grouping,
  catalogued: Set<string>,
  sourcesBefore: LineText,
  sourcesAfter: LineText,
): ScenarioDiff {
  const either = (after ?? before) as Scenario;
  const hops = differenceOfSets(hopsOf(before, phases, grouping), hopsOf(after, phases, grouping));
  const statements = differenceOfCounts(statementsOf(before, phases), statementsOf(after, phases));
  const functionsChanged = diffReachedLines(
    reachedLines(before, phases, sourcesBefore),
    reachedLines(after, phases, sourcesAfter),
  ).filter((fn) => catalogued.has(`${fn.module}:${fn.qualname}`));
  const outcomeBefore = before?.outcome ?? null;
  const outcomeAfter = after?.outcome ?? null;

  let change = Change.Unchanged;
  if (before === null) change = Change.Added;
  else if (after === null) change = Change.Removed;
  else if (
    outcomeBefore !== outcomeAfter ||
    hops.added.length + hops.removed.length + statements.added.length + statements.removed.length + functionsChanged.length > 0
  ) {
    change = Change.Changed;
  }

  return {
    id: either.nodeid,
    name: either.name,
    change,
    outcomeBefore,
    outcomeAfter,
    hopsAdded: hops.added,
    hopsRemoved: hops.removed,
    statementsAdded: statements.added,
    statementsRemoved: statements.removed,
    functionsChanged,
  };
}

/** "middleware -> ArticlesFeedAPIView": each distinct hop between components, by label. */
function hopsOf(scenario: Scenario | null, phases: Phase[], grouping: Grouping): Set<string> {
  const hops = new Set<string>();
  if (scenario === null) return hops;
  const labels = new Map<string, string>();
  for (const span of scenario.spans) {
    const ref = componentOf(span, grouping);
    labels.set(ref.id, ref.label);
  }
  for (const step of buildReplay(scenario, phases, grouping)) {
    if (step.kind === StepKind.Return) continue;
    const to = step.kind === StepKind.External ? step.to.replace(/^external:/, "") : (labels.get(step.to) ?? step.to);
    hops.add(`${labels.get(step.from) ?? step.from} -> ${to}`);
  }
  return hops;
}

/** SQL (or URL) text per external call, whitespace-normalised so reformatting isn't a change. */
function statementsOf(scenario: Scenario | null, phases: Phase[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (scenario === null) return counts;
  const included = new Set(phases);
  for (const call of scenario.boundaryCalls) {
    if (!included.has(call.phase)) continue;
    const text = `${call.system}: ${(call.statement ?? call.operation).replace(/\s+/g, " ").trim()}`;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

/**
 * How a reached line is identified: when both runs have source, its text plus which
 * occurrence of that text it is within the function ("return None#2"), so moving the
 * function doesn't count as a change but switching between two identical lines does.
 * Without source, its line number.
 */
type LineText = (file: string | null, line: number, functionFirstLine: number) => string;

function lineTexts(before: Run, after: Run): [LineText, LineText] {
  if (before.sources === null || after.sources === null) {
    const byNumber: LineText = (_file, line) => `line ${line}`;
    return [byNumber, byNumber];
  }
  const byText = (run: Run): LineText => (file, line, functionFirstLine) => {
    const text = file ? run.sourceLine(file, line)?.trim() : undefined;
    if (text === undefined || file === null) return `line ${line}`;
    let occurrence = 0;
    for (let other = functionFirstLine; other <= line; other += 1) {
      if (run.sourceLine(file, other)?.trim() === text) occurrence += 1;
    }
    return `${text}#${occurrence}`;
  };
  return [byText(before), byText(after)];
}

/**
 * Lines reached per project function, keyed by what the line says (see lineTexts), so a
 * function that moved, or had code inserted above it, isn't reported as changed.
 */
function reachedLines(scenario: Scenario | null, phases: Phase[], identify: LineText): Map<string, Map<string, number>> {
  const reached = new Map<string, Map<string, number>>();
  if (scenario === null) return reached;
  const included = new Set(phases);
  for (const span of scenario.spans) {
    if (!included.has(span.phase) || span.fn.role !== Role.Source) continue;
    const key = `${span.fn.module}:${span.fn.qualname}`;
    let lines = reached.get(key);
    if (lines === undefined) {
      lines = new Map();
      reached.set(key, lines);
    }
    for (const line of span.lines) lines.set(identify(span.fn.file, line, span.fn.firstLine), line);
  }
  return reached;
}

function diffReachedLines(before: Map<string, Map<string, number>>, after: Map<string, Map<string, number>>): FunctionChange[] {
  const changes: FunctionChange[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key) ?? new Map<string, number>();
    const now = after.get(key) ?? new Map<string, number>();
    const linesNowReached = [...now].filter(([text]) => !was.has(text)).map(([, line]) => line).sort((a, b) => a - b);
    const linesNoLongerReached = [...was].filter(([text]) => !now.has(text)).map(([, line]) => line).sort((a, b) => a - b);
    if (linesNowReached.length + linesNoLongerReached.length === 0) continue;
    const [module = "", qualname = ""] = key.split(":");
    changes.push({ module, qualname, linesNowReached, linesNoLongerReached });
  }
  return changes.sort((a, b) => `${a.module}.${a.qualname}`.localeCompare(`${b.module}.${b.qualname}`));
}

function differenceOfSets(before: Set<string>, after: Set<string>): { added: string[]; removed: string[] } {
  return {
    added: [...after].filter((item) => !before.has(item)).sort(),
    removed: [...before].filter((item) => !after.has(item)).sort(),
  };
}

/** Multiset difference: running the same query twice instead of once is a change. */
function differenceOfCounts(before: Map<string, number>, after: Map<string, number>): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(key) ?? 0) - (before.get(key) ?? 0);
    for (let i = 0; i < delta; i += 1) added.push(key);
    for (let i = 0; i < -delta; i += 1) removed.push(key);
  }
  return { added: added.sort(), removed: removed.sort() };
}

function mergeById<T extends { id: string; calls: number }, R>(
  before: T[],
  after: T[],
  make: (item: T, change: Change, previous: T | undefined) => R,
): R[] {
  const previous = new Map(before.map((item) => [item.id, item]));
  const merged: R[] = [];
  for (const item of after) {
    const old = previous.get(item.id);
    const change = old === undefined ? Change.Added : old.calls === item.calls ? Change.Unchanged : Change.Changed;
    merged.push(make(item, change, old));
    previous.delete(item.id);
  }
  for (const old of previous.values()) {
    merged.push(make(old, Change.Removed, old));
  }
  return merged;
}
