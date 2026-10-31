// The visual model: one zoom level reduced to what's drawn, positions included, computed once
// here and drawn as is by the 2D canvas and the 3D floor (and read by agents). Pure: no DOM.
import { Change, ComponentKind, FlatPoint, GraphEdge, GraphNode, Grouping, Layout, LayoutEdge, LayoutNode, SystemGraph, ZoomLevel } from "@runshape/kernel";

import { flowsDown, layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "./flat-layout";
import { layoutFloor } from "./layout-floor";

/**
 * At most this many boxes at one level; the quietest beyond it are left out (and counted).
 * Above about this many, the 2D canvas lags and no one reads the boxes anyway: that's when a
 * level needs to be opened up, not drawn whole.
 */
export const MAX_BOXES = 100;

/** Compare mode: how each box and call differs from the base, by id. */
export interface GraphChanges {
  nodes: Map<string, Change>;
  edges: Map<string, Change>;
}

export interface LayoutView {
  level: ZoomLevel;
  /** The boxes the graph was cut into (groupingAt): a module box opens into its module. */
  grouping: Grouping;
  changes?: GraphChanges | null;
}

/**
 * What the viewer draws at `view.level` of `graph` (already cut into that level's boxes): with
 * a module opened, its own boxes and the boxes they call or are called by; at most MAX_BOXES,
 * the busiest (and, comparing, every changed one) kept; each box placed for 2D and for 3D.
 */
export async function layout(graph: SystemGraph, view: LayoutView): Promise<Layout> {
  const changes = view.changes ?? null;
  const shown = view.level.kind === "module" ? openedModule(graph, view.level.module) : graph;
  const { kept, hidden } = capDetail(shown, changes);
  const { positions, problem } = await flatPositions(kept);
  const floor = layoutFloor(kept);
  const modules = new Set(view.grouping.modules ?? []);
  const nodes = kept.nodes.map(
    (node): LayoutNode => ({
      ...graphNode(node),
      flat: positions.get(node.id) ?? { x: 0, y: 0 },
      floor: withoutId(floor.tiles.get(node.id)),
      change: changes === null ? null : (changes.nodes.get(node.id) ?? Change.Unchanged),
      opens: node.kind === ComponentKind.Module && node.qualifiedName !== null && modules.has(node.qualifiedName) ? node.qualifiedName : null,
      arranged: false,
      placedNearNeighbours: false,
    }),
  );
  const edges = kept.edges.map((edge): LayoutEdge => ({ ...graphEdge(edge), change: changes === null ? null : (changes.edges.get(edge.id) ?? Change.Unchanged) }));
  return {
    level: view.level,
    grouping: view.grouping,
    profile: graph.profile,
    direction: flowsDown(kept) ? "down" : "right",
    nodes,
    edges,
    floor: { radius: floor.radius, pieces: floor.floor },
    hidden,
    flatProblem: problem,
  };
}

/** A module's own boxes, and the ones they call or are called by: the rest belongs to other modules. */
function openedModule(graph: SystemGraph, module: string): SystemGraph {
  const inside = new Set(graph.nodes.filter((node) => node.qualifiedName !== null && (node.qualifiedName === module || node.qualifiedName.startsWith(`${module}.`))).map((node) => node.id));
  const edges = graph.edges.filter((edge) => inside.has(edge.from) || inside.has(edge.to));
  const shown = new Set([...inside, ...edges.flatMap((edge) => [edge.from, edge.to])]);
  return { ...graph, nodes: graph.nodes.filter((node) => shown.has(node.id)), edges };
}

/** The request path (client, entry, middleware, router) is how every drawing reads: never left out. */
const ALWAYS_SHOWN = new Set([ComponentKind.Client, ComponentKind.Entry, ComponentKind.Middleware, ComponentKind.Router]);

function capDetail(graph: SystemGraph, changes: GraphChanges | null): { kept: SystemGraph; hidden: Layout["hidden"] } {
  if (graph.nodes.length <= MAX_BOXES) return { kept: graph, hidden: { nodes: 0, edges: 0, calls: 0 } };
  const changed = (node: GraphNode) => {
    const change = changes?.nodes.get(node.id);
    return change !== undefined && change !== Change.Unchanged;
  };
  const mustShow = (node: GraphNode) => ALWAYS_SHOWN.has(node.kind) || changed(node);
  // Busiest first; ties by id, so the same graph always keeps the same boxes.
  const ranked = [...graph.nodes].sort((a, b) => Number(mustShow(b)) - Number(mustShow(a)) || b.calls - a.calls || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const keptIds = new Set(ranked.slice(0, Math.max(MAX_BOXES, graph.nodes.filter(mustShow).length)).map((node) => node.id));
  const nodes = graph.nodes.filter((node) => keptIds.has(node.id));
  const edges = graph.edges.filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to));
  const hiddenEdges = graph.edges.filter((edge) => !keptIds.has(edge.from) || !keptIds.has(edge.to));
  return {
    kept: { ...graph, nodes, edges },
    hidden: { nodes: graph.nodes.length - nodes.length, edges: hiddenEdges.length, calls: hiddenEdges.reduce((total, edge) => total + edge.calls, 0) },
  };
}

/** Columns of this many when the layout engine fails: plain, but every box visible. */
const FALLBACK_COLUMNS = 6;
const FALLBACK_GAP = 24;

async function flatPositions(graph: SystemGraph): Promise<{ positions: Map<string, FlatPoint>; problem: string | null }> {
  try {
    return { positions: await layoutGraph(graph), problem: null };
  } catch (error) {
    const positions = new Map<string, FlatPoint>();
    graph.nodes.forEach((node, index) => {
      positions.set(node.id, { x: (index % FALLBACK_COLUMNS) * (NODE_WIDTH + FALLBACK_GAP), y: Math.floor(index / FALLBACK_COLUMNS) * (NODE_HEIGHT + FALLBACK_GAP) });
    });
    return { positions, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** A graph node's own fields: a compared node also carries the diff's, which aren't drawn. */
function graphNode(node: GraphNode): GraphNode {
  const { id, kind, label, qualifiedName, zone, zoneSource, zoneReason, smells, calls, instances, scenarioIds } = node;
  return { id, kind, label, qualifiedName, zone, zoneSource, zoneReason, smells, calls, instances, scenarioIds };
}

function graphEdge(edge: GraphEdge): GraphEdge {
  const { id, from, to, calls, scenarioIds, violation } = edge;
  return { id, from, to, calls, scenarioIds, violation };
}

function withoutId(tile: { id: string; x: number; y: number; z: number; size: number; angle: number | null } | undefined): LayoutNode["floor"] {
  if (tile === undefined) return { x: 0, y: 0, z: 0, size: 0, angle: null };
  return { x: tile.x, y: tile.y, z: tile.z, size: tile.size, angle: tile.angle };
}
