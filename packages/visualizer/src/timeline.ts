import { componentOf, externalComponent, FINE_GROUPING, FunctionRef, functionRef, Grouping, Phase, Role, Scenario, Span } from "@runshape/kernel";

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
  runs: [startUs: number, endUs: number][];
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
    bars.push({
      spanId: span.id,
      depth,
      startUs: span.startUs,
      endUs: Math.max(span.endUs, span.startUs),
      runs: span.runs.length > 0 ? span.runs : [[span.startUs, span.endUs]],
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
