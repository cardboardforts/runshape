import { CatalogFunction, FunctionRef, functionRef, Phase, Run, Scenario } from "@runshape/kernel";

import { Moves } from "./moves";
import { buildRouteMap, RouteMap } from "./routes";
import { Change, RunDiff } from "./run-diff";

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
  const changed = basis === "source" ? changedBySource(base, head, moves) : changedByBehaviour(base, head, diff, moves);

  const headRuns = scenariosByFunction(head.scenarios, phases, (key) => key, (id) => id);
  const baseRuns = scenariosByFunction(base.scenarios, phases, moves.headKey, moves.headScenarioId);
  const changeOf = new Map(diff.scenarios.map((scenario) => [scenario.id, scenario.change]));
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
        const kind = onHead && onBase ? (changeOf.get(id) === Change.Unchanged ? ThreadKind.Same : ThreadKind.Different) : onHead ? ThreadKind.New : ThreadKind.Gone;
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

/** Functions whose own lines differ, or that only one side has; a moved function is paired with itself. */
function changedBySource(base: Run, head: Run, moves: Moves): Changed[] {
  const baseByHeadKey = new Map(base.catalog.map((fn) => [moves.headKey(fn.symbol.key), fn]));
  const headKeys = new Set(head.catalog.map((fn) => fn.symbol.key));
  const changed: Changed[] = [];
  for (const fn of head.catalog) {
    const before = baseByHeadKey.get(fn.symbol.key);
    if (before === undefined) changed.push({ fn, change: "added" });
    else if (bodyOf(base, before) !== bodyOf(head, fn)) changed.push({ fn, change: "edited" });
  }
  for (const [headKey, fn] of baseByHeadKey) if (!headKeys.has(headKey)) changed.push({ fn, change: "removed" });
  return changed;
}

/** Without source: the functions some test ran differently (lines now or no longer reached). */
function changedByBehaviour(base: Run, head: Run, diff: RunDiff, moves: Moves): Changed[] {
  const keys = new Set(diff.scenarios.flatMap((scenario) => scenario.functionsChanged.map((change) => change.symbol.key)));
  const baseByHeadKey = new Map(base.catalog.map((fn) => [moves.headKey(fn.symbol.key), fn]));
  return [...keys].flatMap((key) => {
    const fn = head.catalogFunction(key) ?? baseByHeadKey.get(key);
    return fn === undefined ? [] : [{ fn, change: "ran differently" as const }];
  });
}

/** A function's lines as recorded, trailing space ignored: what a reviewer would read as its body. */
function bodyOf(run: Run, fn: CatalogFunction): string {
  const lines = run.sources?.get(fn.file) ?? [];
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
