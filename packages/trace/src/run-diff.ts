import { Change, CodeSymbol, ComparedGraphs, ComponentRef, componentOf, FINE_GROUPING, FunctionChange, functionRef, GraphNode, Grouping, Phase, renamedComponent, renamedComponentId, Renaming, Role, Run, RunDiff, Scenario, ScenarioDiff, Span } from "@runshape/kernel";
import { detectMoves, Moves } from "./moves";

export interface DiffOptions {
  phases?: Phase[];
  grouping?: Grouping;
  /** What moved between the runs; detected when not given. */
  moves?: Moves;
}

/** The runs compared, and their graphs as the arch module drew them for it (comparedGraphs). */
export function diffRuns(before: Run, after: Run, graphs: ComparedGraphs, options: DiffOptions = {}): RunDiff {
  const phases = options.phases ?? [Phase.Call];
  const grouping = options.grouping ?? FINE_GROUPING;
  const { before: graphBefore, after: graphAfter } = graphs;
  const moves = options.moves ?? detectMoves(before, after);
  // The base's boxes under head's names: a moved module is the same box, not one gone and one new.
  const baseBoxes = new BoxRenamer(moves);
  const headBoxes = new BoxRenamer(Moves.none());
  const headId = baseBoxes.id;
  // Code merged into a box that already existed: the base's boxes that now share an id are one.
  const nodesBefore = combined(
    graphBefore.nodes.map((node) => ({ ...node, id: headId(node.id) })),
    (into, node) => ({ ...into, calls: into.calls + node.calls, instances: into.instances + node.instances, scenarioIds: union(into.scenarioIds, node.scenarioIds) }),
  );
  const edgesBefore = combined(
    graphBefore.edges.map((edge) => ({ ...edge, id: `${headId(edge.from)}->${headId(edge.to)}`, from: headId(edge.from), to: headId(edge.to) })),
    (into, edge) => ({ ...into, calls: into.calls + edge.calls, scenarioIds: union(into.scenarioIds, edge.scenarioIds) }),
  );
  // The first of several boxes merged into one, as combined() keeps it: one before, consistently.
  const originalNodes = new Map<string, GraphNode>();
  for (const node of graphBefore.nodes) if (!originalNodes.has(headId(node.id))) originalNodes.set(headId(node.id), node);

  // A box only the base has keeps its own id, matching its name and label.
  const nodes = mergeById(nodesBefore, graphAfter.nodes, (node, change, previous) => ({
    ...(change === Change.Removed ? (originalNodes.get(node.id) ?? node) : node),
    // Called the same, placed elsewhere: changed all the same.
    change: change === Change.Unchanged && previous !== undefined && previous.zone !== node.zone ? Change.Changed : change,
    zoneBefore: previous?.zone ?? null,
  }));
  const edges = mergeById(edgesBefore, graphAfter.edges, (edge, change, previous) => ({
    ...edge,
    change,
    callsBefore: previous?.calls ?? 0,
  }));

  // A test whose file moved is one scenario, under head's id.
  const scenarioIds = new Set([...before.scenarios.map((s) => moves.headScenarioId(s.nodeid)), ...after.scenarios.map((s) => s.nodeid)]);
  const scenarios: ScenarioDiff[] = [];
  // Only catalogued functions: import-time module code that happened to run mid-request
  // isn't something a reviewer can act on.
  const catalogued = new Set([...before.catalog.map((fn) => moves.headKey(fn.symbol.key)), ...after.catalog.map((fn) => fn.symbol.key)]);
  const [textBefore, textAfter] = lineTexts(before, after);
  const scenariosBefore = firstById(before.scenarios);
  const scenariosAfter = firstById(after.scenarios);
  for (const id of scenarioIds) {
    const beforeSide: Side = { scenario: scenariosBefore.get(moves.baseScenarioId(id)) ?? null, boxes: baseBoxes, lineText: textBefore, headKey: moves.headKey };
    const afterSide: Side = { scenario: scenariosAfter.get(id) ?? null, boxes: headBoxes, lineText: textAfter, headKey: (key) => key };
    scenarios.push(diffScenario(beforeSide, afterSide, phases, grouping, catalogued));
  }
  return { caveats: caveatsFor(before, after), nodes, edges, scenarios, profile: graphAfter.profile, moved: moves.describe() };
}

function caveatsFor(before: Run, after: Run): string[] {
  const caveats: string[] = [];
  if (before.recorderVersion !== after.recorderVersion) {
    caveats.push(
      `Recorded by different recorder versions (${before.recorderVersion ?? "unknown"} → ${after.recorderVersion ?? "unknown"}); ` +
        "some differences may come from the recorder, not the code.",
    );
  }
  if (before.backend !== after.backend || before.runtime !== after.runtime) {
    caveats.push(`Recorded on different interpreters (${before.runtime}/${before.backend} → ${after.runtime}/${after.backend}).`);
  }
  return caveats;
}

/** One side of a scenario's comparison, and how to read its names as head's. */
interface Side {
  scenario: Scenario | null;
  boxes: BoxRenamer;
  lineText: LineText;
  /** A CodeSymbol.key as head names that function. */
  headKey: (key: string) => string;
}

/** As Run.scenario(id), the first with that id, without a scan per lookup. */
function firstById(scenarios: Scenario[]): Map<string, Scenario> {
  const byId = new Map<string, Scenario>();
  for (const scenario of scenarios) if (!byId.has(scenario.nodeid)) byId.set(scenario.nodeid, scenario);
  return byId;
}

function diffScenario(beforeSide: Side, afterSide: Side, phases: Phase[], grouping: Grouping, catalogued: Set<string>): ScenarioDiff {
  const before = beforeSide.scenario;
  const after = afterSide.scenario;
  const either = (after ?? before) as Scenario;
  const hops = differenceOfSets(hopsOf(before, phases, grouping, beforeSide.boxes), hopsOf(after, phases, grouping, afterSide.boxes));
  const statements = differenceOfCounts(statementsOf(before, phases), statementsOf(after, phases));
  const functionsChanged = diffReachedLines(
    reachedLines(before, phases, beforeSide.lineText, beforeSide.headKey),
    reachedLines(after, phases, afterSide.lineText, afterSide.headKey),
    catalogued,
  );
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

/**
 * "middleware -> ArticlesFeedAPIView": each distinct hop between components, by label. The
 * replay's call and external steps (buildReplay), read from the spans: a set of hops needs
 * neither the replay's order nor its labels. `boxes` renames the base's boxes as head names them.
 */
function hopsOf(scenario: Scenario | null, phases: Phase[], grouping: Grouping, boxes: BoxRenamer): Set<string> {
  const hops = new Set<string>();
  if (scenario === null) return hops;
  // A parent's box is asked for once per child: worked out once per span.
  const components = new Map<Span, ComponentRef>();
  const component = (span: Span): ComponentRef => {
    let ref = components.get(span);
    if (ref === undefined) {
      ref = componentOf(span, grouping);
      components.set(span, ref);
    }
    return ref;
  };
  const labels = new Map<string, string>();
  for (const span of scenario.spans) {
    const ref = boxes.component(component(span));
    labels.set(ref.id, ref.label);
  }
  const label = (id: string) => labels.get(id) ?? id;
  const included = new Set(phases);
  for (const span of scenario.spans) {
    if (!included.has(span.phase) || span.parent === null) continue;
    const from = component(span.parent).id;
    const to = component(span).id;
    if (from === to) continue;
    hops.add(`${label(boxes.id(from))} -> ${label(boxes.id(to))}`);
  }
  for (const call of scenario.boundaryCalls) {
    if (!included.has(call.phase) || call.caller === null) continue;
    hops.add(`${label(boxes.id(component(call.caller).id))} -> ${label(call.system)}`);
  }
  return hops;
}

/**
 * One side's boxes under head's names, each renamed once per comparison: every scenario of a
 * run meets the same few hundred boxes.
 */
class BoxRenamer {
  private readonly ids = new Map<string, string>();
  private readonly components = new Map<string, ComponentRef>();

  constructor(private readonly renaming: Renaming) {}

  id = (id: string): string => {
    let renamed = this.ids.get(id);
    if (renamed === undefined) {
      renamed = renamedComponentId(id, this.renaming);
      this.ids.set(id, renamed);
    }
    return renamed;
  };

  /** Keyed by id: a box's id is its kind and its name's text, all renamedComponent reads. */
  component(ref: ComponentRef): ComponentRef {
    let renamed = this.components.get(ref.id);
    if (renamed === undefined) {
      renamed = renamedComponent(ref, this.renaming);
      this.components.set(ref.id, renamed);
    }
    return renamed;
  }
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
  return [remembered(byText(before)), remembered(byText(after))];
}

/**
 * Each line worked out once per run: a function's lines are met again in every span of it, in
 * every scenario, and counting a line's occurrences reads the function from its top.
 */
function remembered(lineText: LineText): LineText {
  const byFile = new Map<string | null, Map<number, Map<number, string>>>();
  return (file, line, functionFirstLine) => {
    let byFunction = byFile.get(file);
    if (byFunction === undefined) byFile.set(file, (byFunction = new Map()));
    let byLine = byFunction.get(functionFirstLine);
    if (byLine === undefined) byFunction.set(functionFirstLine, (byLine = new Map()));
    let text = byLine.get(line);
    if (text === undefined) byLine.set(line, (text = lineText(file, line, functionFirstLine)));
    return text;
  };
}

/**
 * Lines reached per project function, keyed by what the line says (see lineTexts), so a
 * function that moved, or had code inserted above it, isn't reported as changed.
 */
/** Keyed by `keyOf(CodeSymbol.key)`: head's key for a function, on the base side. */
function reachedLines(scenario: Scenario | null, phases: Phase[], identify: LineText, keyOf: (key: string) => string): Map<string, ReachedLines> {
  const reached = new Map<string, ReachedLines>();
  if (scenario === null) return reached;
  const included = new Set(phases);
  for (const span of scenario.spans) {
    if (!included.has(span.phase) || span.fn.role !== Role.Source) continue;
    let entry = reached.get(keyOf(span.fn.symbol.key));
    if (entry === undefined) {
      entry = { symbol: span.fn.symbol, lines: new Map() };
      reached.set(keyOf(span.fn.symbol.key), entry);
    }
    for (const line of span.lines) entry.lines.set(identify(span.fn.file, line, span.fn.firstLine), line);
  }
  return reached;
}

/** A function's reached lines in one scenario: line text -> line number. */
interface ReachedLines {
  symbol: CodeSymbol;
  lines: Map<string, number>;
}

function diffReachedLines(before: Map<string, ReachedLines>, after: Map<string, ReachedLines>, catalogued: Set<string>): FunctionChange[] {
  const changes: FunctionChange[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (!catalogued.has(key)) continue;
    const symbol = (after.get(key) ?? before.get(key))!.symbol;
    const was = before.get(key)?.lines ?? new Map<string, number>();
    const now = after.get(key)?.lines ?? new Map<string, number>();
    const linesNowReached = [...now].filter(([text]) => !was.has(text)).map(([, line]) => line).sort((a, b) => a - b);
    const linesNoLongerReached = [...was].filter(([text]) => !now.has(text)).map(([, line]) => line).sort((a, b) => a - b);
    if (linesNowReached.length + linesNoLongerReached.length === 0) continue;
    changes.push({ symbol: functionRef(symbol), linesNowReached, linesNoLongerReached });
  }
  return changes.sort((a, b) => `${a.symbol.namespace}.${a.symbol.path}`.localeCompare(`${b.symbol.namespace}.${b.symbol.path}`));
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

/** Items sharing an id, merged with `merge`, in first-seen order. */
function combined<T extends { id: string }>(items: T[], merge: (into: T, item: T) => T): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const existing = byId.get(item.id);
    byId.set(item.id, existing === undefined ? item : merge(existing, item));
  }
  return [...byId.values()];
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
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
