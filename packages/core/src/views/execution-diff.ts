import { align, Aligned, Op } from "../align";
import { CodeSymbol, Phase, Role, Run, Scenario, Span } from "../model";
import { FINE_GROUPING, Grouping } from "./components";
import { buildReplay, ReplayStep, StepKind } from "./replay";

/**
 * How one test's execution changed between two recordings, matched by what ran rather than
 * where it sits in the file: calls by their path of qualified names, statements by their
 * text. A function that moved (or had code inserted above it) lines up with itself; a call
 * that now happens under a new parent shows as removed in one place and added in another.
 */
export interface CallStep {
  op: Op;
  depth: number;
  module: string;
  qualname: string;
  /** "test_x > create_new_article > get_slug_for_article": what identifies the call. */
  path: string;
  /** Set on a removed/added pair of the same function: it still runs, under a new caller. */
  reparented: boolean;
}

export interface ExecutionDiff {
  scenarioId: string;
  /** False when the two executions were too different to align (see align.ts). */
  complete: boolean;
  calls: CallStep[];
  added: number;
  removed: number;
}

export interface MergedReplayStep {
  op: Op;
  step: ReplayStep;
}

/** Project code only: framework landmarks rarely change and would bury the calls that did. */
const PROJECT_ROLES = new Set([Role.Source, Role.Test]);

export function diffExecution(before: Scenario, after: Scenario, phases: Phase[] = [Phase.Call]): ExecutionDiff {
  const aligned = align(callsOf(before, phases), callsOf(after, phases), (call) => call.path);
  const calls = aligned.steps.map((entry): CallStep => {
    const call = (entry.after ?? entry.before)!;
    return { op: entry.op, depth: call.depth, module: call.module, qualname: call.qualname, path: call.path, reparented: false };
  });
  markReparented(calls);
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
): MergedReplayStep[] {
  const hopKey = (step: ReplayStep) => `${step.kind}|${step.from}|${step.to}|${step.kind === StepKind.External ? step.label : ""}`;
  return align(buildReplay(before, phases, grouping), buildReplay(after, phases, grouping), hopKey).steps.map((entry) => ({
    op: entry.op,
    step: (entry.after ?? entry.before)!,
  }));
}

/** Pairs each added call with a removed call of the same function, one for one. */
function markReparented(calls: CallStep[]): void {
  const removed = new Map<string, CallStep[]>();
  for (const call of calls) {
    if (call.op !== Op.Removed) continue;
    const key = `${call.module}:${call.qualname}`;
    removed.set(key, [...(removed.get(key) ?? []), call]);
  }
  for (const call of calls) {
    if (call.op !== Op.Added) continue;
    const partner = removed.get(`${call.module}:${call.qualname}`)?.shift();
    if (partner === undefined) continue;
    partner.reparented = true;
    call.reparented = true;
  }
}

interface Call {
  depth: number;
  module: string;
  qualname: string;
  path: string;
}

function callsOf(scenario: Scenario, phases: Phase[]): Call[] {
  const included = new Set(phases);
  const calls: Call[] = [];
  const paths = new Map<Span, { path: string; depth: number }>();
  for (const span of scenario.spans) {
    if (!included.has(span.phase) || !PROJECT_ROLES.has(span.fn.role)) continue;
    const parent = nearestProjectAncestor(span);
    const above = parent ? paths.get(parent) : undefined;
    const path = above ? `${above.path} > ${span.fn.symbol.dottedPath}` : span.fn.symbol.dottedPath;
    const depth = above ? above.depth + 1 : 0;
    paths.set(span, { path, depth });
    calls.push({ depth, module: span.fn.symbol.dottedNamespace, qualname: span.fn.symbol.dottedPath, path });
  }
  return calls;
}

function nearestProjectAncestor(span: Span): Span | null {
  for (let ancestor = span.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (PROJECT_ROLES.has(ancestor.fn.role)) return ancestor;
  }
  return null;
}

/** One function in one test: the statements it executed, before against after, by their text. */
export interface StatementStep {
  op: Op;
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
}

export interface FunctionExecutionDiff {
  scenarioId: string;
  module: string;
  qualname: string;
  /** "text" when both recordings carry their source; otherwise line numbers stand in, and moves show as changes. */
  matchedBy: "text" | "line-number";
  /** False when the two were too different to align (see align.ts). */
  complete: boolean;
  callsBefore: number;
  callsAfter: number;
  fileBefore: string | null;
  fileAfter: string | null;
  statements: StatementStep[];
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
): FunctionExecutionDiff {
  const matchedBy = beforeRun.sources !== null && afterRun.sources !== null ? "text" : "line-number";
  const before = statementsOf(beforeRun, scenarioId, symbol, phases, matchedBy);
  const after = statementsOf(afterRun, scenarioId, symbol, phases, matchedBy);
  const aligned = align(before.statements, after.statements, (statement) => statement.key);
  const statements = aligned.steps.map(toStep);
  return {
    scenarioId,
    module: symbol.dottedNamespace,
    qualname: symbol.dottedPath,
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
): { statements: Statement[]; calls: number; file: string | null } {
  const scenario = run.scenario(scenarioId);
  const included = new Set(phases);
  const statements: Statement[] = [];
  let calls = 0;
  let file: string | null = null;
  for (const span of scenario?.spans ?? []) {
    if (!included.has(span.phase) || span.fn.symbol.key !== symbol.key) continue;
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
