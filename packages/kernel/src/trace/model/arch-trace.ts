// The trace seen through an architecture: the styles a codebase is drawn in, and the system
// graph (components, the calls between them, each one's zone). Every module reads these; the
// arch module builds them (buildSystemGraph) and owns the styles themselves (profiles.ts).
import type { ComponentKind } from "./components";

export enum ArchitectureStyle {
  Hexagonal = "hexagonal",
  Layered = "layered",
  Mvc = "mvc",
  Mvvm = "mvvm",
  Mvp = "mvp",
}

/** How a style is drawn: the hexagon floor, stacked bands, or a triangle of three roles. */
export enum LayoutShape {
  Hexagon = "hexagon",
  Bands = "bands",
  Triangle = "triangle",
}

/** Zones every style shares; they describe what code is, so no rule or style changes them. */
export enum FixedZone {
  /** The client and the framework's request path: entry, middleware, router. */
  Edge = "edge",
  TestDouble = "test-double",
  External = "external",
}

export interface ZoneDefinition {
  id: string;
  name: string;
  meaning: string;
}

export interface ArchitectureProfile {
  style: ArchitectureStyle;
  name: string;
  layout: LayoutShape;
  /** In drawing order: the side facing the requests first. */
  zones: ZoneDefinition[];
  /** Calls the style permits between different zones; every other cross-zone call is a finding. */
  allowedCalls: [from: string, to: string][];
  /** What a forbidden call means, where there's more to say than "not allowed". */
  forbiddenBecause: Record<string, string>;
  /** Zones allowed to talk to external systems (databases, HTTP) directly. */
  externalAccess: string[];
  /** Words that, in module or class names, suggest each zone. */
  vocabulary: Record<string, string[]>;
  /** Place unplaced components by their names before their behaviour. */
  namesFirst: boolean;
  /** What runtime behaviour means in this style, when no rule or name decides. */
  behaviour: { handlesRequests: string; callsExternal: string; otherwise: string };
}

/** Where a zone comes in the style's drawing order (0 faces the requests); null for a fixed zone. */
export function zonePosition(profile: ArchitectureProfile, zone: string): number | null {
  const index = profile.zones.findIndex((candidate) => candidate.id === zone);
  return index === -1 ? null : index;
}

/**
 * Where a component sits, in the active profile's zones (see profiles.ts): a FixedZone for
 * framework, test-double and external code, otherwise one of the style's own zones. A rule in
 * runshape.json decides when one matches; otherwise it's inferred, by the style's rules for
 * names and for runtime behaviour (does the framework hand it requests? does it call an
 * external system?).
 */
export type ZoneId = string;

export enum Smell {
  /** Talks to an external system directly from a zone the style says shouldn't. */
  TouchesExternal = "touches-external",
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
  zone: ZoneId;
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
  /** Why this call breaks the active style; null when the style allows it. */
  violation: string | null;
}

export interface SystemGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The style the graph was drawn in: its zones name and order what the viewer shows. */
  profile: ArchitectureProfile;
}

/** Two runs' graphs, drawn so they compare: one style, each side with its own rules. */
export interface ComparedGraphs {
  before: SystemGraph;
  after: SystemGraph;
}
