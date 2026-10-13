/**
 * The 3D floor is a literal hexagon: these are the placement promises the scene relies on,
 * checked on the real FastAPI recording's graph.
 */
import { describe, expect, test } from "vitest";

import { buildSystemGraph, loadLatestRun, Ring } from "@hexvis/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { layoutHexagon, MAX_OBJECTS_SHOWN, objectSlots } from "../src/three/hexagon-layout";

async function fastapiGraph() {
  const fixtures = join(import.meta.dirname, "..", "..", "core", "test", "fixtures", "fastapi");
  const run = await loadLatestRun({ readText: (path) => readFile(join(fixtures, path), "utf8") });
  return buildSystemGraph(run, { grouping: { collapseMiddleware: true } });
}

const angleOf = (x: number, z: number) => {
  const degrees = (Math.atan2(-z, x) * 180) / Math.PI;
  return degrees < -90 ? degrees + 360 : degrees;
};

describe("layoutHexagon", () => {
  test("inbound adapters face the incoming traffic, outbound the outside world, core in the middle", async () => {
    const graph = await fastapiGraph();
    const { radius, tiles } = layoutHexagon(graph);

    for (const node of graph.nodes) {
      const tile = tiles.get(node.id)!;
      const distance = Math.hypot(tile.x, tile.z);
      const angle = angleOf(tile.x, tile.z);
      if (node.ring === Ring.InboundAdapter) {
        expect(angle, node.label).toBeGreaterThanOrEqual(120);
        expect(angle, node.label).toBeLessThanOrEqual(240);
      }
      if (node.ring === Ring.OutboundAdapter) expect(Math.abs(angle), node.label).toBeLessThanOrEqual(60);
      if (node.ring === Ring.Core) expect(distance, node.label).toBeLessThan(radius * 0.7);
      if (node.ring === Ring.External) expect(tile.x, node.label).toBeGreaterThan(radius);
      if (node.ring === Ring.Edge) expect(tile.x, node.label).toBeLessThan(-radius);
    }
    expect(tiles.size).toBe(graph.nodes.length);
  });

  test("no two tiles overlap", async () => {
    const { tiles } = layoutHexagon(await fastapiGraph());
    const all = [...tiles.values()];

    const overlapping: string[] = [];
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = all[i]!;
        const b = all[j]!;
        const apart = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
        if (apart < (a.size + b.size) / 2) overlapping.push(`${a.id} / ${b.id}`);
      }
    }
    expect(overlapping).toEqual([]);
  });
});

describe("objectSlots", () => {
  test("one slot per object (up to the cap), all distinct, floating above their tile", () => {
    const tile = { id: "class:app.Repo", x: 10, z: -4, size: 8, angle: null };

    const slots = objectSlots(tile, 5);
    const capped = objectSlots(tile, 500);

    expect(slots).toHaveLength(5);
    expect(new Set(slots.map((s) => s.join(","))).size).toBe(5);
    expect(slots.every(([x, y, z]) => y > 1.2 && Math.abs(x - tile.x) < tile.size && Math.abs(z - tile.z) < tile.size)).toBe(true);
    expect(capped).toHaveLength(MAX_OBJECTS_SHOWN);
  });
});
