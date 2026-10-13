import { ComponentKind, FixedZone, GraphNode, SystemGraph } from "@runshape/core";

import { byLabel, FloorLayout, MAX_TILE, Tile, TILE_SPACING, tileSize } from "./floor";

/**
 * Three roles at the corners of a triangle (MVC, MVVM, MVP): the zone that takes requests at
 * the front left, where the framework hands them in; the next at the back; the last at the
 * front right. Each zone's components cluster around their corner. External systems stand
 * beyond the corner whose zone may reach them (the model), test doubles beside them, so a
 * controller or view that queries the database draws a line right across the floor.
 *
 *            [1]
 *           /   \
 *   ⟶ [0] ───── [2]          (+z, the front, faces the camera)
 */
const CORNER_ANGLES = [150, 270, 30];
const MIN_RADIUS = 45;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const FRAMEWORK_ORDER = [ComponentKind.Client, ComponentKind.Entry, ComponentKind.Middleware, ComponentKind.Router];

export function layoutTriangle(graph: SystemGraph): FloorLayout {
  const zones = graph.profile.zones;
  const tiles = new Map<string, Tile>();
  const members = zones.map((zone) => graph.nodes.filter((n) => n.zone === zone.id).sort(byLabel));
  const clusterRadius = (count: number) => TILE_SPACING * 0.75 * Math.sqrt(count) + MAX_TILE / 2;
  const widestCluster = Math.max(...members.map((nodes) => clusterRadius(nodes.length)));
  // Corners are R·√3 apart; that must clear two clusters and a gap between them.
  const radius = Math.max(MIN_RADIUS, (2 * widestCluster + TILE_SPACING) / Math.sqrt(3));
  const direction = (position: number): [number, number] => {
    const radians = ((CORNER_ANGLES[position % CORNER_ANGLES.length] ?? 0) * Math.PI) / 180;
    return [Math.cos(radians), Math.sin(radians)];
  };

  members.forEach((nodes, position) => {
    const [dx, dz] = direction(position);
    nodes.forEach((node, index) => {
      const r = TILE_SPACING * 0.75 * Math.sqrt(index + 0.5);
      const theta = index * GOLDEN_ANGLE;
      tiles.set(node.id, { id: node.id, x: radius * dx + r * Math.cos(theta), y: 0, z: radius * dz + r * Math.sin(theta), size: tileSize(node), angle: null });
    });
  });

  // The framework leads into the first corner from the left.
  const [entryX, entryZ] = direction(0).map((d) => d * radius) as [number, number];
  const framework = graph.nodes
    .filter((n) => n.zone === FixedZone.Edge)
    .sort((a, b) => FRAMEWORK_ORDER.indexOf(a.kind) - FRAMEWORK_ORDER.indexOf(b.kind) || byLabel(a, b));
  framework.forEach((node, index) => {
    const x = entryX - clusterRadius(members[0]?.length ?? 0) - TILE_SPACING * 1.4 * (framework.length - index);
    tiles.set(node.id, { id: node.id, x, y: 0, z: entryZ, size: tileSize(node), angle: null });
  });

  // The outside world beyond the corner allowed to reach it, spread across that direction.
  const reaching = Math.max(0, zones.findIndex((zone) => graph.profile.externalAccess.includes(zone.id)));
  const [ox, oz] = direction(reaching);
  const across: [number, number] = [-oz, ox];
  const beyond = radius + clusterRadius(members[reaching]?.length ?? 0);
  const spread = (nodes: GraphNode[], distance: number, gap: number) =>
    nodes.forEach((node, index) => {
      const offset = (index - (nodes.length - 1) / 2) * gap;
      tiles.set(node.id, { id: node.id, x: ox * distance + across[0] * offset, y: 0, z: oz * distance + across[1] * offset, size: node.zone === FixedZone.External ? MAX_TILE : tileSize(node), angle: null });
    });
  spread(graph.nodes.filter((n) => n.zone === FixedZone.TestDouble).sort(byLabel), beyond + TILE_SPACING * 1.2, TILE_SPACING);
  spread(graph.nodes.filter((n) => n.zone === FixedZone.External).sort(byLabel), beyond + TILE_SPACING * 2.6, MAX_TILE * 2);

  const floorReach = radius + widestCluster + TILE_SPACING * 0.5;
  // A triangle whose corners are pushed out far enough to hold each corner's cluster.
  const corners = zones.map((_, position) => direction(position).map((d) => d * floorReach * 1.6) as [number, number]);
  return { radius: floorReach * 1.6, tiles, floor: [{ corners, y: 0, zone: null }] };
}
