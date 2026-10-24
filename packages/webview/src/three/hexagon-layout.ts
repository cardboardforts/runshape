import { zonePosition } from "@runshape/architecture";
import { ComponentKind, FixedZone, GraphNode, SystemGraph } from "@runshape/kernel";

import { byLabel, FloorLayout, MAX_TILE, Tile, TILE_SPACING, tileSize } from "./floor";

export { tileSize, TILE_GAP } from "./floor";
export type { Tile } from "./floor";

const MIN_RADIUS = 40;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Adapters stand just inside the hexagon's edge, at this fraction of its radius. */
const ADAPTER_RING = 0.86;
const INBOUND_ARC: [number, number] = [120, 240];
const OUTBOUND_ARC: [number, number] = [-60, 60];
/** The router, last of the framework, stands this many radii left of the centre. */
const FRAMEWORK_GAP = 1.3;
const FRAMEWORK_ORDER = [ComponentKind.Client, ComponentKind.Entry, ComponentKind.Middleware, ComponentKind.Router];

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
export function layoutHexagon(graph: SystemGraph): FloorLayout {
  // By position, so any style drawn on the hexagon reads the same way: its first zone on the
  // inbound side, its last on the outbound side, the rest in the middle.
  const lastPosition = graph.profile.zones.length - 1;
  const at = (n: GraphNode) => zonePosition(graph.profile, n.zone);
  const core = graph.nodes.filter((n) => at(n) !== null && at(n) !== 0 && at(n) !== lastPosition).sort(byLabel);
  const inbound = graph.nodes.filter((n) => at(n) === 0).sort(byLabel);
  const outbound = graph.nodes.filter((n) => at(n) === lastPosition).sort(byLabel);
  const doubles = graph.nodes.filter((n) => n.zone === FixedZone.TestDouble).sort(byLabel);
  const externals = graph.nodes.filter((n) => n.zone === FixedZone.External).sort(byLabel);
  const framework = graph.nodes
    .filter((n) => n.zone === FixedZone.Edge)
    .sort((a, b) => FRAMEWORK_ORDER.indexOf(a.kind) - FRAMEWORK_ORDER.indexOf(b.kind) || byLabel(a, b));

  const spacing = TILE_SPACING;
  const coreRadius = spacing * Math.sqrt(core.length) * 0.75;
  // The adapters on each side share a 120° arc, which must be long enough to hold them.
  const arcNeeded = (count: number) => (count * spacing * 3) / (2 * Math.PI);
  // Adapters stand on a ring at ADAPTER_RING × radius; that ring must clear the core's spiral.
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
    tiles.set(node.id, { id: node.id, x: r * Math.cos(theta), z: r * Math.sin(theta), y: 0, size: tileSize(node), angle: null });
  });
  placeOnArc(inbound, INBOUND_ARC, radius * ADAPTER_RING, tiles);
  placeOnArc(outbound, OUTBOUND_ARC, radius * ADAPTER_RING, tiles);
  placeOnArc(doubles, OUTBOUND_ARC, radius * 1.25, tiles);
  placeInColumn(externals, radius * 1.75, tiles);
  // Anchored at the hexagon and growing outward, so a long middleware chain never reaches in.
  framework.forEach((node, index) => {
    const x = -radius * FRAMEWORK_GAP - (framework.length - 1 - index) * spacing * 1.4;
    tiles.set(node.id, { id: node.id, x, z: 0, y: 0, size: tileSize(node), angle: null });
  });
  return { radius, tiles, floor: [{ corners: hexagonCorners(radius), y: 0, zone: null }] };
}

function placeOnArc(nodes: GraphNode[], [from, to]: [number, number], radius: number, tiles: Map<string, Tile>): void {
  nodes.forEach((node, index) => {
    // Evenly spaced, inset from the arc's ends so corners stay free.
    const angle = from + ((index + 0.5) / nodes.length) * (to - from);
    const radians = (angle * Math.PI) / 180;
    tiles.set(node.id, { id: node.id, x: radius * Math.cos(radians), z: -radius * Math.sin(radians), y: 0, size: tileSize(node), angle });
  });
}

function placeInColumn(nodes: GraphNode[], x: number, tiles: Map<string, Tile>): void {
  const spacing = MAX_TILE * 2;
  nodes.forEach((node, index) => {
    const z = (index - (nodes.length - 1) / 2) * spacing;
    tiles.set(node.id, { id: node.id, x, z, y: 0, size: MAX_TILE, angle: null });
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
