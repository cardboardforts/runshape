import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk.bundled.js";

import { ComponentKind, GraphNode, Zone, SystemGraph } from "@hexvis/core";

export const NODE_WIDTH = 188;
export const NODE_HEIGHT = 46;

export interface Positioned {
  x: number;
  y: number;
}

/**
 * Left to right, the way a request travels: client, framework edge, then the onion's
 * zones, then the outside world. Partitions force that column order even when a test
 * reaches past the edge straight into a repository.
 */
function partitionOf(node: GraphNode): number {
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
  switch (node.zone) {
    case Zone.InboundAdapter:
      return 4;
    case Zone.Core:
      return 5;
    case Zone.OutboundAdapter:
      return 6;
    case Zone.TestDouble:
      return 7;
    case Zone.External:
      return 8;
    default:
      return 5;
  }
}

const elk = new ELK();

export async function layoutGraph(graph: SystemGraph): Promise<Map<string, Positioned>> {
  const root: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.partitioning.activate": "true",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.spacing.nodeNode": "18",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.crossingMinimization.semiInteractive": "false",
      // Long request chains make a very wide, short graph; wrap it into rows nearer the
      // canvas's shape so it stays legible when fitted.
      "elk.layered.wrapping.strategy": "MULTI_EDGE",
      "elk.aspectRatio": "1.6",
    },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      layoutOptions: { "elk.partitioning.partition": String(partitionOf(node)) },
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
