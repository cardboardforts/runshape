import { componentOf, externalComponent, FINE_GROUPING, FunctionRef, functionRef, Grouping, Phase, Role, Scenario, Span, Timeline, TimelineBar, TimelineMark } from "@runshape/kernel";

/** A scenario's calls laid out over time (a flame chart), for the phases asked for. */
export function buildTimeline(scenario: Scenario, phases: Phase[] = [Phase.Call], grouping: Grouping = FINE_GROUPING): Timeline {
  const included = new Set(phases);
  const depthOf = new Map<Span, number>();
  /** The latest end of any bar placed on each row so far; bars are placed in start order. */
  const rowBusyUntil: number[] = [];
  const bars: TimelineBar[] = [];
  const spans = scenario.spans.filter((span) => included.has(span.phase)).sort((a, b) => a.startUs - b.startUs || a.id - b.id);
  for (const span of spans) {
    let depth = nearestShownAncestor(span, depthOf) + 1;
    while ((rowBusyUntil[depth] ?? -Infinity) > span.startUs) depth += 1;
    rowBusyUntil[depth] = Math.max(rowBusyUntil[depth] ?? -Infinity, span.endUs);
    depthOf.set(span, depth);
    // A getter that builds a list for a plain call: read once.
    const runs = span.runs;
    bars.push({
      spanId: span.id,
      depth,
      startUs: span.startUs,
      endUs: Math.max(span.endUs, span.startUs),
      runs: runs.length > 0 ? runs : [[span.startUs, span.endUs]],
      label: span.request ? `${span.request.method} ${span.request.path}` : span.fn.symbol.localName.text,
      componentId: componentOf(span, grouping).id,
      role: span.fn.role,
      symbol: functionRef(span.fn.symbol),
    });
  }
  const externals: TimelineMark[] = [];
  for (const call of scenario.boundaryCalls) {
    if (!included.has(call.phase) || call.caller === null) continue;
    externals.push({
      tUs: call.startUs,
      depth: (depthOf.get(call.caller) ?? -1) + 1,
      componentId: externalComponent(call.system).id,
      label: `${call.system}: ${call.statement ?? call.operation}`,
    });
  }
  const times = [...bars.flatMap((bar) => [bar.startUs, bar.endUs]), ...externals.map((mark) => mark.tUs)];
  return {
    scenarioId: scenario.nodeid,
    startUs: times.length ? Math.min(...times) : 0,
    endUs: times.length ? Math.max(...times) : 0,
    depth: Math.max(0, ...bars.map((bar) => bar.depth + 1), ...externals.map((mark) => mark.depth + 1)),
    bars,
    externals,
  };
}

function nearestShownAncestor(span: Span, depthOf: Map<Span, number>): number {
  for (let ancestor = span.parent; ancestor !== null; ancestor = ancestor.parent) {
    const depth = depthOf.get(ancestor);
    if (depth !== undefined) return depth;
  }
  return -1;
}
