/**
 * Saved arrangements: a person moves a box in 2D or 3D, and it stays there between recordings
 * and diffs. The file is the visualizer's own (the app only reads and writes its text), keyed by
 * zoom level and style, then by box name, so a box keeps its spot whatever ids or order the next
 * recording gives it. Moving one box writes down where every box at that level stands, since
 * the person arranged it against the rest; a box that's new since goes beside the arranged boxes
 * it calls or is called by.
 *
 * On the FastAPI slug refactor's module view (the largest example recording).
 */
import { describe, expect, test } from "vitest";

import { buildSystemGraph, moduleRoots, ZoneRules } from "@runshape/architecture";
import { ComponentKind, Layout, Phase, QualifiedName, SystemGraph } from "@runshape/kernel";

import { Arrangement, arrangeBox, ArrangementError, emptyArrangement, layout, parseArrangement, serializeArrangement } from "../src";
import { loadFixtureRun } from "../../kernel/test/fixtures";

async function moduleView(): Promise<{ graph: SystemGraph; at: (graph: SystemGraph, arrangement: Arrangement | null) => Promise<Layout> }> {
  const run = await loadFixtureRun("fastapi-slug-refactor");
  const names = buildSystemGraph(run, { phases: [Phase.Setup, Phase.Call, Phase.Teardown] })
    .nodes.filter((node) => node.qualifiedName !== null && (node.kind === ComponentKind.Class || node.kind === ComponentKind.Module))
    .map((node) => QualifiedName.parse(node.qualifiedName!));
  const grouping = { collapseMiddleware: true, modules: moduleRoots(names, ZoneRules.none()) };
  const graph = buildSystemGraph(run, { phases: [Phase.Call], grouping });
  return { graph, at: (drawn, arrangement) => layout(drawn, { level: { kind: "modules" }, grouping, arrangement }) };
}

const named = (view: Layout, label: string) => view.nodes.find((node) => node.label === label)!;
const overlapping2D = (view: Layout) =>
  view.nodes.flatMap((a, i) => view.nodes.slice(i + 1).filter((b) => Math.abs(a.flat.x - b.flat.x) < 188 && Math.abs(a.flat.y - b.flat.y) < 46).map((b) => `${a.label} / ${b.label}`));

describe("saved arrangements", () => {
  test("a box moved in 2D stays where it was put, through the file; everything else stays where it was", async () => {
    const { graph, at } = await moduleView();
    const computed = await at(graph, null);
    const db = named(computed, "app.db");

    const moved = arrangeBox(emptyArrangement(), computed, { node: db.id, flat: { x: db.flat.x + 400.04, y: db.flat.y - 300 } });
    const file = serializeArrangement(moved);
    const again = await at(graph, parseArrangement(file));

    expect(file).toMatchInlineSnapshot(`
      "{
        "format": "runshape-arrangement",
        "version": 1,
        "levels": {
          "modules@hexagonal": {
            "flat": {
              "app.api": {
                "x": 1044,
                "y": 34
              },
              "app.db": {
                "x": 2218,
                "y": -186.5
              },
              "app.models": {
                "x": 1302,
                "y": 94.3
              },
              "app.services": {
                "x": 1560,
                "y": 68
              },
              "client": {
                "x": 12,
                "y": 105.8
              },
              "external:postgres": {
                "x": 2592,
                "y": 113.5
              },
              "landmark:entry:FastAPI": {
                "x": 270,
                "y": 65.2
              },
              "landmark:middleware-chain": {
                "x": 528,
                "y": 65.2
              },
              "landmark:router:APIRouter": {
                "x": 786,
                "y": 72.8
              },
              "tests.fake_asyncpg_pool.FakeAsyncPGPool": {
                "x": 2076,
                "y": 23
              },
              "tests.fake_asyncpg_pool.FakePoolAcquireContent": {
                "x": 2334,
                "y": 15.3
              }
            },
            "floor": {}
          }
        }
      }
      "
    `);
    expect({
      // The file keeps a tenth of a pixel: the move, not the layout's own decimals.
      dbMovedBy: { x: Math.round(named(again, "app.db").flat.x - db.flat.x), y: Math.round(named(again, "app.db").flat.y - db.flat.y) },
      othersWhereTheyWere: again.nodes.filter((node) => node.label !== "app.db").every((node) => {
        const before = named(computed, node.label);
        return Math.abs(node.flat.x - before.flat.x) < 0.1 && Math.abs(node.flat.y - before.flat.y) < 0.1;
      }),
      arranged: again.nodes.filter((node) => node.arranged).length,
      of: again.nodes.length,
      floorUntouched: again.nodes.every((node) => node.floor.x === named(computed, node.label).floor.x),
    }).toMatchInlineSnapshot(`
      {
        "arranged": 11,
        "dbMovedBy": {
          "x": 400,
          "y": -300,
        },
        "floorUntouched": true,
        "of": 11,
        "othersWhereTheyWere": true,
      }
    `);
  });

  test("a box new since the level was arranged goes beside the arranged boxes it works with, on nothing else", async () => {
    const { graph, at } = await moduleView();
    // Arranged on a recording without app.services (it came later), with app.db moved far away.
    const services = graph.nodes.find((node) => node.label === "app.services")!;
    const without = { ...graph, nodes: graph.nodes.filter((node) => node !== services), edges: graph.edges.filter((edge) => edge.from !== services.id && edge.to !== services.id) };
    const earlier = await at(without, null);
    const db = named(earlier, "app.db");
    const arrangement = arrangeBox(emptyArrangement(), earlier, { node: db.id, flat: { x: db.flat.x + 2000, y: db.flat.y + 1000 } });

    const now = await at(graph, arrangement);

    const placed = named(now, "app.services");
    const neighbours = graph.edges.filter((edge) => edge.from === services.id || edge.to === services.id).map((edge) => (edge.from === services.id ? edge.to : edge.from));
    const middle = (axis: "x" | "y") => neighbours.reduce((sum, id) => sum + now.nodes.find((node) => node.id === id)!.flat[axis], 0) / neighbours.length;
    expect({
      neighbours: neighbours.map((id) => now.nodes.find((node) => node.id === id)!.label),
      placedNearNeighbours: placed.placedNearNeighbours,
      arranged: placed.arranged,
      distanceFromTheirMiddle: Math.round(Math.hypot(placed.flat.x - middle("x"), placed.flat.y - middle("y"))),
      overlapping: overlapping2D(now),
    }).toMatchInlineSnapshot(`
      {
        "arranged": false,
        "distanceFromTheirMiddle": 0,
        "neighbours": [
          "app.api",
          "app.models",
          "app.db",
        ],
        "overlapping": [],
        "placedNearNeighbours": true,
      }
    `);
  });

  test("in 3D a tile moves across the floor; its elevation stays its zone's", async () => {
    const { graph, at } = await moduleView();
    const computed = await at(graph, null);
    const api = named(computed, "app.api");

    const again = await at(graph, arrangeBox(emptyArrangement(), computed, { node: api.id, floor: { x: 10, z: -20 } }));

    expect({ before: api.floor, after: named(again, "app.api").floor, flatUntouched: named(again, "app.api").flat }).toEqual({
      before: api.floor,
      after: { ...api.floor, x: 10, z: -20 },
      flatUntouched: api.flat,
    });
  });

  test("a hand-edited file with mistakes says each one and where; it's never half read", () => {
    const attempts = [
      "{ not json",
      JSON.stringify({ format: "runshape-arrangement", version: 2, levels: { "modules@hexagonal": { flat: { "app.db": { x: "10", y: 2 } }, floor: [] } } }),
    ].map((text) => {
      try {
        return parseArrangement(text);
      } catch (error) {
        return error instanceof ArrangementError ? error.message : error;
      }
    });

    expect(attempts).toMatchInlineSnapshot(`
      [
        "not JSON: Expected property name or '}' in JSON at position 2 (line 1 column 3)",
        "version: expected 1; levels.modules@hexagonal.flat.app.db: expected "x" and "y" as numbers; levels.modules@hexagonal.floor: expected an object",
      ]
    `);
  });
});
