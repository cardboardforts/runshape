// Architecture profiles: what a style's zones are, how calls may flow between them, which
// zones may reach the outside world, and how to place a component nobody has placed. The
// system graph, the rules file and the violations all take their vocabulary from the active
// profile; hexagonal is the default and reproduces the viewer's original behaviour exactly.

import type { QualifiedName } from "@runshape/trace";
import { ArchitectureProfile, ArchitectureStyle, LayoutShape } from "@runshape/trace";

/** The hexagonal profile's zone ids (also the ids of the original "rings"). */
export enum HexagonalZone {
  InboundAdapter = "inbound-adapter",
  Core = "core",
  OutboundAdapter = "outbound-adapter",
}

export const HEXAGONAL: ArchitectureProfile = {
  style: ArchitectureStyle.Hexagonal,
  name: "Hexagonal (ports and adapters)",
  layout: LayoutShape.Hexagon,
  zones: [
    { id: HexagonalZone.InboundAdapter, name: "Inbound adapters", meaning: "the framework hands it requests" },
    { id: HexagonalZone.Core, name: "Core", meaning: "domain and application logic; no I/O, no framework" },
    { id: HexagonalZone.OutboundAdapter, name: "Outbound adapters", meaning: "talks to the outside world for the core" },
  ],
  allowedCalls: [
    [HexagonalZone.InboundAdapter, HexagonalZone.Core],
    [HexagonalZone.Core, HexagonalZone.OutboundAdapter],
    [HexagonalZone.OutboundAdapter, HexagonalZone.Core],
  ],
  forbiddenBecause: {
    "inbound-adapter>outbound-adapter": "a request handler using an outbound adapter directly: no core in between",
    "core>inbound-adapter": "calls back into a request handler: the dependency points outward",
    "outbound-adapter>inbound-adapter": "calls back into a request handler: the dependency points outward",
  },
  externalAccess: [HexagonalZone.OutboundAdapter],
  vocabulary: {
    [HexagonalZone.InboundAdapter]: ["api", "routes", "handlers", "controllers", "cli", "consumers"],
    [HexagonalZone.Core]: ["domain", "core", "usecases", "use_cases", "services", "entities", "ports"],
    [HexagonalZone.OutboundAdapter]: ["adapters", "infrastructure", "infra", "repositories", "gateways", "clients", "db"],
  },
  // Kept behaviour-first: that's how the original rings were inferred.
  namesFirst: false,
  behaviour: { handlesRequests: HexagonalZone.InboundAdapter, callsExternal: HexagonalZone.OutboundAdapter, otherwise: HexagonalZone.Core },
};

export const PROFILES: ArchitectureProfile[] = [
  HEXAGONAL,
  {
    style: ArchitectureStyle.Layered,
    name: "Layered (n-tier, relaxed)",
    layout: LayoutShape.Bands,
    zones: [
      { id: "presentation", name: "Presentation", meaning: "routes, views, request and response schemas" },
      { id: "business", name: "Business", meaning: "services, rules, workflows" },
      { id: "data", name: "Data access", meaning: "repositories, queries, persistence" },
    ],
    // Relaxed layering: any layer may call any layer below it. Nothing calls up.
    allowedCalls: [
      ["presentation", "business"],
      ["business", "data"],
      ["presentation", "data"],
    ],
    forbiddenBecause: {
      "business>presentation": "a lower layer calling up into presentation",
      "data>presentation": "a lower layer calling up into presentation",
      "data>business": "data access calling up into business logic",
    },
    externalAccess: ["data"],
    vocabulary: {
      presentation: ["api", "routes", "views", "controllers", "schemas", "serializers", "web", "dependencies"],
      business: ["services", "business", "logic", "domain", "managers"],
      data: ["db", "repositories", "dal", "dao", "queries", "persistence", "models"],
    },
    namesFirst: true,
    behaviour: { handlesRequests: "presentation", callsExternal: "data", otherwise: "business" },
  },
  {
    style: ArchitectureStyle.Mvc,
    name: "Model–View–Controller (incl. Django's MVT)",
    layout: LayoutShape.Triangle,
    zones: [
      { id: "controller", name: "Controller", meaning: "receives the request, picks the model and the view" },
      { id: "model", name: "Model", meaning: "data and the rules on it (often active record)" },
      { id: "view", name: "View", meaning: "renders the response" },
    ],
    allowedCalls: [
      ["controller", "model"],
      ["controller", "view"],
      ["view", "model"],
    ],
    forbiddenBecause: {
      "model>controller": "a model calling its controller",
      "model>view": "a model rendering itself",
      "view>controller": "a view calling back into its controller",
    },
    externalAccess: ["model"],
    vocabulary: {
      controller: ["views", "controllers", "viewsets", "handlers"],
      model: ["models", "managers", "signals"],
      view: ["templates", "renderers", "serializers", "presenters"],
    },
    namesFirst: true,
    behaviour: { handlesRequests: "controller", callsExternal: "model", otherwise: "model" },
  },
  {
    style: ArchitectureStyle.Mvvm,
    name: "Model–View–ViewModel",
    layout: LayoutShape.Triangle,
    zones: [
      { id: "view", name: "View", meaning: "binds to the view model; no logic" },
      { id: "viewmodel", name: "View model", meaning: "state and commands for one view" },
      { id: "model", name: "Model", meaning: "data and services" },
    ],
    allowedCalls: [
      ["view", "viewmodel"],
      ["viewmodel", "model"],
    ],
    forbiddenBecause: {},
    externalAccess: ["model"],
    vocabulary: { view: ["views", "components", "pages"], viewmodel: ["viewmodels", "viewmodel", "stores", "composables"], model: ["models", "services", "api"] },
    namesFirst: true,
    behaviour: { handlesRequests: "view", callsExternal: "model", otherwise: "viewmodel" },
  },
  {
    style: ArchitectureStyle.Mvp,
    name: "Model–View–Presenter",
    layout: LayoutShape.Triangle,
    zones: [
      { id: "view", name: "View", meaning: "passive; forwards events to the presenter" },
      { id: "presenter", name: "Presenter", meaning: "decides what the view shows" },
      { id: "model", name: "Model", meaning: "data and services" },
    ],
    allowedCalls: [
      ["view", "presenter"],
      ["presenter", "view"],
      ["presenter", "model"],
    ],
    forbiddenBecause: {},
    externalAccess: ["model"],
    vocabulary: { view: ["views", "screens"], presenter: ["presenters", "presenter"], model: ["models", "services", "repositories"] },
    namesFirst: true,
    behaviour: { handlesRequests: "view", callsExternal: "model", otherwise: "presenter" },
  },
];

export function profileFor(style: string): ArchitectureProfile | undefined {
  return PROFILES.find((profile) => profile.style === style);
}

/** Where a zone sits in its style's drawing order (0 faces the requests), or null for fixed zones and other styles' zones. */
export function zonePosition(profile: ArchitectureProfile, zone: string): number | null {
  const index = profile.zones.findIndex((candidate) => candidate.id === zone);
  return index === -1 ? null : index;
}

export function isAllowedCall(profile: ArchitectureProfile, from: string, to: string): boolean {
  return from === to || profile.allowedCalls.some(([a, b]) => a === from && b === to);
}

/** Why a cross-zone call breaks the style, or null if the style allows it. */
export function forbiddenCall(profile: ArchitectureProfile, from: string, to: string): string | null {
  const own = new Set(profile.zones.map((zone) => zone.id));
  if (!own.has(from) || !own.has(to) || isAllowedCall(profile, from, to)) return null;
  return profile.forbiddenBecause[`${from}>${to}`] ?? `${from} → ${to} isn't a direction ${profile.name} allows`;
}

/** The zone a component's own name suggests: the innermost name segment the style recognises. */
export function zoneFromName(profile: ArchitectureProfile, name: QualifiedName): { zone: string; word: string } | null {
  const segments = name.segments.map((segment) => segment.toLowerCase());
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    for (const zone of profile.zones) {
      if ((profile.vocabulary[zone.id] ?? []).includes(segments[i]!)) return { zone: zone.id, word: segments[i]! };
    }
  }
  return null;
}
