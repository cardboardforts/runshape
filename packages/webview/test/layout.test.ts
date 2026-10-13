/**
 * The 2D layout on the real recordings, in every style. ELK's MULTI_EDGE graph wrapping
 * crashed inside ELK on FastAPI drawn as layered ("Cannot read properties of undefined"),
 * depending on nothing more than the graph's shape; SINGLE_EDGE wraps as well and doesn't.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { ArchitectureStyle, buildSystemGraph, loadLatestRun, profileFor } from "@runshape/core";

import { layoutGraph } from "../src/layout";

async function fixtureRun(app: string) {
  const directory = join(import.meta.dirname, "..", "..", "core", "test", "fixtures", app);
  return loadLatestRun({ readText: (path) => readFile(join(directory, path), "utf8") });
}

describe("2D layout", () => {
  test("every style lays out both example apps; layered reads top to bottom, the rest left to right", async () => {
    const outcomes: string[] = [];
    for (const app of ["fastapi", "django"]) {
      const run = await fixtureRun(app);
      for (const style of Object.values(ArchitectureStyle)) {
        const graph = buildSystemGraph(run, { grouping: { collapseMiddleware: true }, profile: profileFor(style) });
        const positions = await layoutGraph(graph);
        // Which way the style's own zones run: compare the average position of the first and last zone.
        const mean = (zone: string, axis: "x" | "y") => {
          const placed = graph.nodes.filter((n) => n.zone === zone).map((n) => positions.get(n.id)![axis]);
          return placed.reduce((a, b) => a + b, 0) / placed.length;
        };
        const first = graph.profile.zones[0]!.id;
        const last = graph.profile.zones.at(-1)!.id;
        const across = mean(last, "x") - mean(first, "x");
        const down = mean(last, "y") - mean(first, "y");
        outcomes.push(`${app} ${style}: ${positions.size}/${graph.nodes.length} placed, ${Math.abs(down) > Math.abs(across) ? "top to bottom" : "left to right"}`);
      }
    }
    expect(outcomes).toMatchInlineSnapshot(`
      [
        "fastapi hexagonal: 25/25 placed, left to right",
        "fastapi layered: 25/25 placed, top to bottom",
        "fastapi mvc: 25/25 placed, left to right",
        "fastapi mvvm: 25/25 placed, left to right",
        "fastapi mvp: 25/25 placed, left to right",
        "django hexagonal: 30/30 placed, left to right",
        "django layered: 30/30 placed, top to bottom",
        "django mvc: 30/30 placed, left to right",
        "django mvvm: 30/30 placed, left to right",
        "django mvp: 30/30 placed, left to right",
      ]
    `);
  }, 60_000);
});
