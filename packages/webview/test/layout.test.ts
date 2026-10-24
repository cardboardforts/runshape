/**
 * The 2D layout on the real recordings, in every style, and on random graphs. ELK's graph
 * wrapping (which folds a long, flat graph into rows) crashes inside ELK on some graphs
 * depending on nothing more than their shape — MULTI_EDGE on FastAPI drawn as layered, and
 * SINGLE_EDGE on about 6% of random graphs. Laying out without wrapping never did, so a
 * wrapped layout that fails is retried without it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { buildSystemGraph, profileFor, PROFILES } from "@runshape/architecture";
import { ArchitectureStyle, FixedZone, GraphNode, SystemGraph, TraceDirectory } from "@runshape/kernel";

import { layoutGraph } from "../src/layout";

async function fixtureRun(app: string) {
  const directory = join(import.meta.dirname, "..", "..", "kernel", "test", "fixtures", app);
  return new TraceDirectory({ readText: (path) => readFile(join(directory, path), "utf8") }).latest();
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

/** A small deterministic generator, so a failing graph can be reproduced from its seed. */
function randomGraph(seed: number): SystemGraph {
  let state = seed;
  const next = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const profile = PROFILES[Math.floor(next() * PROFILES.length)]!;
  const zones = [...profile.zones.map((zone) => zone.id), FixedZone.Edge, FixedZone.External, FixedZone.TestDouble];
  const count = 2 + Math.floor(next() * 40);
  const nodes = Array.from({ length: count }, (_, i) => ({ id: `n${i}`, kind: "class", label: `n${i}`, zone: zones[Math.floor(next() * zones.length)] }) as unknown as GraphNode);
  const edges = Array.from({ length: Math.floor(next() * count * 2) }, (_, i) => {
    const from = nodes[Math.floor(next() * count)]!.id;
    const to = nodes[Math.floor(next() * count)]!.id;
    // (self-calls are kept: a graph never has them, but layout shouldn't depend on that)
    return { id: `e${i}:${from}->${to}`, from, to, calls: 1, scenarioIds: [], violation: null };
  });
  return { nodes, edges, profile };
}

describe("2D layout on random graphs", () => {
  test("every graph gets a position for every node, whatever ELK's wrapping makes of it", async () => {
    const failed: string[] = [];
    for (let seed = 1; seed <= 300; seed += 1) {
      const graph = randomGraph(seed);
      try {
        const positions = await layoutGraph(graph);
        if (positions.size !== graph.nodes.length) failed.push(`seed ${seed}: ${positions.size}/${graph.nodes.length} placed`);
      } catch (error) {
        failed.push(`seed ${seed}: ${(error as Error).message.slice(0, 60)}`);
      }
    }
    expect(failed).toEqual([]);
  }, 120_000);
});
