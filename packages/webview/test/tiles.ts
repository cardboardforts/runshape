import type { Tile } from "../src/three/floor";

/** Pairs of tiles whose footprints overlap on the floor, at the same elevation. */
export function overlappingTiles(tiles: Map<string, Tile>): string[] {
  const all = [...tiles.values()];
  const overlapping: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i]!;
      const b = all[j]!;
      const apart = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
      if (a.y === b.y && apart < (a.size + b.size) / 2) overlapping.push(`${a.id} / ${b.id}`);
    }
  }
  return overlapping;
}
