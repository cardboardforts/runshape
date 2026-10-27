import { CatalogFunction, FunctionRef, functionRef, Phase, Role, Run, Scenario } from "@runshape/kernel";

import { Moves } from "./moves";
import { buildRouteMap, RouteMap } from "./routes";
import { RunDiff } from "./run-diff";

/** How a workflow through a changed function fares: it ran the same, ran differently, or only one side has it. */
export enum ThreadKind {
  Same = "same",
  Different = "different",
  New = "new",
  Gone = "gone",
}

/** A workflow (a recorded scenario: a test, or a request to a running program) through changed code. */
export interface Thread {
  scenarioId: string;
  name: string;
  kind: ThreadKind;
}

/** A route whose requests pass through changed code, on one side or both. */
export interface ThreadRoute {
  label: string;
  on: "both" | "head" | "base";
}

export interface ChangedFunction {
  symbol: FunctionRef;
  /** "ArticlesRepository.get_article_by_slug (app.services.articles)". */
  label: string;
  file: string;
  /** Its own source changed, or it only exists on one side. */
  change: "edited" | "added" | "removed" | "ran differently";
  threads: Thread[];
  routes: ThreadRoute[];
}

/** For each function the change touched, the workflows to follow through it. */
export interface Threads {
  /**
   * "source": changed means its own source text changed (both recordings keep their source).
   * "behaviour": older recordings without source: changed means some test ran it differently.
   */
  basis: "source" | "behaviour";
  functions: ChangedFunction[];
}

const KIND_ORDER = [ThreadKind.Different, ThreadKind.New, ThreadKind.Gone, ThreadKind.Same];

/**
 * The threads to follow through a change: each changed function, and every workflow that runs
 * through it on either side. A reviewer works down this list; a workflow that still behaves the
 * same is listed too, since "still green, still the same" is what the change has to keep.
 */
export function buildThreads(base: Run, head: Run, diff: RunDiff, options: { phases?: Phase[]; moves?: Moves } = {}): Threads {
  const phases = new Set(options.phases ?? [Phase.Call]);
  const moves = options.moves ?? Moves.none();
  const basis = base.sources !== null && head.sources !== null ? "source" : "behaviour";
  // Per workflow, the functions it ran differently (head's keys): what "different" means for one function.
  const ranDifferently = new Map(diff.scenarios.map((scenario) => [scenario.id, new Set(scenario.functionsChanged.map((change) => change.symbol.key))]));
  const changed = basis === "source" ? changedBySource(base, head, moves, ranDifferently) : changedByBehaviour(base, head, ranDifferently, moves);

  const headRuns = scenariosByFunction(head.scenarios, phases, (key) => key, (id) => id);
  const baseRuns = scenariosByFunction(base.scenarios, phases, moves.headKey, moves.headScenarioId);
  const names = new Map([...base.scenarios.map((s) => [moves.headScenarioId(s.nodeid), s.name] as const), ...head.scenarios.map((s) => [s.nodeid, s.name] as const)]);
  const headRoutes = routesByFunction(buildRouteMap(head, { phases: [...phases] }));
  const baseRoutes = routesByFunction(buildRouteMap(base, { phases: [...phases], keyOf: moves.headKey }));

  const functions = changed.map(({ fn, change }): ChangedFunction => {
    const key = fn.symbol.key;
    const ids = new Set([...(headRuns.get(key) ?? []), ...(baseRuns.get(key) ?? [])]);
    const threads = [...ids]
      .map((id): Thread => {
        const onHead = headRuns.get(key)?.has(id) ?? false;
        const onBase = baseRuns.get(key)?.has(id) ?? false;
        const kind = onHead && onBase ? (ranDifferently.get(id)?.has(key) ? ThreadKind.Different : ThreadKind.Same) : onHead ? ThreadKind.New : ThreadKind.Gone;
        return { scenarioId: id, name: names.get(id) ?? id, kind };
      })
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
    const routeLabels = new Set([...(headRoutes.get(key) ?? []), ...(baseRoutes.get(key) ?? [])]);
    const routes = [...routeLabels].sort().map((label): ThreadRoute => {
      const onHead = headRoutes.get(key)?.has(label) ?? false;
      const onBase = baseRoutes.get(key)?.has(label) ?? false;
      return { label, on: onHead && onBase ? "both" : onHead ? "head" : "base" };
    });
    const symbol = functionRef(fn.symbol);
    return { symbol, label: `${symbol.path} (${symbol.namespace})`, file: fn.file, change, threads, routes };
  });
  // The ones whose workflows changed first: that's where a reviewer starts.
  const weight = (fn: ChangedFunction) => fn.threads.filter((t) => t.kind !== ThreadKind.Same).length;
  functions.sort((a, b) => weight(b) - weight(a) || b.threads.length - a.threads.length || a.label.localeCompare(b.label));
  return { basis, functions };
}

interface Changed {
  /** Head's function, or the base's when it's gone (named as head would name it). */
  fn: CatalogFunction;
  change: ChangedFunction["change"];
}

/**
 * Functions whose own lines differ, or that only one side has; a moved function is paired with
 * itself. Tests are the workflows, not the code they follow. A function whose source wasn't kept
 * counts when some workflow ran it differently, as without source.
 */
function changedBySource(base: Run, head: Run, moves: Moves, ranDifferently: Map<string, Set<string>>): Changed[] {
  const tests = new Set([...testKeys(base, moves.headKey), ...testKeys(head, (key) => key)]);
  const behaved = new Set([...ranDifferently.values()].flatMap((keys) => [...keys]));
  const baseByHeadKey = new Map(base.catalog.map((fn) => [moves.headKey(fn.symbol.key), fn]));
  const headKeys = new Set(head.catalog.map((fn) => fn.symbol.key));
  const changed: Changed[] = [];
  for (const fn of head.catalog) {
    if (tests.has(fn.symbol.key)) continue;
    const before = baseByHeadKey.get(fn.symbol.key);
    if (before === undefined) {
      changed.push({ fn, change: "added" });
      continue;
    }
    const [was, now] = [bodyOf(base, before), bodyOf(head, fn)];
    if (was === null || now === null) {
      if (behaved.has(fn.symbol.key)) changed.push({ fn, change: "ran differently" });
    } else if (was !== now) changed.push({ fn, change: "edited" });
  }
  for (const [headKey, fn] of baseByHeadKey) if (!headKeys.has(headKey) && !tests.has(headKey)) changed.push({ fn, change: "removed" });
  return changed;
}

/** The test functions a run's workflows start in (by head's key). */
function testKeys(run: Run, keyOf: (key: string) => string): string[] {
  return run.scenarios.flatMap((scenario) => scenario.spans.filter((span) => span.fn.role === Role.Test).map((span) => keyOf(span.fn.symbol.key)));
}

/** Without source: the functions some test ran differently (lines now or no longer reached). */
function changedByBehaviour(base: Run, head: Run, ranDifferently: Map<string, Set<string>>, moves: Moves): Changed[] {
  const keys = new Set([...ranDifferently.values()].flatMap((keys) => [...keys]));
  const baseByHeadKey = new Map(base.catalog.map((fn) => [moves.headKey(fn.symbol.key), fn]));
  return [...keys].flatMap((key) => {
    const fn = head.catalogFunction(key) ?? baseByHeadKey.get(key);
    return fn === undefined ? [] : [{ fn, change: "ran differently" as const }];
  });
}

/** A function's lines as recorded, trailing space ignored: what a reviewer would read as its body. Null when they weren't kept. */
function bodyOf(run: Run, fn: CatalogFunction): string | null {
  const lines = run.sources?.get(fn.file);
  if (lines === undefined || !Number.isInteger(fn.firstLine) || !Number.isInteger(fn.lastLine) || fn.lastLine > lines.length) return null;
  return lines.slice(fn.firstLine - 1, fn.lastLine).map((line) => line.trimEnd()).join("\n");
}

/** Which scenarios (by head's id) run each function (by head's key), in the phases shown. */
function scenariosByFunction(scenarios: Scenario[], phases: Set<Phase>, keyOf: (key: string) => string, idOf: (id: string) => string): Map<string, Set<string>> {
  const runs = new Map<string, Set<string>>();
  for (const scenario of scenarios) {
    for (const span of scenario.spans) {
      if (!phases.has(span.phase)) continue;
      const key = keyOf(span.fn.symbol.key);
      if (!runs.has(key)) runs.set(key, new Set());
      runs.get(key)!.add(idOf(scenario.nodeid));
    }
  }
  return runs;
}

/** Which routes' request paths pass through each function. */
function routesByFunction(map: RouteMap): Map<string, Set<string>> {
  const routes = new Map<string, Set<string>>();
  for (const route of map.routes) {
    for (const variant of route.variants) {
      for (const step of variant.steps) {
        if (step.symbol === null) continue;
        if (!routes.has(step.key)) routes.set(step.key, new Set());
        routes.get(step.key)!.add(route.label);
      }
    }
  }
  return routes;
}

/** Changed functions with the same workflows, the same way, and the same routes: one entry to follow. */
export interface ThreadGroup {
  functions: ChangedFunction[];
  threads: Thread[];
  routes: ThreadRoute[];
}

/**
 * Functions with the same threads, grouped: a change that adds five helpers along one path is
 * one thread to follow, not five copies of the same workflow list. In the order of their first.
 */
export function groupThreads(threads: Threads): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();
  for (const fn of threads.functions) {
    const key = [...fn.threads.map((thread) => `${thread.kind}:${thread.scenarioId}`), ...fn.routes.map((route) => `${route.on}:${route.label}`)].join("\n");
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { functions: [fn], threads: fn.threads, routes: fn.routes });
    else group.functions.push(fn);
  }
  return [...groups.values()];
}

/**
 * What a workflow's change comes from: the changed functions it now runs differently, newly, or
 * no longer, by scenario (head's id). Workflows with the same cause are one row to review.
 */
export function causesByScenario(threads: Threads): Map<string, ChangedFunction[]> {
  const causes = new Map<string, ChangedFunction[]>();
  for (const fn of threads.functions) {
    for (const thread of fn.threads) {
      if (thread.kind === ThreadKind.Same) continue;
      if (!causes.has(thread.scenarioId)) causes.set(thread.scenarioId, []);
      causes.get(thread.scenarioId)!.push(fn);
    }
  }
  return causes;
}
