import { Phase, Scenario, Span } from "../model";
import { componentOf, externalComponent, FINE_GROUPING, Grouping } from "./components";

export enum StepKind {
  Call = "call",
  Return = "return",
  External = "external",
}

/**
 * One hop of a scenario between two system-graph components, in time order. Played back,
 * the steps are the pulses of light travelling along the graph's edges. Calls within one
 * component are not hops; they show up in that component's function view instead.
 */
export interface ReplayStep {
  tUs: number;
  kind: StepKind;
  from: string;
  to: string;
  edgeId: string;
  label: string;
  /** Source location to highlight while this step plays, when it is project code. */
  file: string | null;
  line: number | null;
  /** The project object doing the work (self): the callee for calls and returns, the caller for external calls. */
  objectId: number | null;
}

export function buildReplay(
  scenario: Scenario,
  phases: Phase[] = [Phase.Call],
  grouping: Grouping = FINE_GROUPING,
): ReplayStep[] {
  const included = new Set(phases);
  const steps: ReplayStep[] = [];

  for (const span of scenario.spans) {
    if (!included.has(span.phase) || span.parent === null) continue;
    const from = componentOf(span.parent, grouping).id;
    const to = componentOf(span, grouping).id;
    if (from === to) continue;
    const label = span.request ? `${span.request.method} ${span.request.path}` : span.fn.qualname;
    steps.push(step(span.startUs, StepKind.Call, from, to, label, span));
    steps.push({ ...step(span.endUs, StepKind.Return, to, from, label, span), edgeId: `${from}->${to}` });
  }
  for (const call of scenario.boundaryCalls) {
    if (!included.has(call.phase) || call.caller === null) continue;
    const from = componentOf(call.caller, grouping).id;
    const to = externalComponent(call.system).id;
    steps.push({
      tUs: call.startUs,
      kind: StepKind.External,
      from,
      to,
      edgeId: `${from}->${to}`,
      label: call.statement ?? call.operation,
      file: call.caller.fn.file,
      line: call.caller.fn.firstLine,
      objectId: call.caller.obj?.id ?? null,
    });
  }
  // Stable: a call and the external call it makes in the same microsecond keep their order.
  return steps
    .map((s, index) => ({ s, index }))
    .sort((a, b) => a.s.tUs - b.s.tUs || a.index - b.index)
    .map(({ s }) => s);
}

function step(tUs: number, kind: StepKind, from: string, to: string, label: string, span: Span): ReplayStep {
  return { tUs, kind, from, to, edgeId: `${from}->${to}`, label, file: span.fn.file, line: span.fn.firstLine, objectId: span.obj?.id ?? null };
}

export enum ReplayPace {
  /** Every hop the same length: easiest to follow the path. */
  Even = "even",
  /** Each hop as long as the recording spent before the next one, log-compressed. */
  Recorded = "recorded",
}

export const EVEN_STEP_MS = 450;
const FASTEST_STEP_MS = 90;
/** Each tenfold of recorded time adds this much playback: 1 µs → 90 ms, 1 ms → 870 ms, 100 ms → 1.4 s. */
const MS_PER_DECADE = 260;
const SLOWEST_STEP_MS = 2500;

/** The time the app spent after step `index` before the next hop; the last step has none. */
export function gapAfterUs(steps: ReplayStep[], index: number): number | null {
  const next = steps[index + 1];
  const step = steps[index];
  return next && step ? Math.max(0, next.tUs - step.tUs) : null;
}

export function stepDurationsMs(steps: ReplayStep[], pace: ReplayPace): number[] {
  return steps.map((_, index) => {
    if (pace === ReplayPace.Even) return EVEN_STEP_MS;
    const gap = gapAfterUs(steps, index);
    if (gap === null) return EVEN_STEP_MS;
    const ms = FASTEST_STEP_MS + MS_PER_DECADE * Math.log10(Math.max(gap, 1));
    return Math.round(Math.min(SLOWEST_STEP_MS, ms));
  });
}

/** "742 µs", "3.1 ms", "1.20 s": the recorded gap after a step, for the replay bar. */
export function describeGap(steps: ReplayStep[], index: number): string {
  const gap = gapAfterUs(steps, index);
  return gap === null ? "end" : formatMicros(gap);
}

/** "742 µs", "3.1 ms", "12 ms", "1.20 s". */
export function formatMicros(us: number): string {
  if (us < 1000) return `${Math.round(us)} µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(us < 10_000 ? 1 : 0)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}
