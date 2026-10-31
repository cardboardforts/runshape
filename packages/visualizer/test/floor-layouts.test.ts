/**
 * The 3D floors other styles stand on, checked on the real recordings: what the scene and
 * a viewer rely on being true of each shape.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { buildSystemGraph, profileFor } from "@runshape/architecture";
import { ArchitectureStyle, FixedZone, SystemGraph, TraceDirectory } from "@runshape/kernel";

import { layoutBands, STEP_RISE } from "../src/bands-layout";
import type { Tile } from "../src/floor";
import { layoutFloor } from "../src/layout-floor";
import { layoutTriangle } from "../src/triangle-layout";
import { overlappingTiles } from "./tiles";

async function graphOf(app: string, style: ArchitectureStyle, collapseMiddleware = true): Promise<SystemGraph> {
  const directory = join(import.meta.dirname, "..", "..", "kernel", "test", "fixtures", app);
  const run = await new TraceDirectory({ readText: (path) => readFile(join(directory, path), "utf8") }).latest();
  return buildSystemGraph(run, { grouping: { collapseMiddleware }, profile: profileFor(style) });
}

const tilesIn = (graph: SystemGraph, tiles: Map<string, Tile>, zone: string) => graph.nodes.filter((n) => n.zone === zone).map((n) => tiles.get(n.id)!);

describe("terraces (layered)", () => {
  test("each layer is one step below the one before and further back; the outside world is on the ground behind them", async () => {
    for (const app of ["fastapi", "django"]) {
      const graph = await graphOf(app, ArchitectureStyle.Layered);
      const { tiles, floor } = layoutBands(graph);

      const steps = graph.profile.zones.map((zone) => {
        const placed = tilesIn(graph, tiles, zone.id);
        return { zone: zone.id, heights: [...new Set(placed.map((t) => t.y))], front: Math.min(...placed.map((t) => t.z)), back: Math.max(...placed.map((t) => t.z)) };
      });
      expect(steps.map((s) => `${s.zone} at ${s.heights.join("/")}`), app).toEqual(["presentation at 36", "business at 24", "data at 12"]);
      for (let i = 1; i < steps.length; i += 1) expect(steps[i]!.front, app).toBeGreaterThan(steps[i - 1]!.back);
      const lowestBack = steps.at(-1)!.back;
      for (const external of tilesIn(graph, tiles, FixedZone.External)) {
        expect(external.y, app).toBe(0);
        expect(external.z, app).toBeGreaterThan(lowestBack);
      }
      for (const framework of tilesIn(graph, tiles, FixedZone.Edge)) {
        expect(framework.y, app).toBe(graph.profile.zones.length * STEP_RISE);
        expect(framework.z, app).toBeLessThan(steps[0]!.front);
      }
      // One terrace per layer plus the framework's landing, each at its layer's height.
      expect(floor.map((piece) => `${piece.zone ?? "landing"}@${piece.y}`), app).toEqual(["landing@36", "presentation@36", "business@24", "data@12"]);
      expect(overlappingTiles(tiles), app).toEqual([]);
      expect(tiles.size, app).toBe(graph.nodes.length);
    }
  });
});

describe("triangle (mvc, mvvm, mvp)", () => {
  test("each role clusters at its own corner; external systems stand beyond the corner allowed to reach them", async () => {
    for (const [app, style] of [["django", ArchitectureStyle.Mvc], ["fastapi", ArchitectureStyle.Mvc], ["fastapi", ArchitectureStyle.Mvvm]] as const) {
      const graph = await graphOf(app, style);
      const { tiles } = layoutTriangle(graph);
      const centroid = (placed: Tile[]) => [placed.reduce((a, t) => a + t.x, 0) / placed.length, placed.reduce((a, t) => a + t.z, 0) / placed.length] as const;
      // A role nothing plays (FastAPI has no MVC view) leaves its corner empty.
      const zones = graph.profile.zones.filter((zone) => tilesIn(graph, tiles, zone.id).length > 0);
      const corners = zones.map((zone) => centroid(tilesIn(graph, tiles, zone.id)));
      // Each zone fits in a disc around its centre (tiles' corners included), and no two discs meet.
      const extent = zones.map((zone, i) =>
        Math.max(...tilesIn(graph, tiles, zone.id).map((t) => Math.hypot(t.x - corners[i]![0], t.z - corners[i]![1]) + (t.size * Math.SQRT2) / 2)),
      );
      for (let i = 0; i < corners.length; i += 1) {
        for (let j = i + 1; j < corners.length; j += 1) {
          const apart = Math.hypot(corners[i]![0] - corners[j]![0], corners[i]![1] - corners[j]![1]);
          expect(apart, `${app} ${style}: ${zones[i]!.id} / ${zones[j]!.id}`).toBeGreaterThan(extent[i]! + extent[j]!);
        }
      }
      const reaching = zones.findIndex((zone) => graph.profile.externalAccess.includes(zone.id));
      const [cx, cz] = corners[reaching]!;
      const outward = Math.hypot(cx, cz);
      for (const external of tilesIn(graph, tiles, FixedZone.External)) {
        // Further out than the corner, on its side of the floor.
        expect((external.x * cx + external.z * cz) / outward, `${app} ${style}`).toBeGreaterThan(outward);
      }
      expect(overlappingTiles(tiles), `${app} ${style}`).toEqual([]);
      expect(tiles.size).toBe(graph.nodes.length);
    }
  });
});

describe("layoutFloor", () => {
  test("picks the floor from the style, and places every component with every middleware shown", async () => {
    const shapes: string[] = [];
    for (const style of Object.values(ArchitectureStyle)) {
      const graph = await graphOf("django", style, false);
      const layout = layoutFloor(graph);
      shapes.push(`${style}: ${layout.floor.length} floor piece(s), ${layout.tiles.size}/${graph.nodes.length} placed, ${overlappingTiles(layout.tiles).length} overlapping`);
    }
    expect(shapes).toMatchInlineSnapshot(`
      [
        "hexagonal: 1 floor piece(s), 37/37 placed, 0 overlapping",
        "layered: 4 floor piece(s), 37/37 placed, 0 overlapping",
        "mvc: 1 floor piece(s), 37/37 placed, 0 overlapping",
        "mvvm: 1 floor piece(s), 37/37 placed, 0 overlapping",
        "mvp: 1 floor piece(s), 37/37 placed, 0 overlapping",
      ]
    `);
  });
});
