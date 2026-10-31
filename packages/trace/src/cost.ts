import { FunctionRef, Phase, Role, Run, Scenario, Span } from "@runshape/kernel";

import { Moves } from "./moves";
import { requestRouteLabel } from "./routes";
import { ChangedFunction, Threads } from "./threads";

/**
 * What a change costs at run time, per workflow and per changed function: time, calls,
 * external calls, and how many distinct paths ran through the code. Counts are facts of the
 * recordings; times are one measurement each side, so they're only called out past a noise
 * band, and the bundle says how little one measurement can show.
 */

/** Each side is recorded once (PLAN.md Phase 4 wants a noise band measured by recording twice: not yet). */
export const RECORDINGS_PER_SIDE = 1;
/** A time change smaller than this isn't called out: one traced run jitters by milliseconds. */
export const TIME_NOISE_FLOOR_US = 10_000;
/** Nor one smaller than this share of the base's time: a slow test's jitter is bigger than a fast one's. */
export const TIME_NOISE_RATIO = 0.5;

/** One number on each side; null on a side that doesn't have it. */
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
  /** Only one side has it (or ran it): nothing to compare. */
  OneSide = "one-side",
}

/** Which recordings have a workflow: only the ones both have are compared. */
export enum WorkflowSides {
  Both = "both",
  New = "new",
  Gone = "gone",
}

/** The requests a workflow made to one route, and the external calls made while serving them. */
export interface RouteCost {
  label: string;
  requests: Measure;
  externalCalls: Measure;
}

export interface WorkflowCost {
  /** Head's id (the base's, when it's gone). */
  scenarioId: string;
  name: string;
  sides: WorkflowSides;
  /** Wall time of the phases compared (the test body, by default), recorder overhead included. */
  timeUs: Measure;
  /** Calls into the project's own code (not tests, not framework). */
  calls: Measure;
  /** Calls to external systems (SQL, HTTP, whatever the recorder saw at a boundary). */
  externalCalls: Measure;
  routes: RouteCost[];
  time: TimeVerdict;
}

export interface FunctionCost {
  symbol: FunctionRef;
  change: ChangedFunction["change"];
  /** Across every workflow: a side that doesn't have the function ran it 0 times. */
  calls: Measure;
  /** Time inside it over every workflow, what it calls included; null on a side that never ran it. */
  timeUs: Measure;
  /** The same per call (a recursive call counted once): what the verdict is on, so more callers isn't "slower". */
  timePerCallUs: Measure;
  /** Time in its own lines per call, what it calls left out: whether a slowdown is in this code or below it. */
  selfTimePerCallUs: Measure;
  /** External calls made inside it or anything it called. */
  externalCalls: Measure;
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
  // Retried tests: every count below is of the last attempt, on both sides alike.
  const [baseAttempts, headAttempts] = [lastAttempts(base), lastAttempts(head)];

  const before = new Map([...baseAttempts.scenarios].map((scenario) => [moves.headScenarioId(scenario.nodeid), scenario]));
  const after = new Map([...headAttempts.scenarios].map((scenario) => [scenario.nodeid, scenario]));
  const workflows = [...new Set([...after.keys(), ...before.keys()])].map((id): WorkflowCost => {
    const [was, now] = [before.get(id), after.get(id)];
    const [costBefore, costAfter] = [was && scenarioCost(was, base, phases), now && scenarioCost(now, head, phases)];
    const timeUs = measure(costBefore?.timeUs, costAfter?.timeUs);
    const labels = [...new Set([...(costAfter?.routes.keys() ?? []), ...(costBefore?.routes.keys() ?? [])])].sort();
    return {
      scenarioId: id,
      name: (now ?? was)!.name,
      sides: was === undefined ? WorkflowSides.New : now === undefined ? WorkflowSides.Gone : WorkflowSides.Both,
      timeUs,
      calls: measure(costBefore?.calls, costAfter?.calls),
      externalCalls: measure(costBefore?.externalCalls, costAfter?.externalCalls),
      routes: labels.map((label) => {
        const [routeBefore, routeAfter] = [costBefore?.routes.get(label), costAfter?.routes.get(label)];
        return {
          label,
          requests: measure(routeBefore?.requests ?? (was && 0), routeAfter?.requests ?? (now && 0)),
          externalCalls: measure(routeBefore?.externalCalls ?? (was && 0), routeAfter?.externalCalls ?? (now && 0)),
        };
      }),
      time: verdict(timeUs),
    };
  });
  workflows.sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name));

  const keys = new Set(threads.functions.map((fn) => fn.symbol.key));
  // Lines are named by text only when both sides can: otherwise the same line has two names.
  const byText = base.sources !== null && head.sources !== null;
  const costBefore = functionCosts(base, baseAttempts.scenarios, phases, keys, moves.headKey, byText);
  const costAfter = functionCosts(head, headAttempts.scenarios, phases, keys, (key) => key, byText);
  const functions = threads.functions.map((fn): FunctionCost => {
    const [was, now] = [costBefore.get(fn.symbol.key) ?? notRun(), costAfter.get(fn.symbol.key) ?? notRun()];
    // A side that never ran it has no time, not zero time: "added" isn't "slower".
    const ran = (tally: FunctionTally, value: number) => (tally.calls === 0 ? null : value);
    const timePerCallUs = { before: ran(was, was.timeUs / was.outermostCalls), after: ran(now, now.timeUs / now.outermostCalls) };
    return {
      symbol: fn.symbol,
      change: fn.change,
      calls: { before: was.calls, after: now.calls },
      timeUs: { before: ran(was, was.timeUs), after: ran(now, now.timeUs) },
      timePerCallUs,
      selfTimePerCallUs: { before: ran(was, was.selfTimeUs / was.calls), after: ran(now, now.selfTimeUs / now.calls) },
      externalCalls: { before: was.externalCalls, after: now.externalCalls },
      paths: { before: was.paths.size, after: now.paths.size },
      time: verdict(timePerCallUs),
    };
  });

  const retried = baseAttempts.retried + headAttempts.retried;
  return { recordingsPerSide: RECORDINGS_PER_SIDE, noiseFloorUs: TIME_NOISE_FLOOR_US, noiseRatio: TIME_NOISE_RATIO, timeComparable, caveats: costCaveats(base, head, timeComparable, retried), workflows, functions };
}

/** On both sides, and its calls, external calls or routes' external calls changed, or its time moved past the noise bands. */
export function workflowCostChanged(workflow: WorkflowCost): boolean {
  if (workflow.sides !== WorkflowSides.Both) return false;
  const differs = (m: Measure) => m.before !== m.after;
  return differs(workflow.calls) || differs(workflow.externalCalls) || workflow.routes.some((route) => differs(route.externalCalls)) || isTimeCallout(workflow.time);
}

/**
 * Workflows that make more external calls than before, and new ones that make any: a new test
 * through a new N+1 has no base to be "more" than, and is exactly what this exists to show.
 */
export function moreExternalCalls(workflows: WorkflowCost[]): { compared: number; new: number } {
  const compared = workflows.filter((w) => w.sides === WorkflowSides.Both && w.externalCalls.after! > w.externalCalls.before!).length;
  return { compared, new: workflows.filter((w) => w.sides === WorkflowSides.New && w.externalCalls.after! > 0).length };
}

/** A route whose external calls changed, and the workflows whose requests to it changed alike: who waits. */
export interface RouteCostChange {
  label: string;
  requests: Measure;
  externalCalls: Measure;
  workflows: { scenarioId: string; name: string }[];
}

/** Routes whose external calls changed in workflows on both sides, one entry per route and change. */
export function routeCostChanges(workflows: WorkflowCost[]): RouteCostChange[] {
  const changes = new Map<string, RouteCostChange>();
  for (const workflow of workflows) {
    if (workflow.sides !== WorkflowSides.Both) continue;
    for (const route of workflow.routes) {
      if (route.externalCalls.before === route.externalCalls.after) continue;
      const key = JSON.stringify([route.label, route.requests, route.externalCalls]);
      if (!changes.has(key)) changes.set(key, { label: route.label, requests: route.requests, externalCalls: route.externalCalls, workflows: [] });
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
  const pastRatio = before === 0 ? change !== 0 : Math.abs(change) / before >= TIME_NOISE_RATIO;
  if (Math.abs(change) < TIME_NOISE_FLOOR_US || !pastRatio) return TimeVerdict.WithinNoise;
  return change > 0 ? TimeVerdict.Slower : TimeVerdict.Faster;
}

/** "3.12.9" -> "3.12", "node 23.11.0" -> "node 23.11": a patch release doesn't change how fast code runs. */
function runtimeRelease(runtime: string): string {
  return runtime.replace(/(\d+\.\d+)\.\d+\S*/, "$1");
}

/** Recorder overhead is most of a traced call's time: it has to be the same overhead on both sides. */
function sameRecorder(base: Run, head: Run): boolean {
  return (
    base.language === head.language &&
    runtimeRelease(base.runtime) === runtimeRelease(head.runtime) &&
    base.backend === head.backend &&
    base.recorderVersion === head.recorderVersion
  );
}

function costCaveats(base: Run, head: Run, timeComparable: boolean, retried: number): string[] {
  const floorMs = TIME_NOISE_FLOOR_US / 1000;
  const backend = base.backend === head.backend ? head.backend : `${base.backend} on the base, ${head.backend} on this branch`;
  const caveats = [
    `Each side was recorded once, so a time difference may be noise: one is called out only past both ${floorMs} ms and ${Math.round(TIME_NOISE_RATIO * 100)}%, and even then a second recording is what confirms it.`,
    `Times include the recorder's own overhead (${backend}), which isn't subtracted: code that makes many calls looks slower than it runs untraced. Call counts don't depend on timing.`,
    "The recordings don't say which machine made them: if the two sides were recorded on different machines, their times differ for that reason alone.",
  ];
  if (!timeComparable) {
    const side = (run: Run) => `${run.language} ${run.runtime}, ${run.backend}, recorder ${run.recorderVersion ?? "unknown"}`;
    caveats.push(`The two sides were recorded differently (${side(base)} vs ${side(head)}): their overheads differ, so no time is called out.`);
  }
  if (retried > 0) caveats.push(`${retried} test run${retried === 1 ? " was a retry" : "s were retries"}: only each test's last attempt is counted.`);
  return caveats;
}

/** Biggest external-call change first (N+1 is the cost a reviewer misses), then calls, then a time callout. */
function weight(workflow: WorkflowCost): number {
  const delta = (m: Measure) => (m.before === null || m.after === null ? 0 : Math.abs(m.after - m.before));
  return delta(workflow.externalCalls) * 1_000_000 + delta(workflow.calls) * 1_000 + (isTimeCallout(workflow.time) ? 1 : 0);
}

function measure(before: number | undefined, after: number | undefined): Measure {
  return { before: before ?? null, after: after ?? null };
}

/** Each test's last attempt (a retried test is recorded once per attempt, under one nodeid). */
function lastAttempts(run: Run): { scenarios: Scenario[]; retried: number } {
  const last = new Map<string, Scenario>();
  for (const scenario of run.scenarios) last.set(scenario.nodeid, scenario);
  return { scenarios: [...last.values()], retried: run.scenarios.length - last.size };
}

interface ScenarioCost {
  timeUs: number;
  calls: number;
  externalCalls: number;
  routes: Map<string, { requests: number; externalCalls: number }>;
}

function scenarioCost(scenario: Scenario, run: Run, phases: Set<Phase>): ScenarioCost {
  const spans = scenario.spans.filter((span) => phases.has(span.phase));
  // The phase's outermost calls: a thread handed work is a child, so it isn't counted twice.
  const timeUs = spans.filter((span) => span.parent === null || !phases.has(span.parent.phase)).reduce((total, span) => total + span.endUs - span.startUs, 0);
  const externalCalls = scenario.boundaryCalls.filter((call) => phases.has(call.phase));
  const routes = new Map<string, { requests: number; externalCalls: number }>();
  const routeOf = (label: string) => {
    if (!routes.has(label)) routes.set(label, { requests: 0, externalCalls: 0 });
    return routes.get(label)!;
  };
  const labels = new Map<Span, string>();
  for (const request of spans.filter((span) => span.request !== null)) {
    const label = requestRouteLabel(request, run.topology?.routes ?? []);
    labels.set(request, label);
    routeOf(label).requests += 1;
  }
  for (const call of externalCalls) {
    const request = call.caller?.enclosingRequest();
    const label = request === null || request === undefined ? undefined : labels.get(request);
    if (label !== undefined) routeOf(label).externalCalls += 1;
  }
  return { timeUs, calls: spans.filter((span) => span.fn.role === Role.Source).length, externalCalls: externalCalls.length, routes };
}

interface FunctionTally {
  calls: number;
  /** Calls not inside another call of the same function: what its total time is the sum of. */
  outermostCalls: number;
  timeUs: number;
  selfTimeUs: number;
  externalCalls: number;
  paths: Set<string>;
}

function notRun(): FunctionTally {
  return { calls: 0, outermostCalls: 0, timeUs: 0, selfTimeUs: 0, externalCalls: 0, paths: new Set() };
}

/** Calls, time, external calls and paths for each function in `keys` (head's keys), over the given workflows. */
function functionCosts(run: Run, scenarios: Scenario[], phases: Set<Phase>, keys: Set<string>, keyOf: (key: string) => string, byText: boolean): Map<string, FunctionTally> {
  const tallies = new Map<string, FunctionTally>();
  const tally = (key: string) => {
    if (!tallies.has(key)) tallies.set(key, notRun());
    return tallies.get(key)!;
  };
  for (const scenario of scenarios) {
    for (const span of scenario.spans) {
      const key = keyOf(span.fn.symbol.key);
      if (!phases.has(span.phase) || !keys.has(key)) continue;
      const fn = tally(key);
      fn.calls += 1;
      const durationUs = span.endUs - span.startUs;
      if (!ancestorKeys(span.parent, keyOf).has(key)) {
        fn.outermostCalls += 1;
        fn.timeUs += durationUs;
      }
      // A coroutine's children can overlap its own waits: never below nothing.
      fn.selfTimeUs += Math.max(0, durationUs - span.children.reduce((total, child) => total + child.endUs - child.startUs, 0));
      fn.paths.add(pathOf(run, span, byText));
    }
    for (const call of scenario.boundaryCalls) {
      if (!phases.has(call.phase)) continue;
      for (const key of ancestorKeys(call.caller, keyOf)) if (keys.has(key)) tally(key).externalCalls += 1;
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
 * loop, or taking the other branch, is. A line is named by its offset in the function, plus
 * its text when both sides kept their source: text alone collides (every `}` or `return`).
 */
function pathOf(run: Run, span: Span, byText: boolean): string {
  const { file, firstLine } = span.fn;
  const name = (line: number) => {
    const text = byText && file !== null ? run.sourceLine(file, line)?.trim() : undefined;
    return text === undefined ? `+${line - firstLine}` : `+${line - firstLine} ${text}`;
  };
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
