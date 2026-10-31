import { componentOf, externalComponent, FINE_GROUPING, Grouping, Phase, ReplayStep, Scenario, Span, StepKind } from "@runshape/kernel";

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
    const label = span.request ? `${span.request.method} ${span.request.path}` : span.fn.symbol.localName.text;
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

