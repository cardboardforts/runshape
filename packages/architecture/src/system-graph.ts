import { ArchitectureProfile, CLIENT_ID, ComparedGraphs, ComponentKind, componentOf, ComponentRef, externalComponent, FINE_GROUPING, FixedZone, GraphEdge, GraphNode, Grouping, MIDDLEWARE_CHAIN_ID, Phase, QualifiedName, Run, Scenario, Smell, Span, SymbolKind, SystemGraph, ZoneId, ZoneSource } from "@runshape/kernel";

import { forbiddenCall, zoneFromName } from "./profiles";
import { ZoneRules } from "./zones";

export interface GraphOptions {
  /** Defaults to the test body only; include Setup to see app startup and fixtures. */
  phases?: Phase[];
  /** Restrict to these scenarios (by nodeid); defaults to all. */
  scenarioIds?: string[];
  grouping?: Grouping;
  /** The style to draw in; defaults to the rules file's style, else hexagonal. */
  profile?: ArchitectureProfile;
  rules?: ZoneRules;
}

const DEFAULT_PHASES = [Phase.Call];

const EDGE_KINDS = new Set([ComponentKind.Client, ComponentKind.Entry, ComponentKind.Middleware, ComponentKind.Router]);

/**
 * Two runs' graphs for a comparison: both in one style (the given one, else the rules'), so
 * their zones compare, and the base with its own rules (its commit's runshape.json), so a zone
 * a branch changed shows as a change. The base's rules for another style place nothing in it:
 * its code is inferred.
 */
export function comparedGraphs(
  before: Run,
  after: Run,
  options: { phases?: Phase[]; grouping?: Grouping; rules?: ZoneRules; baseRules?: ZoneRules; profile?: ArchitectureProfile | null } = {},
): ComparedGraphs {
  const rules = options.rules ?? ZoneRules.none();
  const profile = options.profile ?? rules.profile;
  const drawing = { phases: options.phases, grouping: options.grouping, profile };
  return { before: buildSystemGraph(before, { ...drawing, rules: options.baseRules ?? rules }), after: buildSystemGraph(after, { ...drawing, rules }) };
}

export function buildSystemGraph(run: Run, options: GraphOptions = {}): SystemGraph {
  const phases = new Set(options.phases ?? DEFAULT_PHASES);
  const wanted = options.scenarioIds ? new Set(options.scenarioIds) : null;
  const rules = options.rules ?? ZoneRules.none();
  const profile = options.profile ?? rules.profile;
  const builder = new GraphBuilder(run, options.grouping ?? FINE_GROUPING, profile, rules);

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
  /** QualifiedName keys. */
  private readonly routeHandlers: Set<string>;
  private readonly inboundPackage: QualifiedName | null;
  private readonly middlewareCount: number;

  constructor(
    run: Run,
    private readonly grouping: Grouping,
    private readonly profile: ArchitectureProfile,
    private readonly rules: ZoneRules,
  ) {
    this.middlewareCount = run.topology?.middleware.length ?? 0;
    this.routeHandlers = new Set((run.topology?.routes ?? []).map((route) => route.handler.key));
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
          this.edge(parentRef, ref, scenario.nodeid, span.fn.symbol.kind === SymbolKind.Constructor);
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
    const zones = new Map<string, ZoneId>();
    for (const tally of this.nodes.values()) {
      const placement = this.place(tally);
      zones.set(tally.ref.id, placement.zone);
      const callsExternal = tally.externalSystems.size > 0;
      const smells: Smell[] = [];
      if (callsExternal && this.isStyleZone(placement.zone) && !this.profile.externalAccess.includes(placement.zone)) {
        smells.push(Smell.TouchesExternal);
      }
      nodes.push({
        id: tally.ref.id,
        kind: tally.ref.kind,
        label: tally.ref.id === MIDDLEWARE_CHAIN_ID ? `Middleware ×${this.middlewareCount}` : tally.ref.label,
        qualifiedName: tally.ref.name?.text ?? null,
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
        violation: tally.uses > 0 ? forbiddenCall(this.profile, zones.get(tally.from) ?? "", zones.get(tally.to) ?? "") : null,
      });
    }
    nodes.sort((a, b) => a.id.localeCompare(b.id));
    edges.sort((a, b) => a.id.localeCompare(b.id));
    return { nodes, edges, profile: this.profile };
  }

  private isStyleZone(zone: ZoneId): boolean {
    return this.profile.zones.some((candidate) => candidate.id === zone);
  }

  private place(tally: NodeTally): { zone: ZoneId; source: ZoneSource; reason: string } {
    const fixed = fixedZoneOf(tally.ref);
    if (fixed !== null) return { zone: fixed, source: ZoneSource.Fixed, reason: "framework, test or external code" };
    // Rules name zones of the style they were written for; drawing another style ignores them.
    if (tally.ref.name !== null && this.rules.profile.style === this.profile.style) {
      const match = this.rules.matchFor(tally.ref.name);
      if (match !== null) {
        const decidedBy = match.rule.by === "llm" ? "proposed by a model, accepted" : "declared";
        return {
          zone: match.rule.zone,
          source: ZoneSource.Rule,
          reason: `${decidedBy} in runshape.json (${match.rule.match}): ${match.rule.reason}`,
        };
      }
    }
    return { ...inferZone(tally, this.profile, this.inboundPackage), source: ZoneSource.Inferred };
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
    if (this.inboundPackage === null || callee.name === null) return true;
    return this.inboundPackage.holds(callee.name);
  }

  private isRouteHandler(span: Span): boolean {
    const path = span.fn.symbol.path;
    if (this.routeHandlers.has(path.key)) return true;
    // Class-based views (Django/DRF) register the class; the span is one of its methods.
    const owner = path.parent();
    return owner !== null && this.routeHandlers.has(owner.key);
  }
}

function fixedZoneOf(ref: ComponentRef): FixedZone | null {
  if (ref.id === CLIENT_ID || EDGE_KINDS.has(ref.kind)) return FixedZone.Edge;
  if (ref.kind === ComponentKind.External) return FixedZone.External;
  if (ref.kind === ComponentKind.TestDouble) return FixedZone.TestDouble;
  return null;
}

/**
 * A component no rule places: by its name first if the style says names are telling
 * (layered, MVC), then by what it was seen doing.
 */
function inferZone(tally: NodeTally, profile: ArchitectureProfile, inboundPackage: QualifiedName | null): { zone: ZoneId; reason: string } {
  if (profile.namesFirst && tally.ref.name !== null) {
    const byName = zoneFromName(profile, tally.ref.name);
    if (byName !== null) {
      const zoneName = profile.zones.find((zone) => zone.id === byName.zone)?.name ?? byName.zone;
      return { zone: byName.zone, reason: `named like ${zoneName.toLowerCase()} code ("${byName.word}")` };
    }
  }
  const { handlesRequests, callsExternal, otherwise } = profile.behaviour;
  if (tally.isRouteHandler) return { zone: handlesRequests, reason: "handles a route" };
  if (tally.calledByFramework) {
    return { zone: handlesRequests, reason: `the framework calls it while serving requests${inboundPackage ? ` (in ${inboundPackage.text})` : ""}` };
  }
  if (tally.externalSystems.size > 0) {
    return { zone: callsExternal, reason: `calls ${[...tally.externalSystems].sort().join(", ")} directly` };
  }
  return { zone: otherwise, reason: "receives no requests and calls no external system" };
}

/**
 * One level above the package(s) holding the route handlers, so the handlers' siblings
 * (dependencies, error handlers) count too: app.api for handlers in app.api.routes.*,
 * whether there is one route module or twenty. Null when handlers share no package.
 */
function inboundPackageOf(run: Run): QualifiedName | null {
  const projectModules = new Set(run.catalog.map((f) => f.symbol.namespaceName.key));
  const handlerPackages: (readonly string[])[] = [];
  for (const route of run.topology?.routes ?? []) {
    const module = longestModulePrefix(route.handler, projectModules);
    if (module !== null) handlerPackages.push(module.segments.slice(0, -1));
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
  return new QualifiedName(first.slice(0, Math.max(common - 1, 1)));
}

/** The module a handler is defined in: the longest proper prefix that is a project module (by key). */
function longestModulePrefix(handler: QualifiedName, moduleKeys: Set<string>): QualifiedName | null {
  for (let length = handler.segments.length - 1; length > 0; length -= 1) {
    const candidate = new QualifiedName(handler.segments.slice(0, length));
    if (moduleKeys.has(candidate.key)) return candidate;
  }
  return null;
}
