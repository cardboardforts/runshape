import { GraphNode } from "@runshape/trace";

/** Where one component stands: on the floor (XZ plane, Y up), at an elevation. */
export interface Tile {
  id: string;
  x: number;
  /** Elevation of the floor under the tile: 0 except on a terrace. */
  y: number;
  z: number;
  /** Footprint side length: bigger for components that do more. */
  size: number;
  /** Angle from the centre in degrees, for adapters on the hexagon's edge. */
  angle: number | null;
}

/** A flat piece of floor to draw: the hexagon, one terrace, or the triangle. */
export interface FloorPiece {
  corners: [x: number, z: number][];
  y: number;
  /** The zone the piece belongs to, for its colour; null for a shared floor. */
  zone: string | null;
}

export interface FloorLayout {
  /** Rough extent from the centre, for the grid under everything. */
  radius: number;
  tiles: Map<string, Tile>;
  floor: FloorPiece[];
}

export const TILE_GAP = 6;
export const MIN_TILE = 5;
export const MAX_TILE = 14;
/** Centre to centre between neighbouring tiles of the largest size. */
export const TILE_SPACING = MAX_TILE + TILE_GAP;

export function tileSize(node: GraphNode): number {
  return Math.min(MAX_TILE, MIN_TILE + Math.log2(node.calls + 1) * 0.9);
}

export const byLabel = (a: GraphNode, b: GraphNode) => a.label.localeCompare(b.label);

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
    slots.push([tile.x + (column - (perRow - 1) / 2) * step, tile.y + OBJECT_FLOOR + (i % 3) * 0.6, tile.z + (row - (perRow - 1) / 2) * step]);
  }
  return slots;
}
