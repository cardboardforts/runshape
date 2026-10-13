/**
 * The 3D floor is a literal hexagon: these are the placement promises the scene relies on,
 * checked on the real FastAPI recording's graph.
 */
import { describe, expect, test } from "vitest";

import { buildSystemGraph, FixedZone, HEXAGONAL, HexagonalZone, loadLatestRun } from "@runshape/core";
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
      if (node.zone === HexagonalZone.InboundAdapter) {
        expect(angle, node.label).toBeGreaterThanOrEqual(120);
        expect(angle, node.label).toBeLessThanOrEqual(240);
      }
      if (node.zone === HexagonalZone.OutboundAdapter) expect(Math.abs(angle), node.label).toBeLessThanOrEqual(60);
      if (node.zone === HexagonalZone.Core) expect(distance, node.label).toBeLessThan(radius * 0.7);
      if (node.zone === FixedZone.External) expect(tile.x, node.label).toBeGreaterThan(radius);
      if (node.zone === FixedZone.Edge) expect(tile.x, node.label).toBeLessThan(-radius);
    }
    expect(tiles.size).toBe(graph.nodes.length);
  });

  test("no two tiles overlap, on the real graph or on a big synthetic one", async () => {
    const real = await fastapiGraph();
    const node = (id: string, zone: string, calls: number) =>
      ({ id, kind: "class", label: id, qualifiedName: id, zone, zoneSource: "inferred", zoneReason: "", smells: [], calls, instances: 0, scenarioIds: [] }) as never;
    const big = {
      nodes: [
        ...Array.from({ length: 120 }, (_, i) => node(`core${i}`, HexagonalZone.Core, 1 + (i % 500))),
        ...Array.from({ length: 4 }, (_, i) => node(`in${i}`, HexagonalZone.InboundAdapter, 400)),
        ...Array.from({ length: 4 }, (_, i) => node(`out${i}`, HexagonalZone.OutboundAdapter, 400)),
      ],
      edges: [],
      profile: HEXAGONAL,
    };
    for (const graph of [real, big]) {
      const { tiles } = layoutHexagon(graph);
      expect(overlappingTiles(tiles)).toEqual([]);
      // Stronger than "nothing happens to overlap": the adapters' zone clears the whole
      // core region, whichever angle the core's outermost tiles end up at.
      const reach = (ids: string[], outward: 1 | -1) =>
        ids.map((id) => tiles.get(id)!).map((t) => Math.hypot(t.x, t.z) + (outward * t.size * Math.SQRT2) / 2);
      const coreIds = graph.nodes.filter((n) => n.zone === HexagonalZone.Core).map((n) => n.id);
      const adapterIds = graph.nodes.filter((n) => n.zone === HexagonalZone.InboundAdapter || n.zone === HexagonalZone.OutboundAdapter).map((n) => n.id);
      expect(Math.min(...reach(adapterIds, -1))).toBeGreaterThan(Math.max(...reach(coreIds, 1)));
    }
  });
});

function overlappingTiles(tiles: ReturnType<typeof layoutHexagon>["tiles"]): string[] {
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
  return overlapping;
}

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
