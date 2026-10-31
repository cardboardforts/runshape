import { describe, expect, test } from "vitest";

import { MAX_OBJECTS_SHOWN, objectSlots } from "../src/three/object-slots";

describe("objectSlots", () => {
  test("one slot per object (up to the cap), all distinct, floating above their tile, even on a terrace", () => {
    const tile = { id: "class:app.Repo", x: 10, y: 24, z: -4, size: 8, angle: null };

    const slots = objectSlots(tile, 5);
    const capped = objectSlots(tile, 500);

    expect(slots).toHaveLength(5);
    expect(new Set(slots.map((s) => s.join(","))).size).toBe(5);
    expect(slots.every(([x, y, z]) => y > tile.y + 1.2 && Math.abs(x - tile.x) < tile.size && Math.abs(z - tile.z) < tile.size)).toBe(true);
    expect(capped).toHaveLength(MAX_OBJECTS_SHOWN);
  });
});
