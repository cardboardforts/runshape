import { ComponentKind, FixedZone, GraphNode, SystemGraph } from "@runshape/core";

import { byLabel, FloorLayout, FloorPiece, MAX_TILE, Tile, TILE_SPACING, tileSize } from "./floor";

/**
 * Layers as terraces. The first zone (presentation) is the highest step; each next zone is
 * one step lower and further back; the outside world stands on the ground behind the
 * lowest. A call down the layers runs downhill, so a call up — what layering forbids —
 * visibly climbs. Seen from the side:
 *
 *   framework ▸ ▔▔ presentation ▔▔
 *                      ▔▔ business ▔▔
 *                              ▔▔ data ▔▔  test doubles
 *                                        ⟶  external systems (ground)
 */
export const STEP_RISE = 12;
const MAX_PER_ROW = 8;
const TERRACE_MARGIN = TILE_SPACING * 0.6;
const FRAMEWORK_ORDER = [ComponentKind.Client, ComponentKind.Entry, ComponentKind.Middleware, ComponentKind.Router];

export function layoutBands(graph: SystemGraph): FloorLayout {
  const zones = graph.profile.zones;
  const tiles = new Map<string, Tile>();
  const floor: FloorPiece[] = [];
  const membersOf = (zone: string) => graph.nodes.filter((n) => n.zone === zone).sort(byLabel);
  const framework = graph.nodes
    .filter((n) => n.zone === FixedZone.Edge)
    .sort((a, b) => FRAMEWORK_ORDER.indexOf(a.kind) - FRAMEWORK_ORDER.indexOf(b.kind) || byLabel(a, b));
  const rowCounts = [framework.length, ...zones.map((zone) => membersOf(zone.id).length)];
  const widest = Math.max(1, ...rowCounts.map((count) => Math.min(MAX_PER_ROW, count)));
  const halfWidth = (widest * TILE_SPACING) / 2 + TERRACE_MARGIN;
  const topY = zones.length * STEP_RISE;

  // The framework's landing, level with the top terrace, in front of it.
  const landingDepth = framework.length > 0 ? stripDepth(framework.length) : 0;
  if (framework.length > 0) {
    placeInRows(framework, 0, landingDepth, topY, tiles);
    floor.push({ corners: rectangle(halfWidth, 0, landingDepth), y: topY, zone: null });
  }

  let front = landingDepth;
  zones.forEach((zone, position) => {
    const members = membersOf(zone.id);
    const depth = stripDepth(members.length);
    const y = topY - position * STEP_RISE;
    placeInRows(members, front, depth, y, tiles);
    floor.push({ corners: rectangle(halfWidth, front, depth), y, zone: zone.id });
    front += depth;
  });

  const lowest = topY - (zones.length - 1) * STEP_RISE;
  const doubles = graph.nodes.filter((n) => n.zone === FixedZone.TestDouble).sort(byLabel);
  doubles.forEach((node, index) => {
    tiles.set(node.id, { id: node.id, x: halfWidth + TILE_SPACING, y: lowest, z: front - TERRACE_MARGIN - (index + 0.5) * TILE_SPACING, size: tileSize(node), angle: null });
  });
  const externals = graph.nodes.filter((n) => n.zone === FixedZone.External).sort(byLabel);
  externals.forEach((node, index) => {
    tiles.set(node.id, { id: node.id, x: (index - (externals.length - 1) / 2) * MAX_TILE * 2, y: 0, z: front + TILE_SPACING * 1.5, size: MAX_TILE, angle: null });
  });

  // Centred on the origin front to back, so the grid and the camera sit under the middle.
  const middle = (front + TILE_SPACING * 1.5) / 2;
  for (const tile of tiles.values()) tile.z -= middle;
  for (const piece of floor) piece.corners = piece.corners.map(([x, z]) => [x, z - middle]);
  return { radius: Math.max(halfWidth, middle) * 1.2, tiles, floor };
}

/** Rows of up to MAX_PER_ROW, centred left to right, filling the strip [front, front + depth). */
function placeInRows(nodes: GraphNode[], front: number, depth: number, y: number, tiles: Map<string, Tile>): void {
  const rows = Math.max(1, Math.ceil(nodes.length / MAX_PER_ROW));
  nodes.forEach((node, index) => {
    const row = Math.floor(index / MAX_PER_ROW);
    const inRow = Math.min(MAX_PER_ROW, nodes.length - row * MAX_PER_ROW);
    const column = index % MAX_PER_ROW;
    const x = (column - (inRow - 1) / 2) * TILE_SPACING;
    const z = front + depth / 2 + (row - (rows - 1) / 2) * TILE_SPACING;
    tiles.set(node.id, { id: node.id, x, y, z, size: tileSize(node), angle: null });
  });
}

function stripDepth(count: number): number {
  return Math.max(1, Math.ceil(count / MAX_PER_ROW)) * TILE_SPACING + 2 * TERRACE_MARGIN;
}

function rectangle(halfWidth: number, front: number, depth: number): [number, number][] {
  return [
    [-halfWidth, front],
    [halfWidth, front],
    [halfWidth, front + depth],
    [-halfWidth, front + depth],
  ];
}
