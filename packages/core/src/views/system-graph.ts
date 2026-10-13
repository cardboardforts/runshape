import { Phase, Run, Scenario, Span } from "../model";
import { DeclaredZone, ZoneRules } from "../zones";
import {
  CLIENT_ID,
  ComponentKind,
  ComponentRef,
  componentOf,
  externalComponent,
  FINE_GROUPING,
  Grouping,
  MIDDLEWARE_CHAIN_ID,
} from "./components";

/**
 * Where a component sits in the onion. A rule in runshape.json decides when one matches;
 * otherwise it is inferred from what the component was seen doing at runtime:
 * - inbound adapter: the framework hands it requests (a route handler, or a dependency
 *   the router calls directly)
 * - outbound adapter: it calls an external system itself
 * - core: neither — everything else the request passes through
 */
export enum Zone {
  Edge = "edge",
  InboundAdapter = "inbound-adapter",
  OutboundAdapter = "outbound-adapter",
  Core = "core",
  TestDouble = "test-double",
  External = "external",
}

export enum Smell {
  /** An inbound adapter that also talks to an external system skips the core entirely. */
  HandlerTouchesExternal = "handler-touches-external",
  /** Declared core, but seen talking to an external system: persistence leaking into the domain. */
  CoreTouchesExternal = "core-touches-external",
}

/** Calls that run against the onion: only these directions are flagged, the rest are normal. */
export enum EdgeViolation {
  /** core or an outbound adapter calling a request handler: the dependency points outward. */
  CallsIntoInboundAdapter = "calls-into-inbound-adapter",
  /** A request handler calling an outbound adapter directly, with no core in between. */
  SkipsCore = "skips-core",
}

export enum ZoneSource {
  /** Framework, external system, test double: what the component is, not a judgement. */
  Fixed = "fixed",
  Rule = "rule",
  Inferred = "inferred",
}

export interface GraphNode {
  id: string;
  kind: ComponentKind;
  label: string;
  qualifiedName: string | null;
  zone: Zone;
  zoneSource: ZoneSource;
  /** Why it has this zone: the rule (pattern and reason) or the observed behaviour. */
  zoneReason: string;
  smells: Smell[];
  calls: number;
  instances: number;
  scenarioIds: string[];
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  calls: number;
  scenarioIds: string[];
  violation: EdgeViolation | null;
}

export interface SystemGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphOptions {
  /** Defaults to the test body only; include Setup to see app startup and fixtures. */
  phases?: Phase[];
  /** Restrict to these scenarios (by nodeid); defaults to all. */
  scenarioIds?: string[];
  grouping?: Grouping;
  rules?: ZoneRules;
}

const DEFAULT_PHASES = [Phase.Call];
const DECLARED_ZONE: Record<DeclaredZone, Zone> = {
  [DeclaredZone.InboundAdapter]: Zone.InboundAdapter,
  [DeclaredZone.Core]: Zone.Core,
  [DeclaredZone.OutboundAdapter]: Zone.OutboundAdapter,
};
const EDGE_KINDS = new Set([ComponentKind.Client, ComponentKind.Entry, ComponentKind.Middleware, ComponentKind.Router]);

export function buildSystemGraph(run: Run, options: GraphOptions = {}): SystemGraph {
  const phases = new Set(options.phases ?? DEFAULT_PHASES);
  const wanted = options.scenarioIds ? new Set(options.scenarioIds) : null;
  const builder = new GraphBuilder(run, options.grouping ?? FINE_GROUPING, options.rules ?? ZoneRules.none());

  for (const scenario of run.scenarios) {
    if (wanted !== null && !wanted.has(scenario.nodeid)) continue;
    builder.addScenario(scenario, phases);
  }
  return builder.build();
}

class NodeTally {
  calls = 0;
  readonly scenarioIds = new Set<string>();
  readonly objectIds = new Set<string>();
  calledByFramework = false;
  isRouteHandler = false;
  readonly externalSystems = new Set<string>();

  constructor(readonly ref: ComponentRef) {}
}

class EdgeTally {
  calls = 0;
  /** Calls other than constructors: building an object is wiring, calling it is use. */
  uses = 0;
  readonly scenarioIds = new Set<string>();

  constructor(
    readonly from: string,
    readonly to: string,
  ) {}
}

class GraphBuilder {
  private readonly nodes = new Map<string, NodeTally>();
  private readonly edges = new Map<string, EdgeTally>();
  private readonly routeHandlers: Set<string>;
  private readonly inboundPackage: string | null;
  private readonly middlewareCount: number;

  constructor(
    run: Run,
    private readonly grouping: Grouping,
    private readonly rules: ZoneRules,
  ) {
    this.middlewareCount = run.topology?.middleware.length ?? 0;
    this.routeHandlers = new Set((run.topology?.routes ?? []).map((route) => route.handler));
    this.inboundPackage = inboundPackageOf(run);
  }

  addScenario(scenario: Scenario, phases: Set<Phase>): void {
    for (const span of scenario.spans) {
      if (!phases.has(span.phase)) continue;
      const ref = componentOf(span, this.grouping);
      const node = this.node(ref);
      node.calls += 1;
      node.scenarioIds.add(scenario.nodeid);
      if (span.obj !== null) node.objectIds.add(`${scenario.nodeid}#${span.obj.id}`);
      if (this.isRouteHandler(span)) node.isRouteHandler = true;

      const parent = span.parent;
      if (parent !== null) {
        const parentRef = componentOf(parent, this.grouping);
        if (parentRef.id !== ref.id) {
          this.edge(parentRef, ref, scenario.nodeid, span.fn.qualname.endsWith("__init__"));
          if (this.isFrameworkCallIntoInboundPackage(parentRef, ref)) {
            node.calledByFramework = true;
          }
        }
      }
    }
    for (const call of scenario.boundaryCalls) {
      if (!phases.has(call.phase) || call.caller === null) continue;
      const callerRef = componentOf(call.caller, this.grouping);
      const external = externalComponent(call.system);
      this.node(external).calls += 1;
      this.node(external).scenarioIds.add(scenario.nodeid);
      this.edge(callerRef, external, scenario.nodeid, false);
      this.node(callerRef).externalSystems.add(call.system);
    }
  }

  build(): SystemGraph {
    const nodes: GraphNode[] = [];
    const zones = new Map<string, Zone>();
    for (const tally of this.nodes.values()) {
      const placement = this.place(tally);
      zones.set(tally.ref.id, placement.zone);
      const callsExternal = tally.externalSystems.size > 0;
      const smells: Smell[] = [];
      if (placement.zone === Zone.InboundAdapter && callsExternal) smells.push(Smell.HandlerTouchesExternal);
      if (placement.zone === Zone.Core && callsExternal) smells.push(Smell.CoreTouchesExternal);
      nodes.push({
        id: tally.ref.id,
        kind: tally.ref.kind,
        label: tally.ref.id === MIDDLEWARE_CHAIN_ID ? `Middleware ×${this.middlewareCount}` : tally.ref.label,
        qualifiedName: tally.ref.qualifiedName,
        zone: placement.zone,
        zoneSource: placement.source,
        zoneReason: placement.reason,
        smells,
        calls: tally.calls,
        instances: tally.objectIds.size,
        scenarioIds: [...tally.scenarioIds].sort(),
      });
    }
    const edges: GraphEdge[] = [];
    for (const [id, tally] of this.edges) {
      edges.push({
        id,
        from: tally.from,
        to: tally.to,
        calls: tally.calls,
        scenarioIds: [...tally.scenarioIds].sort(),
        // Constructing an adapter (dependency injection) isn't using it.
        violation: tally.uses > 0 ? violationOf(zones.get(tally.from), zones.get(tally.to)) : null,
      });
    }
    nodes.sort((a, b) => a.id.localeCompare(b.id));
    edges.sort((a, b) => a.id.localeCompare(b.id));
    return { nodes, edges };
  }

  private place(tally: NodeTally): { zone: Zone; source: ZoneSource; reason: string } {
    const fixed = fixedZoneOf(tally.ref);
    if (fixed !== null) return { zone: fixed, source: ZoneSource.Fixed, reason: "framework, test or external code" };
    if (tally.ref.qualifiedName !== null) {
      const match = this.rules.matchFor(tally.ref.qualifiedName);
      if (match !== null) {
        const decidedBy = match.rule.by === "llm" ? "proposed by a model, accepted" : "declared";
        return {
          zone: DECLARED_ZONE[match.rule.zone],
          source: ZoneSource.Rule,
          reason: `${decidedBy} in runshape.json (${match.rule.match}): ${match.rule.reason}`,
        };
      }
    }
    return { ...inferZone(tally, this.inboundPackage), source: ZoneSource.Inferred };
  }

  private node(ref: ComponentRef): NodeTally {
    let tally = this.nodes.get(ref.id);
    if (tally === undefined) {
      tally = new NodeTally(ref);
      this.nodes.set(ref.id, tally);
    }
    return tally;
  }

  private edge(from: ComponentRef, to: ComponentRef, scenarioId: string, constructs: boolean): void {
    this.node(from);
    const id = `${from.id}->${to.id}`;
    let tally = this.edges.get(id);
    if (tally === undefined) {
      tally = new EdgeTally(from.id, to.id);
      this.edges.set(id, tally);
    }
    tally.calls += 1;
    if (!constructs) tally.uses += 1;
    tally.scenarioIds.add(scenarioId);
  }

  /**
   * The framework also calls model validators and serializers while building responses;
   * those aren't adapters. Only framework calls into the package that holds the route
   * handlers (e.g. app.api: routes and their dependencies) mark an inbound adapter.
   */
  private isFrameworkCallIntoInboundPackage(caller: ComponentRef, callee: ComponentRef): boolean {
    if (caller.kind !== ComponentKind.Router && caller.kind !== ComponentKind.Middleware) return false;
    if (this.inboundPackage === null || callee.qualifiedName === null) return true;
    return callee.qualifiedName.startsWith(`${this.inboundPackage}.`);
  }

  private isRouteHandler(span: Span): boolean {
    const qualified = `${span.fn.module}.${span.fn.qualname}`;
    if (this.routeHandlers.has(qualified)) return true;
    // Class-based views (Django/DRF) register the class; the span is one of its methods.
    const owner = qualified.slice(0, qualified.lastIndexOf("."));
    return this.routeHandlers.has(owner);
  }
}

function fixedZoneOf(ref: ComponentRef): Zone | null {
  if (ref.id === CLIENT_ID || EDGE_KINDS.has(ref.kind)) return Zone.Edge;
  if (ref.kind === ComponentKind.External) return Zone.External;
  if (ref.kind === ComponentKind.TestDouble) return Zone.TestDouble;
  return null;
}

function inferZone(tally: NodeTally, inboundPackage: string | null): { zone: Zone; reason: string } {
  if (tally.isRouteHandler) return { zone: Zone.InboundAdapter, reason: "handles a route" };
  if (tally.calledByFramework) {
    return { zone: Zone.InboundAdapter, reason: `the framework calls it while serving requests${inboundPackage ? ` (in ${inboundPackage})` : ""}` };
  }
  if (tally.externalSystems.size > 0) {
    return { zone: Zone.OutboundAdapter, reason: `calls ${[...tally.externalSystems].sort().join(", ")} directly` };
  }
  return { zone: Zone.Core, reason: "receives no requests and calls no external system" };
}

/**
 * Runtime calls in an onion go inward (adapter -> core) or, through a port, from core out
 * to an outbound adapter. Calling a request handler from further in, or reaching a
 * repository straight from a handler, is the shape the onion is meant to prevent.
 */
function violationOf(from: Zone | undefined, to: Zone | undefined): EdgeViolation | null {
  if (to === Zone.InboundAdapter && (from === Zone.Core || from === Zone.OutboundAdapter)) {
    return EdgeViolation.CallsIntoInboundAdapter;
  }
  if (from === Zone.InboundAdapter && to === Zone.OutboundAdapter) return EdgeViolation.SkipsCore;
  return null;
}

/**
 * One level above the package(s) holding the route handlers, so the handlers' siblings
 * (dependencies, error handlers) count too: app.api for handlers in app.api.routes.*,
 * whether there is one route module or twenty. Null when handlers share no package.
 */
function inboundPackageOf(run: Run): string | null {
  const projectModules = new Set(run.catalog.map((f) => f.module));
  const handlerPackages: string[][] = [];
  for (const route of run.topology?.routes ?? []) {
    const module = longestModulePrefix(route.handler, projectModules);
    if (module !== null) handlerPackages.push(module.split(".").slice(0, -1));
  }
  const first = handlerPackages[0];
  if (first === undefined) return null;
  let common = first.length;
  for (const segments of handlerPackages) {
    let shared = 0;
    while (shared < common && segments[shared] === first[shared]) shared += 1;
    common = shared;
  }
  if (common === 0) return null;
  return first.slice(0, Math.max(common - 1, 1)).join(".");
}

function longestModulePrefix(qualified: string, modules: Set<string>): string | null {
  const segments = qualified.split(".");
  for (let length = segments.length - 1; length > 0; length -= 1) {
    const candidate = segments.slice(0, length).join(".");
    if (modules.has(candidate)) return candidate;
  }
  return null;
}
