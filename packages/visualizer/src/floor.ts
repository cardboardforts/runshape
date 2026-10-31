import { FloorPiece, FloorTile, GraphNode } from "@runshape/kernel";

/** Where one component stands on the 3D floor, by its node's id. */
export interface Tile extends FloorTile {
  id: string;
}

/** A 3D floor: every component's tile, and the pieces of floor they stand on. */
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
