/**
 * Bundling in the 3D scene, on the real FastAPI graph laid out by the session (as the viewer
 * gets it): calls between the same two zones share one trunk; calls inside a zone, or along the
 * framework chain, fly direct.
 */
import { describe, expect, test } from "vitest";

import { FixedZone, Layout, Phase, TraceDirectory } from "@runshape/kernel";
import { ViewerSession } from "@runshape/workflows";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { routeEdges } from "../src/three/routes";

async function fastapiLayout(): Promise<Layout> {
  const fixtures = join(import.meta.dirname, "..", "..", "kernel", "test", "fixtures", "fastapi");
  const run = await new TraceDirectory({ readText: (path) => readFile(join(fixtures, path), "utf8") }).latest();
  const response = await new ViewerSession(run, { sources: { readLines: async () => null } }).handle({ type: "graph", phases: [Phase.Call], grouping: { collapseMiddleware: true } });
  if (response?.type !== "graph") throw new Error(`expected a layout, got ${JSON.stringify(response)}`);
  return response.layout;
}

describe("routeEdges", () => {
  test("calls between different zones collapse into six zone-to-zone trunks", async () => {
    const graph = await fastapiLayout();

    const { routes, trunks } = routeEdges(graph);

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
    const graph = await fastapiLayout();
    const zone = new Map(graph.nodes.map((n) => [n.id, n.zone]));

    const { routes } = routeEdges(graph);

    const inboundToOutbound = routes.filter((r) => r.trunk === "inbound-adapter>outbound-adapter");
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
