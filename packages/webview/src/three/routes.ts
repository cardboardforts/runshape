import { Zone, SystemGraph } from "@runshape/core";

import type { HexagonLayout } from "./hexagon-layout";

/**
 * How calls travel through the 3D scene. A call between two zones doesn't fly straight from
 * tile to tile: it rises, joins a trunk running between the two zones' hubs, and drops to
 * its target. Every call between the same pair of zones shares that trunk, so forty calls
 * read as a handful of bundles (Heapscape does the same for references between heap
 * regions). Calls within one zone, and along the framework chain, stay direct arcs.
 */
export type Point = [number, number, number];

export interface Route {
  edgeId: string;
  points: Point[];
  /** "inbound-adapter>outbound-adapter" for bundled calls; null for direct arcs. */
  trunk: string | null;
}

export interface Trunk {
  key: string;
  from: Point;
  to: Point;
  calls: number;
  edgeIds: string[];
}

/** Height of the tile tops calls leave from and arrive at. */
export const ATTACH_HEIGHT = 1.2;
const RISE = 5;
const TRUNK_BASE_HEIGHT = 14;
const TRUNK_HEIGHT_PER_UNIT = 0.08;
/** Hubs sit this far from their zone's centroid towards the floor's centre. */
const HUB_PULL = 0.25;
const BUNDLED_RINGS = new Set([Zone.InboundAdapter, Zone.Core, Zone.OutboundAdapter, Zone.TestDouble, Zone.External]);

export function routeEdges(graph: SystemGraph, layout: HexagonLayout): { routes: Route[]; trunks: Trunk[] } {
  const zoneOf = new Map(graph.nodes.map((node) => [node.id, node.zone]));
  const hubs = zoneHubs(graph, layout);
  const routes: Route[] = [];
  const trunks = new Map<string, Trunk>();

  for (const edge of graph.edges) {
    const from = layout.tiles.get(edge.from);
    const to = layout.tiles.get(edge.to);
    const fromZone = zoneOf.get(edge.from);
    const toZone = zoneOf.get(edge.to);
    if (!from || !to || fromZone === undefined || toZone === undefined) continue;
    const start: Point = [from.x, ATTACH_HEIGHT, from.z];
    const end: Point = [to.x, ATTACH_HEIGHT, to.z];

    const bundled = fromZone !== toZone && BUNDLED_RINGS.has(fromZone) && BUNDLED_RINGS.has(toZone);
    if (!bundled) {
      routes.push({ edgeId: edge.id, points: directArc(start, end), trunk: null });
      continue;
    }
    const key = `${fromZone}>${toZone}`;
    const hubFrom = hubs.get(fromZone)!;
    const hubTo = hubs.get(toZone)!;
    const height = TRUNK_BASE_HEIGHT + distance(hubFrom, hubTo) * TRUNK_HEIGHT_PER_UNIT;
    const trunkFrom: Point = [hubFrom[0], height, hubFrom[2]];
    const trunkTo: Point = [hubTo[0], height, hubTo[2]];
    routes.push({
      edgeId: edge.id,
      points: [start, [start[0], start[1] + RISE, start[2]], trunkFrom, trunkTo, [end[0], end[1] + RISE, end[2]], end],
      trunk: key,
    });
    const trunk = trunks.get(key) ?? { key, from: trunkFrom, to: trunkTo, calls: 0, edgeIds: [] };
    trunk.calls += edge.calls;
    trunk.edgeIds.push(edge.id);
    trunks.set(key, trunk);
  }
  return { routes, trunks: [...trunks.values()] };
}

/** Each zone's hub: the centroid of its tiles, pulled a little towards the floor's centre. */
function zoneHubs(graph: SystemGraph, layout: HexagonLayout): Map<Zone, Point> {
  const sums = new Map<Zone, { x: number; z: number; count: number }>();
  for (const node of graph.nodes) {
    const tile = layout.tiles.get(node.id);
    if (!tile) continue;
    const sum = sums.get(node.zone) ?? { x: 0, z: 0, count: 0 };
    sum.x += tile.x;
    sum.z += tile.z;
    sum.count += 1;
    sums.set(node.zone, sum);
  }
  const hubs = new Map<Zone, Point>();
  for (const [zone, sum] of sums) {
    const factor = (1 - HUB_PULL) / sum.count;
    hubs.set(zone, [sum.x * factor, 0, sum.z * factor]);
  }
  return hubs;
}

function directArc(start: Point, end: Point): Point[] {
  const lift = 6 + distance(start, end) * 0.22;
  const middle: Point = [(start[0] + end[0]) / 2, lift, (start[2] + end[2]) / 2];
  return [start, middle, end];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
