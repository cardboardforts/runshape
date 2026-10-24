/**
 * Bundling in the 3D scene, on the real FastAPI graph: calls between the same two zones
 * share one trunk; calls inside a zone, or along the framework chain, fly direct.
 */
import { describe, expect, test } from "vitest";

import { buildSystemGraph, HEXAGONAL, HexagonalZone } from "@runshape/architecture";
import { FixedZone, TraceDirectory } from "@runshape/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { layoutHexagon } from "../src/three/hexagon-layout";
import { routeEdges } from "../src/three/routes";

async function fastapiGraph() {
  const fixtures = join(import.meta.dirname, "..", "..", "core", "test", "fixtures", "fastapi");
  const run = await new TraceDirectory({ readText: (path) => readFile(join(fixtures, path), "utf8") }).latest();
  return buildSystemGraph(run, { grouping: { collapseMiddleware: true } });
}

describe("routeEdges", () => {
  test("calls between different zones collapse into six zone-to-zone trunks", async () => {
    const graph = await fastapiGraph();

    const { routes, trunks } = routeEdges(graph, layoutHexagon(graph));

    expect(routes).toHaveLength(graph.edges.length);
    expect(trunks.map((t) => `${t.key}: ${t.edgeIds.length} calls bundled`).sort()).toMatchInlineSnapshot(`
      [
        "core>outbound-adapter: 2 calls bundled",
        "inbound-adapter>core: 5 calls bundled",
        "inbound-adapter>outbound-adapter: 6 calls bundled",
        "inbound-adapter>test-double: 2 calls bundled",
        "outbound-adapter>core: 3 calls bundled",
        "outbound-adapter>external: 4 calls bundled",
      ]
    `);
  });

  test("bundled calls share their trunk's middle exactly; direct calls have no trunk", async () => {
    const graph = await fastapiGraph();
    const zone = new Map(graph.nodes.map((n) => [n.id, n.zone]));

    const { routes } = routeEdges(graph, layoutHexagon(graph));

    const inboundToOutbound = routes.filter((r) => r.trunk === `${HexagonalZone.InboundAdapter}>${HexagonalZone.OutboundAdapter}`);
    expect(inboundToOutbound.length).toBeGreaterThan(1);
    const middles = new Set(inboundToOutbound.map((r) => JSON.stringify(r.points.slice(2, 4))));
    expect(middles.size).toBe(1);

    for (const route of routes.filter((r) => r.trunk === null)) {
      const edge = graph.edges.find((e) => e.id === route.edgeId)!;
      const sameRing = zone.get(edge.from) === zone.get(edge.to);
      const framework = zone.get(edge.from) === FixedZone.Edge || zone.get(edge.to) === FixedZone.Edge;
      expect(sameRing || framework, route.edgeId).toBe(true);
      expect(route.points).toHaveLength(3);
    }
  });
});
