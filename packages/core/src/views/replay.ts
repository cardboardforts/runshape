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
    });
  }
  // Stable: a call and the external call it makes in the same microsecond keep their order.
  return steps
    .map((s, index) => ({ s, index }))
    .sort((a, b) => a.s.tUs - b.s.tUs || a.index - b.index)
    .map(({ s }) => s);
}

function step(tUs: number, kind: StepKind, from: string, to: string, label: string, span: Span): ReplayStep {
  return { tUs, kind, from, to, edgeId: `${from}->${to}`, label, file: span.fn.file, line: span.fn.firstLine };
}
