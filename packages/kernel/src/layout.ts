// What the viewer draws at one zoom level, positions included: the visualizer's one output
// (`layout`), drawn as is by the 2D canvas and the 3D floor, and read by agents
// (`runshape view --json`). Shaped for the screen: the system graph is the domain.
import type { ArchitectureProfile, GraphEdge, GraphNode } from "./trace/model/arch-trace";
import type { Grouping } from "./trace/model/components";

/** How a box or a call differs from the recording compared against. */
export enum Change {
  Added = "added",
  Removed = "removed",
  Changed = "changed",
  Unchanged = "unchanged",
}

/**
 * How far in the viewer is: every class, one box per module, or one module opened (its classes,
 * every other module still one box).
 */
export type ZoomLevel = { kind: "classes" } | { kind: "modules" } | { kind: "module"; module: string };

/** The level a view's grouping and opened module (if any) are at. */
export function zoomLevelOf(grouping: Grouping, opened: string | null): ZoomLevel {
  if (opened !== null) return { kind: "module", module: opened };
  return grouping.modules === undefined ? { kind: "classes" } : { kind: "modules" };
}

/**
 * The boxes a level is cut into. An opened module's own code is drawn class by class; every
 * other module stays one box, so the calls leaving it land on whole modules, not on their classes.
 */
export function groupingAt(grouping: Grouping, opened: string | null): Grouping {
  if (opened === null || grouping.modules === undefined) return grouping;
  return { ...grouping, modules: grouping.modules.filter((module) => module !== opened) };
}

/** Saved arrangements are kept per level and style: a module laid out as layers isn't laid out as a hexagon. */
export function zoomLevelKey(level: ZoomLevel, style: string): string {
  return `${level.kind === "module" ? `module:${level.module}` : level.kind}@${style}`;
}

/** The 2D canvas: the box's top-left corner, in pixels. */
export interface FlatPoint {
  x: number;
  y: number;
}

/** The 3D floor (XZ plane, Y up): where a box stands, at what elevation, how big. */
export interface FloorTile {
  x: number;
  /** Elevation of the floor under the tile: 0 except on a terrace. */
  y: number;
  z: number;
  /** Footprint side length: bigger for components that do more. */
  size: number;
  /** Angle from the centre in degrees, for adapters on the hexagon's edge. */
  angle: number | null;
}

/** A flat piece of 3D floor: the hexagon, one terrace, or the triangle. */
export interface FloorPiece {
  corners: [x: number, z: number][];
  y: number;
  /** The zone the piece belongs to, for its colour; null for a shared floor. */
  zone: string | null;
}

export interface LayoutNode extends GraphNode {
  flat: FlatPoint;
  floor: FloorTile;
  /** Compare mode: how it differs from the base; null when not comparing. */
  change: Change | null;
  /** The module clicking it opens (a module box at the modules level); null opens its panel. */
  opens: string | null;
  /** Where a person put it, in 2D or 3D (a saved arrangement), rather than where the layout would. */
  arranged: boolean;
  /** New since the level was arranged: placed beside the arranged boxes it calls or is called by. */
  placedNearNeighbours: boolean;
}

export interface LayoutEdge extends GraphEdge {
  change: Change | null;
}

/** What the cap on detail left out of a level: the quietest boxes, and their calls. */
export interface HiddenDetail {
  nodes: number;
  edges: number;
  /** The calls the hidden boxes made or took, so "how much is missing" is answerable. */
  calls: number;
  /** Hidden calls against the style, and hidden boxes or calls that changed: what a reviewer can't afford to miss (kept, so 0 unless the cap couldn't). */
  violations: number;
  changes: number;
}

export interface Layout {
  level: ZoomLevel;
  /** The boxes this level is cut into: replays and timelines must be cut the same way. */
  grouping: Grouping;
  profile: ArchitectureProfile;
  /** Layers flow top to bottom in 2D; every other style left to right. */
  direction: "down" | "right";
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  floor: { radius: number; pieces: FloorPiece[] };
  hidden: HiddenDetail;
  /** Set when the 2D layout fell back to plain positions (the layout engine failed): why. */
  flatProblem: string | null;
  /** Set when a saved arrangement exists but was ignored (unreadable, too big): why. Set by whoever loaded it. */
  arrangementProblem: string | null;
}
