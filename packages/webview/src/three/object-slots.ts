import type { FloorTile } from "@runshape/kernel";

export const OBJECT_SIDE = 1.6;
const OBJECT_FLOOR = 5;
export const MAX_OBJECTS_SHOWN = 16;

/**
 * Where a component's live objects float: a small square grid above its tile, a few
 * staggered heights so a crowd reads as a cloud rather than a slab.
 */
export function objectSlots(tile: FloorTile, count: number): [number, number, number][] {
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
