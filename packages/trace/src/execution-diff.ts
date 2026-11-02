import { align, Aligned } from "./align";
import { CallStep, CodeSymbol, ExecutionDiff, FINE_GROUPING, FunctionExecutionDiff, FunctionRef, functionRef, Grouping, MergedReplayStep, Op, Phase, renamedComponentId, ReplayStep, Role, Run, Scenario, Span, StatementStep, StepKind } from "@runshape/kernel";
import { Moves } from "./moves";
import { buildReplay } from "./replay";

/** Project code only: framework landmarks rarely change and would bury the calls that did. */
const PROJECT_ROLES = new Set([Role.Source, Role.Test]);

export function diffExecution(before: Scenario, after: Scenario, phases: Phase[] = [Phase.Call], moves: Moves = Moves.none()): ExecutionDiff {
  // Base calls are identified as head names their functions, so a moved function lines up with itself.
  const chains = new Map<string, number>();
  const aligned = align(callsOf(before, phases, moves.headKey, chains), callsOf(after, phases, (key) => key, chains), (call) => call.identity);
  const headKeys = aligned.steps.map((entry) => moves.headKey((entry.after ?? entry.before)!.symbol.key));
  const calls = aligned.steps.map((entry): CallStep => {
    const call = (entry.after ?? entry.before)!;
    const moved = entry.before !== null && entry.after !== null && entry.before.symbol.key !== entry.after.symbol.key;
    return {
      op: entry.op,
      depth: call.depth,
      symbol: functionRef(call.symbol),
      path: call.path,
      reparented: false,
      movedFrom: moved ? entry.before!.symbol.namespaceName.text : null,
    };
  });
  markReparented(calls, headKeys);
  return {
    scenarioId: after.nodeid,
    complete: aligned.complete,
    calls,
    added: calls.filter((call) => call.op === Op.Added).length,
    removed: calls.filter((call) => call.op === Op.Removed).length,
  };
}

/** Both replays as one timeline: shared hops once, then what each side did on its own. */
export function mergeReplays(
  before: Scenario,
  after: Scenario,
  phases: Phase[] = [Phase.Call],
  grouping: Grouping = FINE_GROUPING,
  moves: Moves = Moves.none(),
): MergedReplayStep[] {
  const hopKey = (step: ReplayStep) => `${step.kind}|${step.from}|${step.to}|${step.kind === StepKind.External ? step.label : ""}`;
  // The base's boxes under head's names, so a moved module's hops are the same hops.
  const headId = (id: string) => renamedComponentId(id, moves);
  // A return step's edge keeps the call's direction, so each end of the edge id is renamed in place.
  const beforeSteps = buildReplay(before, phases, grouping).map((step) => ({
    ...step,
    from: headId(step.from),
    to: headId(step.to),
    edgeId: step.edgeId.split("->").map(headId).join("->"),
  }));
  return align(beforeSteps, buildReplay(after, phases, grouping), hopKey).steps.map((entry) => ({
    op: entry.op,
    step: (entry.after ?? entry.before)!,
  }));
}

/** Pairs each added call with a removed call of the same function (by head's key), one for one. */
function markReparented(calls: CallStep[], headKeys: string[]): void {
  const removed = new Map<string, CallStep[]>();
  calls.forEach((call, index) => {
    if (call.op !== Op.Removed) return;
    removed.set(headKeys[index]!, [...(removed.get(headKeys[index]!) ?? []), call]);
  });
  calls.forEach((call, index) => {
    if (call.op !== Op.Added) return;
    const partner = removed.get(headKeys[index]!)?.shift();
    if (partner === undefined) return;
    partner.reparented = true;
    call.reparented = true;
  });
}

interface Call {
  depth: number;
  symbol: CodeSymbol;
  /** The chain of callers by name, to show. */
  path: string;
  /**
   * The same chain by symbol key, to line calls up: two functions sharing a name stay apart.
   * Numbered in `chains`, shared by both sides: the caller's chain's number and this key.
   */
  identity: number;
}

/** `keyOf` names a function for alignment: head's key for it, on the base side. */
function callsOf(scenario: Scenario, phases: Phase[], keyOf: (key: string) => string, chains: Map<string, number>): Call[] {
  const numbered = (chain: string): number => {
    let number = chains.get(chain);
    if (number === undefined) chains.set(chain, (number = chains.size));
    return number;
  };
  const included = new Set(phases);
  const calls: Call[] = [];
  const callOf = new Map<Span, Call>();
  for (const span of scenario.spans) {
    if (!included.has(span.phase) || !PROJECT_ROLES.has(span.fn.role)) continue;
    const parent = nearestProjectAncestor(span);
    const above = parent ? callOf.get(parent) : undefined;
    const { symbol } = span.fn;
    const call: Call = {
      depth: above ? above.depth + 1 : 0,
      symbol,
      path: above ? `${above.path} > ${symbol.localName.text}` : symbol.localName.text,
      // A key is JSON ("[[...") and never starts with a digit: a root key is no caller's chain.
      identity: numbered(above ? `${above.identity} ${keyOf(symbol.key)}` : keyOf(symbol.key)),
    };
    callOf.set(span, call);
    calls.push(call);
  }
  return calls;
}

function nearestProjectAncestor(span: Span): Span | null {
  for (let ancestor = span.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (PROJECT_ROLES.has(ancestor.fn.role)) return ancestor;
  }
  return null;
}

interface Statement {
  key: string;
  text: string;
  line: number | null;
}

const CALL_SEPARATOR = "──";

export function diffFunctionExecution(
  beforeRun: Run,
  afterRun: Run,
  scenarioId: string,
  symbol: CodeSymbol,
  phases: Phase[] = [Phase.Call],
  moves: Moves = Moves.none(),
): FunctionExecutionDiff {
  const matchedBy = beforeRun.sources !== null && afterRun.sources !== null ? "text" : "line-number";
  // `symbol` is head's name for the function; the base may have run it under its old one.
  const before = statementsOf(beforeRun, moves.baseScenarioId(scenarioId), symbol, phases, matchedBy, moves.headKey);
  const after = statementsOf(afterRun, scenarioId, symbol, phases, matchedBy, (key) => key);
  const aligned = align(before.statements, after.statements, (statement) => statement.key);
  const statements = aligned.steps.map(toStep);
  return {
    scenarioId,
    symbol: functionRef(symbol),
    matchedBy,
    complete: aligned.complete,
    callsBefore: before.calls,
    callsAfter: after.calls,
    fileBefore: before.file,
    fileAfter: after.file,
    statements,
  };
}

function toStep(entry: Aligned<Statement>): StatementStep {
  const statement = (entry.after ?? entry.before)!;
  return { op: entry.op, text: statement.text, beforeLine: entry.before?.line ?? null, afterLine: entry.after?.line ?? null };
}

/** Every call's executed lines in order (repeats collapsed), calls separated by a marker. */
function statementsOf(
  run: Run,
  scenarioId: string,
  symbol: CodeSymbol,
  phases: Phase[],
  matchedBy: FunctionExecutionDiff["matchedBy"],
  keyOf: (key: string) => string,
): { statements: Statement[]; calls: number; file: string | null } {
  const scenario = run.scenario(scenarioId);
  const included = new Set(phases);
  const statements: Statement[] = [];
  let calls = 0;
  let file: string | null = null;
  for (const span of scenario?.spans ?? []) {
    if (!included.has(span.phase) || keyOf(span.fn.symbol.key) !== symbol.key) continue;
    calls += 1;
    file = span.fn.file;
    if (calls > 1) statements.push({ key: CALL_SEPARATOR, text: `${CALL_SEPARATOR} call ${calls} ${CALL_SEPARATOR}`, line: null });
    let previous: number | null = null;
    for (const line of span.lines) {
      if (line === previous) continue;
      previous = line;
      const text = (span.fn.file ? run.sourceLine(span.fn.file, line) : null)?.trim() ?? `line ${line}`;
      statements.push({ key: matchedBy === "text" ? text : `line ${line}`, text, line });
    }
  }
  return { statements, calls, file };
}
