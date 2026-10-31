import { FunctionRef, Phase, Role, Run, Scenario, Span } from "@runshape/kernel";

import { Moves } from "./moves";
import { requestRouteLabel } from "./routes";
import { ChangedFunction, Threads } from "./threads";

/**
 * What a change costs at run time, per workflow and per changed function: time, calls,
 * queries, and how many distinct paths ran through the code. Counts are facts of the
 * recordings; times are one measurement each side, so they're only called out past a noise
 * band, and the bundle says how little one measurement can show.
 */

/** Each side is recorded once (PLAN.md Phase 4 wants a noise band measured by recording twice: not yet). */
export const RECORDINGS_PER_SIDE = 1;
/** A time change smaller than this isn't called out: one traced run jitters by milliseconds. */
export const TIME_NOISE_FLOOR_US = 10_000;
/** Nor one smaller than this share of the base's time: a slow test's jitter is bigger than a fast one's. */
export const TIME_NOISE_RATIO = 0.5;

/** One number on each side; null on a side that doesn't have the workflow. */
export interface Measure {
  before: number | null;
  after: number | null;
}

export enum TimeVerdict {
  /** Past both noise bands: worth a second recording to confirm. */
  Slower = "slower",
  Faster = "faster",
  WithinNoise = "within-noise",
  /** Recorded by a different recorder, backend or runtime: its overhead differs, so times don't compare. */
  NotComparable = "not-comparable",
  /** Only one side has it: nothing to compare. */
  OneSide = "one-side",
}

/** The requests a workflow made to one route, and the queries (external calls) made while serving them. */
export interface RouteCost {
  label: string;
  requests: Measure;
  queries: Measure;
}

export interface WorkflowCost {
  /** Head's id (the base's, when it's gone). */
  scenarioId: string;
  name: string;
  /** Wall time of the phases compared (the test body, by default), recorder overhead included. */
  timeUs: Measure;
  /** Calls into the project's own code (not tests, not framework). */
  calls: Measure;
  /** Calls to external systems: SQL, HTTP, whatever the recorder saw at a boundary. */
  queries: Measure;
  routes: RouteCost[];
  time: TimeVerdict;
}

export interface FunctionCost {
  symbol: FunctionRef;
  change: ChangedFunction["change"];
  /** Across every workflow: a side that doesn't have the function ran it 0 times. */
  calls: Measure;
  /** Time inside it, what it calls included (what its callers wait for); a recursive call isn't counted twice. */
  timeUs: Measure;
  /** Time in its own lines, what it calls left out: whether a slowdown is in this code or below it. */
  selfTimeUs: Measure;
  /** External calls made inside it or anything it called. */
  queries: Measure;
  /** Distinct paths that ran through it (complexity that actually ran, PLAN.md decision 4). */
  paths: Measure;
  time: TimeVerdict;
}

export interface CostDiff {
  recordingsPerSide: number;
  noiseFloorUs: number;
  noiseRatio: number;
  /** False when the two sides' recorders differ: no time is called out at all. */
  timeComparable: boolean;
  /** What the numbers can't show, in words: always at least the single recording. */
  caveats: string[];
  /** Every workflow on either side, costliest change first. */
  workflows: WorkflowCost[];
  /** The changed functions (the threads'), in the threads' order. */
  functions: FunctionCost[];
}

export function diffCost(base: Run, head: Run, threads: Threads, options: { phases?: Phase[]; moves?: Moves } = {}): CostDiff {
  const phases = new Set(options.phases ?? [Phase.Call]);
  const moves = options.moves ?? Moves.none();
  const timeComparable = sameRecorder(base, head);
  const verdict = (timeUs: Measure) => timeVerdict(timeUs, timeComparable);

  const before = new Map(base.scenarios.map((scenario) => [moves.headScenarioId(scenario.nodeid), scenario]));
  const after = new Map(head.scenarios.map((scenario) => [scenario.nodeid, scenario]));
  const workflows = [...new Set([...after.keys(), ...before.keys()])].map((id): WorkflowCost => {
    const [was, now] = [before.get(id), after.get(id)];
    const [costBefore, costAfter] = [was && scenarioCost(was, base, phases), now && scenarioCost(now, head, phases)];
    const timeUs = measure(costBefore?.timeUs, costAfter?.timeUs);
    const labels = [...new Set([...(costAfter?.routes.keys() ?? []), ...(costBefore?.routes.keys() ?? [])])].sort();
    return {
      scenarioId: id,
      name: (now ?? was)!.name,
      timeUs,
      calls: measure(costBefore?.calls, costAfter?.calls),
      queries: measure(costBefore?.queries, costAfter?.queries),
      routes: labels.map((label) => {
        const [routeBefore, routeAfter] = [costBefore?.routes.get(label), costAfter?.routes.get(label)];
        return { label, requests: measure(routeBefore?.requests ?? (was && 0), routeAfter?.requests ?? (now && 0)), queries: measure(routeBefore?.queries ?? (was && 0), routeAfter?.queries ?? (now && 0)) };
      }),
      time: verdict(timeUs),
    };
  });
  workflows.sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name));

  const keys = new Set(threads.functions.map((fn) => fn.symbol.key));
  const costBefore = functionCosts(base, phases, keys, moves.headKey);
  const costAfter = functionCosts(head, phases, keys, (key) => key);
  const functions = threads.functions.map((fn): FunctionCost => {
    const [was, now] = [costBefore.get(fn.symbol.key) ?? NOT_RUN, costAfter.get(fn.symbol.key) ?? NOT_RUN];
    const timeUs = { before: was.timeUs, after: now.timeUs };
    return {
      symbol: fn.symbol,
      change: fn.change,
      calls: { before: was.calls, after: now.calls },
      timeUs,
      selfTimeUs: { before: was.selfTimeUs, after: now.selfTimeUs },
      queries: { before: was.queries, after: now.queries },
      paths: { before: was.paths.size, after: now.paths.size },
      time: verdict(timeUs),
    };
  });

  return { recordingsPerSide: RECORDINGS_PER_SIDE, noiseFloorUs: TIME_NOISE_FLOOR_US, noiseRatio: TIME_NOISE_RATIO, timeComparable, caveats: costCaveats(base, head, timeComparable), workflows, functions };
}

/** Its calls, queries or routes' queries changed, or its time moved past the noise bands. */
export function workflowCostChanged(workflow: WorkflowCost): boolean {
  const differs = (m: Measure) => m.before !== null && m.after !== null && m.before !== m.after;
  return differs(workflow.calls) || differs(workflow.queries) || workflow.routes.some((route) => differs(route.queries)) || isTimeCallout(workflow.time);
}

/** A route whose queries changed, and the workflows whose requests to it changed alike: who waits. */
export interface RouteCostChange {
  label: string;
  requests: Measure;
  queries: Measure;
  workflows: { scenarioId: string; name: string }[];
}

/** Routes whose queries changed, one entry per route and change, in the workflows' order. */
export function routeCostChanges(workflows: WorkflowCost[]): RouteCostChange[] {
  const changes = new Map<string, RouteCostChange>();
  for (const workflow of workflows) {
    for (const route of workflow.routes) {
      const { before, after } = route.queries;
      if (before === null || after === null || before === after) continue;
      const key = JSON.stringify([route.label, route.requests, route.queries]);
      if (!changes.has(key)) changes.set(key, { label: route.label, requests: route.requests, queries: route.queries, workflows: [] });
      changes.get(key)!.workflows.push({ scenarioId: workflow.scenarioId, name: workflow.name });
    }
  }
  return [...changes.values()];
}

export function isTimeCallout(verdict: TimeVerdict): boolean {
  return verdict === TimeVerdict.Slower || verdict === TimeVerdict.Faster;
}

function timeVerdict({ before, after }: Measure, comparable: boolean): TimeVerdict {
  if (before === null || after === null) return TimeVerdict.OneSide;
  if (!comparable) return TimeVerdict.NotComparable;
  const change = after - before;
  // From nothing (a function the base never ran), any time past the floor is past the ratio too.
  const pastRatio = before === 0 ? change !== 0 : Math.abs(change) / before >= TIME_NOISE_RATIO;
  if (Math.abs(change) < TIME_NOISE_FLOOR_US || !pastRatio) return TimeVerdict.WithinNoise;
  return change > 0 ? TimeVerdict.Slower : TimeVerdict.Faster;
}

/** Recorder overhead is most of a traced call's time: it has to be the same overhead on both sides. */
function sameRecorder(base: Run, head: Run): boolean {
  return base.language === head.language && base.runtime === head.runtime && base.backend === head.backend && base.recorderVersion === head.recorderVersion;
}

function costCaveats(base: Run, head: Run, timeComparable: boolean): string[] {
  const floorMs = TIME_NOISE_FLOOR_US / 1000;
  const caveats = [
    `Each side was recorded once, so a time difference may be noise: one is called out only past both ${floorMs} ms and ${Math.round(TIME_NOISE_RATIO * 100)}%, and even then a second recording is what confirms it.`,
    `Times include the recorder's own overhead (${head.backend}), which isn't subtracted: code that makes many calls looks slower than it runs untraced. Call and query counts don't depend on timing.`,
  ];
  if (!timeComparable) {
    const side = (run: Run) => `${run.language} ${run.runtime}, ${run.backend}, recorder ${run.recorderVersion ?? "unknown"}`;
    caveats.push(`The two sides were recorded differently (${side(base)} vs ${side(head)}): their overheads differ, so no time is called out.`);
  }
  return caveats;
}

/** Biggest query change first (N+1 is the cost a reviewer misses), then calls, then a time callout. */
function weight(workflow: WorkflowCost): number {
  const delta = (m: Measure) => (m.before === null || m.after === null ? 0 : Math.abs(m.after - m.before));
  return delta(workflow.queries) * 1_000_000 + delta(workflow.calls) * 1_000 + (isTimeCallout(workflow.time) ? 1 : 0);
}

function measure(before: number | undefined, after: number | undefined): Measure {
  return { before: before ?? null, after: after ?? null };
}

interface ScenarioCost {
  timeUs: number;
  calls: number;
  queries: number;
  routes: Map<string, { requests: number; queries: number }>;
}

function scenarioCost(scenario: Scenario, run: Run, phases: Set<Phase>): ScenarioCost {
  const spans = scenario.spans.filter((span) => phases.has(span.phase));
  // The phase's outermost calls: a thread handed work is a child, so it isn't counted twice.
  const timeUs = spans.filter((span) => span.parent === null || !phases.has(span.parent.phase)).reduce((total, span) => total + span.endUs - span.startUs, 0);
  const queries = scenario.boundaryCalls.filter((call) => phases.has(call.phase));
  const routes = new Map<string, { requests: number; queries: number }>();
  const routeOf = (label: string) => {
    if (!routes.has(label)) routes.set(label, { requests: 0, queries: 0 });
    return routes.get(label)!;
  };
  const labels = new Map<Span, string>();
  for (const request of spans.filter((span) => span.request !== null)) {
    const label = requestRouteLabel(request, run.topology?.routes ?? []);
    labels.set(request, label);
    routeOf(label).requests += 1;
  }
  for (const query of queries) {
    const request = query.caller?.enclosingRequest();
    const label = request === null || request === undefined ? undefined : labels.get(request);
    if (label !== undefined) routeOf(label).queries += 1;
  }
  return { timeUs, calls: spans.filter((span) => span.fn.role === Role.Source).length, queries: queries.length, routes };
}

interface FunctionTally {
  calls: number;
  timeUs: number;
  selfTimeUs: number;
  queries: number;
  paths: Set<string>;
}

const NOT_RUN: FunctionTally = { calls: 0, timeUs: 0, selfTimeUs: 0, queries: 0, paths: new Set() };

/** Calls, time, queries and paths for each function in `keys` (head's keys), over every workflow. */
function functionCosts(run: Run, phases: Set<Phase>, keys: Set<string>, keyOf: (key: string) => string): Map<string, FunctionTally> {
  const tallies = new Map<string, FunctionTally>();
  const tally = (key: string) => {
    if (!tallies.has(key)) tallies.set(key, { calls: 0, timeUs: 0, selfTimeUs: 0, queries: 0, paths: new Set() });
    return tallies.get(key)!;
  };
  for (const scenario of run.scenarios) {
    for (const span of scenario.spans) {
      const key = keyOf(span.fn.symbol.key);
      if (!phases.has(span.phase) || !keys.has(key)) continue;
      const fn = tally(key);
      fn.calls += 1;
      const durationUs = span.endUs - span.startUs;
      if (!ancestorKeys(span.parent, keyOf).has(key)) fn.timeUs += durationUs;
      // A coroutine's children can overlap its own waits: never below nothing.
      fn.selfTimeUs += Math.max(0, durationUs - span.children.reduce((total, child) => total + child.endUs - child.startUs, 0));
      fn.paths.add(pathOf(run, span));
    }
    for (const query of scenario.boundaryCalls) {
      if (!phases.has(query.phase)) continue;
      for (const key of ancestorKeys(query.caller, keyOf)) if (keys.has(key)) tally(key).queries += 1;
    }
  }
  return tallies;
}

function ancestorKeys(from: Span | null, keyOf: (key: string) => string): Set<string> {
  const found = new Set<string>();
  for (let span = from; span !== null; span = span.parent) found.add(keyOf(span.fn.symbol.key));
  return found;
}

/**
 * One call's path, as the set of steps it took from line to line (entry and exit included): a
 * loop run three times or four takes the same steps, so iterations aren't paths; skipping the
 * loop, or taking the other branch, is. Lines are named by their text when the recording kept
 * its source, so code inserted above doesn't make every path new.
 */
function pathOf(run: Run, span: Span): string {
  const file = span.fn.file;
  const name = (line: number) => (file === null ? null : run.sourceLine(file, line)?.trim()) ?? `line ${line}`;
  const steps = new Set<string>();
  let previous = PATH_ENTRY;
  for (const line of span.lines) {
    const current = name(line);
    if (current === previous) continue;
    steps.add(`${previous}\n${current}`);
    previous = current;
  }
  steps.add(`${previous}\n${PATH_EXIT}`);
  return [...steps].sort().join("\n\n");
}

const PATH_ENTRY = "(entry)";
const PATH_EXIT = "(exit)";
