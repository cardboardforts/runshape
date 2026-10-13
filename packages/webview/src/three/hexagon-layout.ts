import { ComponentKind, GraphNode, Ring, SystemGraph } from "@hexvis/core";

/**
 * Places the system on a literal hexagon floor (XZ plane, Y up). The hexagon's vertices sit
 * at 30° + k·60°, so it has three sides facing the incoming traffic (left, 120°–240°) and
 * three facing the outside world (right, −60°–60°):
 *
 *   client → entry → middleware → router ⟶  ⟨ inbound │ core │ outbound ⟩ ⟶ external
 *
 * Core components spiral out from the centre; adapters stand on the hexagon's edge on their
 * side; test doubles just outside the outbound edge; external systems beyond it.
 */
export interface Tile {
  id: string;
  x: number;
  z: number;
  /** Footprint side length: bigger for components that do more. */
  size: number;
  /** Angle from the centre in degrees, for adapters on the edge. */
  angle: number | null;
}

export interface HexagonLayout {
  /** Distance from the centre to the hexagon's vertices. */
  radius: number;
  tiles: Map<string, Tile>;
}

export const TILE_GAP = 6;
const MIN_TILE = 5;
const MAX_TILE = 14;
const MIN_RADIUS = 40;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Adapters stand just inside the hexagon's edge, at this fraction of its radius. */
const ADAPTER_RING = 0.86;
const INBOUND_ARC: [number, number] = [120, 240];
const OUTBOUND_ARC: [number, number] = [-60, 60];
const FRAMEWORK_ORDER = [ComponentKind.Client, ComponentKind.Entry, ComponentKind.Middleware, ComponentKind.Router];

export function tileSize(node: GraphNode): number {
  return Math.min(MAX_TILE, MIN_TILE + Math.log2(node.calls + 1) * 0.9);
}

export function layoutHexagon(graph: SystemGraph): HexagonLayout {
  const byLabel = (a: GraphNode, b: GraphNode) => a.label.localeCompare(b.label);
  const core = graph.nodes.filter((n) => n.ring === Ring.Core).sort(byLabel);
  const inbound = graph.nodes.filter((n) => n.ring === Ring.InboundAdapter).sort(byLabel);
  const outbound = graph.nodes.filter((n) => n.ring === Ring.OutboundAdapter).sort(byLabel);
  const doubles = graph.nodes.filter((n) => n.ring === Ring.TestDouble).sort(byLabel);
  const externals = graph.nodes.filter((n) => n.ring === Ring.External).sort(byLabel);
  const framework = graph.nodes
    .filter((n) => n.ring === Ring.Edge)
    .sort((a, b) => FRAMEWORK_ORDER.indexOf(a.kind) - FRAMEWORK_ORDER.indexOf(b.kind) || byLabel(a, b));

  const spacing = MAX_TILE + TILE_GAP;
  const coreRadius = spacing * Math.sqrt(core.length) * 0.75;
  // The adapters on each side share a 120° arc, which must be long enough to hold them.
  const arcNeeded = (count: number) => (count * spacing * 3) / (2 * Math.PI);
  // Adapters stand at ADAPTER_RING × radius; that ring must clear the core's spiral.
  const radius = Math.max(
    MIN_RADIUS,
    (coreRadius + spacing * 1.2) / ADAPTER_RING,
    arcNeeded(inbound.length) / ADAPTER_RING,
    arcNeeded(outbound.length) / ADAPTER_RING,
  );

  const tiles = new Map<string, Tile>();
  core.forEach((node, index) => {
    const r = spacing * 0.75 * Math.sqrt(index + 0.5);
    const theta = index * GOLDEN_ANGLE;
    tiles.set(node.id, { id: node.id, x: r * Math.cos(theta), z: r * Math.sin(theta), size: tileSize(node), angle: null });
  });
  placeOnArc(inbound, INBOUND_ARC, radius * ADAPTER_RING, tiles);
  placeOnArc(outbound, OUTBOUND_ARC, radius * ADAPTER_RING, tiles);
  placeOnArc(doubles, OUTBOUND_ARC, radius * 1.25, tiles);
  placeInColumn(externals, radius * 1.75, tiles);
  framework.forEach((node, index) => {
    const x = -radius * 2.4 + index * spacing * 1.4;
    tiles.set(node.id, { id: node.id, x, z: 0, size: tileSize(node), angle: null });
  });
  return { radius, tiles };
}

function placeOnArc(nodes: GraphNode[], [from, to]: [number, number], radius: number, tiles: Map<string, Tile>): void {
  nodes.forEach((node, index) => {
    // Evenly spaced, inset from the arc's ends so corners stay free.
    const angle = from + ((index + 0.5) / nodes.length) * (to - from);
    const radians = (angle * Math.PI) / 180;
    tiles.set(node.id, { id: node.id, x: radius * Math.cos(radians), z: -radius * Math.sin(radians), size: tileSize(node), angle });
  });
}

function placeInColumn(nodes: GraphNode[], x: number, tiles: Map<string, Tile>): void {
  const spacing = MAX_TILE * 2;
  nodes.forEach((node, index) => {
    const z = (index - (nodes.length - 1) / 2) * spacing;
    tiles.set(node.id, { id: node.id, x, z, size: MAX_TILE, angle: null });
  });
}

/** The hexagon floor's corners, for drawing it. */
export function hexagonCorners(radius: number): [number, number][] {
  const corners: [number, number][] = [];
  for (let k = 0; k < 6; k += 1) {
    const radians = ((30 + k * 60) * Math.PI) / 180;
    corners.push([radius * Math.cos(radians), -radius * Math.sin(radians)]);
  }
  return corners;
}

export const OBJECT_SIDE = 1.6;
const OBJECT_FLOOR = 5;
export const MAX_OBJECTS_SHOWN = 16;

/**
 * Where a component's live objects float: a small square grid above its tile, a few
 * staggered heights so a crowd reads as a cloud rather than a slab.
 */
export function objectSlots(tile: Tile, count: number): [number, number, number][] {
  const shown = Math.min(count, MAX_OBJECTS_SHOWN);
  const perRow = Math.max(1, Math.ceil(Math.sqrt(shown)));
  const step = OBJECT_SIDE * 1.5;
  const slots: [number, number, number][] = [];
  for (let i = 0; i < shown; i += 1) {
    const row = Math.floor(i / perRow);
    const column = i % perRow;
    slots.push([tile.x + (column - (perRow - 1) / 2) * step, OBJECT_FLOOR + (i % 3) * 0.6, tile.z + (row - (perRow - 1) / 2) * step]);
  }
  return slots;
}
