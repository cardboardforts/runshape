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

export async function layoutGraph(graph: SystemGraph): Promise<Map<string, Positioned>> {
  const root: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": flowsDown(graph) ? "DOWN" : "RIGHT",
      "elk.partitioning.activate": "true",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.spacing.nodeNode": "18",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.crossingMinimization.semiInteractive": "false",
      // Long request chains make a very wide, short graph; wrap it into rows nearer the
      // canvas's shape so it stays legible when fitted. Not MULTI_EDGE: it crashes inside ELK
      // on some graphs (test/layout.test.ts).
      "elk.layered.wrapping.strategy": "SINGLE_EDGE",
      "elk.aspectRatio": "1.6",
    },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      layoutOptions: { "elk.partitioning.partition": String(partitionOf(node, graph)) },
    })),
    edges: graph.edges.map((edge) => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })),
  };
  const laidOut = await elk.layout(root);
  const positions = new Map<string, Positioned>();
  for (const child of laidOut.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  return positions;
}
