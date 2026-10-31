import { BoundaryCall, Change, FunctionRef, functionRef, Op, Outcome, Phase, RequestRef, Role, Route, RouteGroupDiff, RouteMap, RouteMapDiff, RouteVariant, RouteVariantDiff, Run, Span, SymbolKind, VariantStep } from "@runshape/kernel";
import { align } from "./align";
import { Moves } from "./moves";

export interface RouteMapOptions {
  phases?: Phase[];
  /** Names a function for pairing; a base run's functions are named as head names them. */
  keyOf?: (symbolKey: string) => string;
}

export function buildRouteMap(run: Run, options: RouteMapOptions = {}): RouteMap {
  const included = new Set(options.phases ?? [Phase.Call]);
  const keyOf = options.keyOf ?? ((key: string) => key);
  const routes = run.topology?.routes ?? [];
  const groups = new Map<string, { id: string; label: string; routed: boolean; variants: Map<string, { shape: ShapeNode[]; reachedHandler: boolean; requests: RequestRef[] }> }>();
  let scenariosWithoutRequests = 0;

  for (const scenario of run.scenarios) {
    const requests = scenario.requests().filter((span) => included.has(span.phase));
    if (requests.length === 0) scenariosWithoutRequests += 1;
    for (const span of requests) {
      const request = span.request!;
      const path = withoutQuery(request.path);
      const served = servingRoute(span, path, routes);
      const id = served ? `${request.method} ${served.route.path}` : `${request.method} ${path}`;
      const group = groups.get(id) ?? {
        id,
        label: routeLabel(request.method, path, served),
        routed: served !== null,
        variants: new Map(),
      };
      groups.set(id, group);
      // The whole request, not just the handler: authentication, dependencies and renderers
      // the project wrote run outside it, and a change to them changes the route.
      const shape = shapeOf(span, included, keyOf);
      const reachedHandler = served?.handler != null;
      const key = `${reachedHandler ? "" : "before handler:"}${shape.map((node) => node.signature).join(",")}`;
      const variant = group.variants.get(key);
      if (variant === undefined) group.variants.set(key, { shape, reachedHandler, requests: [] });
      else mergeRepeats(variant.shape, shape);
      group.variants.get(key)!.requests.push({ scenarioId: scenario.nodeid, scenarioName: scenario.name, line: `${request.method} ${request.path}`, outcome: scenario.outcome });
    }
  }

  return {
    routes: [...groups.values()].map((group) => {
      const variants = rankVariants([...group.variants].map(([key, { shape, reachedHandler, requests }]) => ({ key, steps: flatten(shape, 0), reachedHandler, requests })));
      return { id: group.id, label: group.label, routed: group.routed, requestCount: variants.reduce((sum, v) => sum + v.requests.length, 0), variants };
    }),
    scenariosWithoutRequests,
  };
}

/** How much of the longer path two variants must share, in order, to be one variant changed. */
export const CHANGED_VARIANT_MIN_SHARED = 0.5;

export function diffRouteMaps(base: Run, head: Run, options: { phases?: Phase[]; moves?: Moves } = {}): RouteMapDiff {
  const moves = options.moves ?? Moves.none();
  const before = buildRouteMap(base, { phases: options.phases, keyOf: moves.headKey });
  const after = buildRouteMap(head, { phases: options.phases });
  const beforeById = new Map(before.routes.map((route) => [route.id, route]));
  const afterIds = new Set(after.routes.map((route) => route.id));
  const routes: RouteGroupDiff[] = [];

  for (const route of after.routes) {
    const old = beforeById.get(route.id);
    const variants = diffVariants(old?.variants ?? [], route.variants);
    const change = old === undefined ? Change.Added : variants.some((v) => v.change !== Change.Unchanged) ? Change.Changed : Change.Unchanged;
    routes.push({ id: route.id, label: route.label, routed: route.routed, change, variants });
  }
  for (const route of before.routes) {
    if (afterIds.has(route.id)) continue;
    routes.push({
      id: route.id,
      label: route.label,
      routed: route.routed,
      change: Change.Removed,
      variants: route.variants.map(gone),
    });
  }
  return { routes };
}

function diffVariants(before: RouteVariant[], after: RouteVariant[]): RouteVariantDiff[] {
  const beforeKeys = new Map(before.map((variant) => [variant.key, variant]));
  const afterKeys = new Set(after.map((variant) => variant.key));
  const added = after.filter((variant) => !beforeKeys.has(variant.key));
  const removed = before.filter((variant) => !afterKeys.has(variant.key));
  const pairs = pairChanged(added, removed);
  const result: RouteVariantDiff[] = after.map((variant) => {
    const previous = pairs.get(variant) ?? null;
    if (previous !== null) {
      return {
        variant,
        change: Change.Changed,
        previous,
        nowCalls: callsOnlyIn(variant.steps, previous.steps),
        noLongerCalls: callsOnlyIn(previous.steps, variant.steps),
        path: align(previous.steps, variant.steps, (step) => step.key).steps.map(({ op, before, after }) => ({ op, step: (after ?? before)! })),
        before: previous.requests.length,
        after: variant.requests.length,
      };
    }
    const same = beforeKeys.get(variant.key);
    const path = variant.steps.map((step) => ({ op: same ? Op.Same : Op.Added, step }));
    return { variant, change: same ? Change.Unchanged : Change.Added, previous: null, nowCalls: [], noLongerCalls: [], path, before: same?.requests.length ?? 0, after: variant.requests.length };
  });
  const paired = new Set(pairs.values());
  return [...result, ...removed.filter((variant) => !paired.has(variant)).map(gone)];
}

function gone(variant: RouteVariant): RouteVariantDiff {
  const path = variant.steps.map((step) => ({ op: Op.Removed, step }));
  return { variant, change: Change.Removed, previous: null, nowCalls: [], noLongerCalls: [], path, before: variant.requests.length, after: 0 };
}

/** Best-matching pairs first, each variant in one pair at most. */
function pairChanged(added: RouteVariant[], removed: RouteVariant[]): Map<RouteVariant, RouteVariant> {
  const candidates: { now: RouteVariant; was: RouteVariant; shared: number }[] = [];
  for (const now of added) {
    for (const was of removed) {
      if (was.reachedHandler !== now.reachedHandler) continue;
      const same = align(was.steps, now.steps, (step) => step.key).steps.filter((aligned) => aligned.op === Op.Same).length;
      const shared = same / Math.max(was.steps.length, now.steps.length, 1);
      if (shared >= CHANGED_VARIANT_MIN_SHARED) candidates.push({ now, was, shared });
    }
  }
  candidates.sort((a, b) => b.shared - a.shared);
  const pairs = new Map<RouteVariant, RouteVariant>();
  const taken = new Set<RouteVariant>();
  for (const { now, was } of candidates) {
    if (pairs.has(now) || taken.has(was)) continue;
    pairs.set(now, was);
    taken.add(was);
  }
  return pairs;
}

/**
 * Functions `these` call that `those` never do, by key: two functions with one short name (a
 * `serialize` in two modules) are different calls. Shown by label, with the namespace when
 * the label alone would be ambiguous.
 */
function callsOnlyIn(these: VariantStep[], those: VariantStep[]): string[] {
  const absent = new Set(those.map((step) => step.key));
  const keysByLabel = new Map<string, Set<string>>();
  for (const step of [...these, ...those]) keysByLabel.set(step.label, (keysByLabel.get(step.label) ?? new Set()).add(step.key));
  const names = new Map<string, string>();
  for (const step of these) {
    if (absent.has(step.key) || names.has(step.key)) continue;
    const ambiguous = (keysByLabel.get(step.label)?.size ?? 0) > 1 && step.symbol !== null;
    names.set(step.key, ambiguous ? `${step.symbol!.namespace}.${step.label}` : step.label);
  }
  return [...names.values()];
}

/** "GET /api/articles/{slug}": the route that served a request span, as the route map labels it. */
export function requestRouteLabel(request: Span, routes: Route[]): string {
  const path = withoutQuery(request.request!.path);
  return routeLabel(request.request!.method, path, servingRoute(request, path, routes));
}

function routeLabel(method: string, path: string, served: ServedBy | null): string {
  return served ? `${method} ${readablePattern(served.route.path)}` : `${method} ${path}`;
}

interface ServedBy {
  route: Route;
  /** Null when the request matched the route's pattern but never reached its handler. */
  handler: Span | null;
}

/**
 * The route whose handler ran under this request, nearest first. A class-based view (Django
 * REST) registers the class and runs one of its methods, and one class can serve several
 * patterns: the list and the detail, told apart by how many segments the path has. With no
 * handler seen, the pattern that matches the path (routeForPath). The method isn't checked: a route's group is per method, so a DELETE that a
 * GET-only route refused is its own group, "never reached the handler".
 */
function servingRoute(request: Span, path: string, routes: Route[]): ServedBy | null {
  const found: { span: Span; routes: Route[]; exact: boolean }[] = [];
  for (const span of subtree(request)) {
    if (span.fn.role !== Role.Source) continue;
    const symbol = span.fn.symbol;
    const exact = routes.filter((route) => route.handler.equals(symbol.path));
    const owned = symbol.ownerType === null ? [] : routes.filter((route) => route.handler.equals(symbol.owner));
    if (exact.length > 0) found.push({ span, routes: exact, exact: true });
    else if (owned.length > 0) found.push({ span, routes: owned, exact: false });
  }
  // A view class's own hooks (get_permissions, initial) run before the method that handles
  // the request: the handler is the registered function itself, else a request-handling method.
  const chosen =
    found.find((entry) => entry.exact) ?? found.find((entry) => REQUEST_HANDLER_METHODS.has(entry.span.fn.symbol.name)) ?? found[0];
  if (chosen !== undefined) {
    const segments = segmentsOf(path).length;
    const route = chosen.routes.find((candidate) => segmentsOf(readablePattern(candidate.path)).length === segments) ?? chosen.routes[0]!;
    return { route, handler: chosen.span };
  }
  // Refused before its handler ran (authentication, a 404 from the router's own checks).
  const route = routeForPath(routes, path);
  return route === null ? null : { route, handler: null };
}

/**
 * What a class-based view names the method that answers a request: Django's per-verb methods
 * and Django REST's viewset actions.
 */
const REQUEST_HANDLER_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "head", "options",
  "list", "create", "retrieve", "update", "partial_update", "destroy",
]);

/**
 * The route whose pattern matches a path segment by segment: a placeholder matches one
 * segment, a trailing "{rest...}" any number. Of several, the most specific (most literal
 * segments) wins, as in Go's mux; a tie goes to the first listed, as in Django's and
 * Starlette's ordered tables.
 */
export function routeForPath(routes: Route[], path: string): Route | null {
  let best: { route: Route; literals: number } | null = null;
  for (const route of routes) {
    const literals = literalSegmentsMatching(readablePattern(route.path), path);
    if (literals !== null && (best === null || literals > best.literals)) best = { route, literals };
  }
  return best?.route ?? null;
}

/** How many of the pattern's segments matched literally, or null when it doesn't match. */
function literalSegmentsMatching(pattern: string, path: string): number | null {
  const want = segmentsOf(pattern);
  const have = segmentsOf(path);
  let literals = 0;
  for (let i = 0; i < want.length; i += 1) {
    const segment = want[i]!;
    if (/^\{\w+\.\.\.\}$/.test(segment)) return i === want.length - 1 ? literals : null;
    if (i >= have.length) return null;
    if (/^\{\w+\}$/.test(segment)) continue;
    if (segment !== have[i]) return null;
    literals += 1;
  }
  return want.length === have.length ? literals : null;
}

function* subtree(span: Span): Generator<Span> {
  yield span;
  for (const child of span.children) yield* subtree(child);
}

/**
 * One way of writing every framework's patterns, for showing them: FastAPI's and Go's
 * "{slug}" (and Go's "{$}" end marker), Django's "<int:pk>" and "(?P<slug>…)" regexes with
 * their "^", "$" and "/?" anchors.
 */
export function readablePattern(pattern: string): string {
  return pattern
    .replace(/\(\?P<(\w+)>(?:[^()\\]|\\.|\([^()]*\))*\)/g, "{$1}")
    .replace(/<(?:\w+:)?(\w+)>/g, "{$1}")
    .replace(/\^/g, "")
    .replace(/\{\$\}$/, "")
    .replace(/\$$/, "")
    .replace(/\/\?$/, "")
    .replace(/\\(.)/g, "$1");
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function withoutQuery(path: string): string {
  const query = path.indexOf("?");
  return query === -1 ? path : path.slice(0, query);
}

/** A call or an external call, with what ran inside it; `signature` is its whole subtree. */
interface ShapeNode {
  key: string;
  label: string;
  symbol: FunctionRef | null;
  children: ShapeNode[];
  repeated: boolean;
  signature: string;
}

/**
 * The project code a span ran, as a tree. Framework code in between (middleware, dependency
 * injection, a router) is see-through: its project calls hang off the nearest project caller.
 */
function shapeOf(span: Span, included: Set<Phase>, keyOf: (key: string) => string): ShapeNode[] {
  const inside = collapseRepeats([
    ...span.children.filter((child) => included.has(child.phase)).map((child) => ({ at: child.startUs, nodes: shapeOf(child, included, keyOf) })),
    ...span.boundaryCalls.filter((call) => included.has(call.phase)).map((call) => ({ at: call.startUs, nodes: [externalNode(call)] })),
  ]
    .sort((a, b) => a.at - b.at)
    .flatMap((entry) => entry.nodes));
  // Module bodies run on first import, in whichever request comes first: not this route's doing.
  if (span.fn.role !== Role.Source || span.fn.symbol.kind === SymbolKind.Initializer) return inside;
  const key = keyOf(span.fn.symbol.key);
  return [node(key, span.fn.symbol.localName.text, functionRef(span.fn.symbol), inside)];
}

function externalNode(call: BoundaryCall): ShapeNode {
  const label = `${call.system} ${call.operation}`;
  return node(`external:${label}`, label, null, []);
}

function node(key: string, label: string, symbol: FunctionRef | null, children: ShapeNode[]): ShapeNode {
  return { key, label, symbol, children, repeated: false, signature: `${JSON.stringify(key)}(${children.map((child) => child.signature).join(",")})` };
}

/**
 * A loop's iterations are one step: an article with one tag and one with three took the same
 * path. So whether a step repeated isn't part of the signature, only shown.
 */
function collapseRepeats(nodes: ShapeNode[]): ShapeNode[] {
  const kept: ShapeNode[] = [];
  for (const current of nodes) {
    const previous = kept[kept.length - 1];
    if (previous !== undefined && previous.signature === current.signature) {
      previous.repeated = true;
      mergeRepeats(previous.children, current.children);
      continue;
    }
    kept.push(current);
  }
  return kept;
}

/** Same signature, same tree: a step shows as repeating if it looped in any of the requests. */
function mergeRepeats(into: ShapeNode[], from: ShapeNode[]): void {
  into.forEach((node, i) => {
    node.repeated ||= from[i]!.repeated;
    mergeRepeats(node.children, from[i]!.children);
  });
}

function flatten(nodes: ShapeNode[], depth: number): VariantStep[] {
  return nodes.flatMap((n) => [{ key: n.key, depth, label: n.label, symbol: n.symbol, repeated: n.repeated }, ...flatten(n.children, depth + 1)]);
}

/**
 * Told against the main path by what's called at all, not by position: a refused order
 * "skips MemoryRepository.Save", and a helper called once less often isn't news.
 */
function rankVariants(found: { key: string; steps: VariantStep[]; reachedHandler: boolean; requests: RequestRef[] }[]): RouteVariant[] {
  const ranked = [...found].sort(
    (a, b) => Number(b.reachedHandler) - Number(a.reachedHandler) || b.requests.length - a.requests.length || b.steps.length - a.steps.length,
  );
  const main = ranked[0];
  return ranked.map((variant) => {
    if (variant === main) return { ...variant, isMain: true, skips: [], adds: [] };
    const adds = callsOnlyIn(variant.steps, main!.steps);
    // Told against a path it never got to, it would skip all of it.
    if (!variant.reachedHandler) return { ...variant, isMain: false, skips: [], adds };
    return { ...variant, isMain: false, skips: callsOnlyIn(main!.steps, variant.steps), adds };
  });
}
