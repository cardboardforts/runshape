import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk.bundled.js";

import { ComponentKind, FixedZone, GraphNode, LayoutShape, SystemGraph, zonePosition } from "@runshape/core";

export const NODE_WIDTH = 188;
export const NODE_HEIGHT = 46;

export interface Positioned {
  x: number;
  y: number;
}

/** Client, entry, middleware and router take partitions 0–3. */
const FIRST_STYLE_PARTITION = 4;

/**
 * Left to right, the way a request travels: client, framework edge, then the style's
 * zones in order, then the outside world. Partitions force that column order even when a
 * test reaches past the edge straight into a repository.
 */
function partitionOf(node: GraphNode, graph: SystemGraph): number {
  switch (node.kind) {
    case ComponentKind.Client:
      return 0;
    case ComponentKind.Entry:
      return 1;
    case ComponentKind.Middleware:
      return 2;
    case ComponentKind.Router:
      return 3;
    default:
      break;
  }
  const position = zonePosition(graph.profile, node.zone);
  if (position !== null) return FIRST_STYLE_PARTITION + position;
  switch (node.zone) {
    case FixedZone.TestDouble:
      return FIRST_STYLE_PARTITION + graph.profile.zones.length;
    case FixedZone.External:
      return FIRST_STYLE_PARTITION + graph.profile.zones.length + 1;
    default:
      return FIRST_STYLE_PARTITION;
  }
}

const elk = new ELK();

/** Layers are drawn as bands, top to bottom; every other style flows left to right. */
export function flowsDown(graph: SystemGraph): boolean {
  return graph.profile.layout === LayoutShape.Bands;
}

interface ElkSettings {
  /** Folds a long, flat graph into rows nearer the canvas's shape. */
  wrapping: "SINGLE_EDGE" | "OFF";
  /** Keeps zones in column order (partitionOf). */
  partitioned: boolean;
}

/**
 * Best first. ELK crashes inside itself on some graph shapes: with wrapping on about 6% of
 * random graphs, with partitioning on rarer ones (test/layout.test.ts). Each fallback gives
 * up one nicety; the last places every node, just not in zone columns.
 */
const ATTEMPTS: ElkSettings[] = [
  { wrapping: "SINGLE_EDGE", partitioned: true },
  { wrapping: "OFF", partitioned: true },
  { wrapping: "OFF", partitioned: false },
];

export async function layoutGraph(graph: SystemGraph): Promise<Map<string, Positioned>> {
  let laidOut: ElkNode | null = null;
  let lastError: unknown = null;
  for (const settings of ATTEMPTS) {
    try {
      laidOut = await elk.layout(elkGraph(graph, settings));
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (laidOut === null) throw lastError;
  const positions = new Map<string, Positioned>();
  for (const child of laidOut.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  return positions;
}

function elkGraph(graph: SystemGraph, { wrapping, partitioned }: ElkSettings): ElkNode {
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": flowsDown(graph) ? "DOWN" : "RIGHT",
      "elk.partitioning.activate": String(partitioned),
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.spacing.nodeNode": "18",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.crossingMinimization.semiInteractive": "false",
      "elk.layered.wrapping.strategy": wrapping,
      "elk.aspectRatio": "1.6",
    },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      layoutOptions: partitioned ? { "elk.partitioning.partition": String(partitionOf(node, graph)) } : ({} as Record<string, string>),
    })),
    edges: graph.edges.map((edge) => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })),
  };
}
