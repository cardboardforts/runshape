import { BoundaryCall, Outcome, Phase, Role, Route, Run, Span, SymbolKind } from "@runshape/trace";
import { align, Op } from "./align";
import { functionRef, FunctionRef } from "./function-ref";
import { Moves } from "./moves";
import { Change } from "./run-diff";

/**
 * A run's requests by the route that served them, and each route's requests by the path they
 * took through the project's code. Real traffic sends a route hundreds of requests that do a
 * handful of different things; a variant is one of those things.
 */
export interface RouteMap {
  routes: RouteGroup[];
  /** Startup, background work, unit tests: scenarios with no request in the phases shown. */
  scenariosWithoutRequests: number;
}

export interface RouteGroup {
  /** Method and pattern as recorded: what pairs a route across two recordings. */
  id: string;
  /** "GET /orders/{id}": the pattern written one way whatever the framework's syntax. */
  label: string;
  /** False when no route in the framework's table served it: grouped by its literal path. */
  routed: boolean;
  requestCount: number;
  /** The main path first, then by how many requests took each. */
  variants: RouteVariant[];
}

export interface RouteVariant {
  /** The shape of the call tree: what makes two requests the same variant. */
  key: string;
  steps: VariantStep[];
  requests: RequestRef[];
  /** The route's most taken path (the longest, on a tie): the others are told against it. */
  isMain: boolean;
  /**
   * False when the request matched the route's pattern but was turned away before its handler
   * ran (authentication, validation in middleware): `steps` are what ran instead, and `adds`
   * lists them rather than `skips` listing the whole main path.
   */
  reachedHandler: boolean;
  /** What the main path runs that this one doesn't, and the other way round. */
  skips: string[];
  adds: string[];
}

export interface VariantStep {
  /** What pairs a step across variants: the function's symbol key, or the external call. */
  key: string;
  /** Below the handler, which is depth 0. */
  depth: number;
  label: string;
  /** Null for a call out of the program (a query, an HTTP call). */
  symbol: FunctionRef | null;
  /** It ran more than once in a row (a loop): how many times doesn't make another variant. */
  repeated: boolean;
}

export interface RequestRef {
  scenarioId: string;
  scenarioName: string;
  /** "GET /orders/ord-1": the request as sent. */
  line: string;
  outcome: Outcome;
}

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
        label: served ? `${request.method} ${readablePattern(served.route.path)}` : `${request.method} ${path}`,
        routed: served !== null,
        variants: new Map(),
      };
      groups.set(id, group);
      const shape = shapeOf(served?.handler ?? span, included, keyOf);
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

/** How a route's ways through the code changed between two recordings. */
export interface RouteMapDiff {
  routes: RouteGroupDiff[];
}

export interface RouteGroupDiff {
  id: string;
  label: string;
  routed: boolean;
  /** Changed when a variant appeared or went; requests per variant may differ either way. */
  change: Change;
  variants: RouteVariantDiff[];
}

export interface RouteVariantDiff {
  /** Head's variant, or the base's when it's gone. */
  variant: RouteVariant;
  /**
   * Changed: a path only head takes, paired with one only the base took that it mostly
   * follows. A refactor that adds a call to every placed order is one variant changed, not
   * one gone and one new.
   */
  change: Change;
  /** For a changed variant: the base's, and the functions one calls that the other doesn't. */
  previous: RouteVariant | null;
  nowCalls: string[];
  noLongerCalls: string[];
  /** The path with each step marked: a changed variant's steps aligned with its previous one's. */
  path: { op: Op; step: VariantStep }[];
  /** Requests that took it in each recording. */
  before: number;
  after: number;
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
      const [was, now] = [calledIn(previous), calledIn(variant)];
      return {
        variant,
        change: Change.Changed,
        previous,
        nowCalls: [...now].filter((label) => !was.has(label)),
        noLongerCalls: [...was].filter((label) => !now.has(label)),
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

function calledIn(variant: RouteVariant): Set<string> {
  return new Set(variant.steps.map((step) => step.label));
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
 * handler seen, a pattern that matches the path segment by segment, placeholders matching any
 * one segment. The method isn't checked: a route's group is per method, so a DELETE that a
 * GET-only route refused is its own group, "never reached the handler".
 */
function servingRoute(request: Span, path: string, routes: Route[]): ServedBy | null {
  for (const span of subtree(request)) {
    if (span.fn.role !== Role.Source) continue;
    const symbol = span.fn.symbol;
    const candidates = routes.filter((route) => route.handler.equals(symbol.path) || (symbol.ownerType !== null && route.handler.equals(symbol.owner)));
    if (candidates.length === 0) continue;
    const segments = segmentsOf(path).length;
    const route = candidates.find((candidate) => segmentsOf(readablePattern(candidate.path)).length === segments) ?? candidates[0]!;
    return { route, handler: span };
  }
  // Refused before its handler ran (authentication, a 404 from the router's own checks).
  const route = routes.find((candidate) => patternMatches(readablePattern(candidate.path), path));
  return route === undefined ? null : { route, handler: null };
}

function patternMatches(pattern: string, path: string): boolean {
  const want = segmentsOf(pattern);
  const have = segmentsOf(path);
  return want.length === have.length && want.every((segment, i) => /^\{\w+\}$/.test(segment) || segment === have[i]);
}

function* subtree(span: Span): Generator<Span> {
  yield span;
  for (const child of span.children) yield* subtree(child);
}

/**
 * One way of writing every framework's patterns, for showing them: FastAPI's and Go's
 * "{slug}", Django's "<int:pk>" and "(?P<slug>…)" regexes with their "^" and "/?" anchors.
 */
export function readablePattern(pattern: string): string {
  return pattern
    .replace(/\(\?P<(\w+)>(?:[^()\\]|\\.|\([^()]*\))*\)/g, "{$1}")
    .replace(/<(?:\w+:)?(\w+)>/g, "{$1}")
    .replace(/\^/g, "")
    .replace(/\/\?$/, "")
    .replace(/\$$/, "")
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
  const mainCalls = new Set(main?.steps.map((step) => step.label));
  return ranked.map((variant) => {
    if (variant === main) return { ...variant, isMain: true, skips: [], adds: [] };
    const calls = new Set(variant.steps.map((step) => step.label));
    if (!variant.reachedHandler) return { ...variant, isMain: false, skips: [], adds: [...calls] };
    return { ...variant, isMain: false, skips: [...mainCalls].filter((label) => !calls.has(label)), adds: [...calls].filter((label) => !mainCalls.has(label)) };
  });
}
