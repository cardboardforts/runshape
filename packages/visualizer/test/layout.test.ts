/**
 * The visual model: what the viewer draws at each zoom level, worked out once and drawn as is
 * by the 2D canvas and the 3D floor. The session cuts the graph into the level's boxes
 * (groupingAt: an opened module's code class by class, every other module one box) and asks
 * `layout` for the rest: which boxes are drawn, where, and what was left out.
 *
 * On the FastAPI slug refactor (the largest example app recording), Runshape's own module view:
 * one box per module, then `app.api` opened.
 */
import { describe, expect, test } from "vitest";

import { buildSystemGraph, HEXAGONAL, HexagonalZone, moduleRoots, ZoneRules } from "@runshape/architecture";
import { Change, ComponentKind, GraphNode, groupingAt, Grouping, Layout, Phase, QualifiedName, Run, SystemGraph, zoomLevelOf } from "@runshape/kernel";

import { layout, MAX_BOXES } from "../src";
import { loadFixtureRun } from "../../kernel/test/fixtures";

const EVERY_PHASE = [Phase.Setup, Phase.Call, Phase.Teardown];

function modulesOf(run: Run): string[] {
  const graph = buildSystemGraph(run, { phases: EVERY_PHASE });
  const names = graph.nodes.filter((node) => node.qualifiedName !== null && (node.kind === ComponentKind.Class || node.kind === ComponentKind.Module)).map((node) => QualifiedName.parse(node.qualifiedName!));
  return moduleRoots(names, ZoneRules.none());
}

/** As the session does it: the grouping for the level, the graph cut that way, then the layout. */
async function layoutAt(run: Run, grouping: Grouping, opened: string | null): Promise<Layout> {
  const cut = groupingAt(grouping, opened);
  return layout(buildSystemGraph(run, { phases: [Phase.Call], grouping: cut }), { level: zoomLevelOf(grouping, opened), grouping: cut });
}

/** What a person sees: each box (what clicking it opens), each line, and what was left out. */
function drawn(view: Layout): string[] {
  const label = new Map(view.nodes.map((node) => [node.id, node.label]));
  return [
    `${JSON.stringify(view.level)} ${view.direction}, hidden ${JSON.stringify(view.hidden)}`,
    ...view.nodes.map((node) => `  [${node.label}] ${node.kind} ${node.zone}${node.opens ? ` opens ${node.opens}` : ""}`),
    ...view.edges.map((edge) => `  ${label.get(edge.from)} -> ${label.get(edge.to)} (${edge.calls})`),
  ];
}

describe("layout, level by level", () => {
  test("the modules level is one box per module; a module opened is its classes, and the other modules stay whole", async () => {
    const run = await loadFixtureRun("fastapi-slug-refactor");
    const grouping: Grouping = { collapseMiddleware: true, modules: modulesOf(run) };

    const modules = await layoutAt(run, grouping, null);
    const api = await layoutAt(run, grouping, "app.api");

    expect(grouping.modules).toMatchInlineSnapshot(`
      [
        "app.api",
        "app.core",
        "app.db",
        "app.main",
        "app.models",
        "app.services",
      ]
    `);
    expect(drawn(modules)).toMatchInlineSnapshot(`
      [
        "{"kind":"modules"} right, hidden {"nodes":0,"edges":0,"calls":0}",
        "  [Client (tests)] client edge",
        "  [FakeAsyncPGPool] test-double test-double",
        "  [FakePoolAcquireContent] test-double test-double",
        "  [postgres] external external",
        "  [FastAPI] entry edge",
        "  [Middleware ×3] middleware edge",
        "  [APIRouter] router edge",
        "  [app.api] module inbound-adapter opens app.api",
        "  [app.db] module outbound-adapter opens app.db",
        "  [app.models] module core opens app.models",
        "  [app.services] module core opens app.services",
        "  Client (tests) -> FastAPI (4)",
        "  Client (tests) -> app.db (34)",
        "  Client (tests) -> app.models (3)",
        "  FakeAsyncPGPool -> FakePoolAcquireContent (4)",
        "  FastAPI -> Middleware ×3 (4)",
        "  Middleware ×3 -> APIRouter (4)",
        "  Middleware ×3 -> app.api (1)",
        "  APIRouter -> app.api (28)",
        "  APIRouter -> app.models (4)",
        "  app.api -> FakeAsyncPGPool (4)",
        "  app.api -> FakePoolAcquireContent (8)",
        "  app.api -> app.db (13)",
        "  app.api -> app.models (2)",
        "  app.api -> app.services (8)",
        "  app.db -> postgres (288)",
        "  app.db -> app.models (122)",
        "  app.models -> app.services (13)",
        "  app.services -> app.db (4)",
      ]
    `);
    // Opened: app.api's own classes, and only the boxes they call or are called by; the calls
    // into app.db land on the app.db box, not on its repositories (that's the next click).
    expect(drawn(api)).toMatchInlineSnapshot(`
      [
        "{"kind":"module","module":"app.api"} right, hidden {"nodes":0,"edges":0,"calls":0}",
        "  [RWAPIKeyHeader] class inbound-adapter",
        "  [FakeAsyncPGPool] test-double test-double",
        "  [FakePoolAcquireContent] test-double test-double",
        "  [Middleware ×3] middleware edge",
        "  [APIRouter] router edge",
        "  [dependencies.authentication] module inbound-adapter",
        "  [dependencies.database] module inbound-adapter",
        "  [errors.http_error] module inbound-adapter",
        "  [articles.articles_common] module inbound-adapter",
        "  [articles.articles_resource] module inbound-adapter",
        "  [routes.authentication] module inbound-adapter",
        "  [app.db] module outbound-adapter opens app.db",
        "  [app.models] module core opens app.models",
        "  [app.services] module core opens app.services",
        "  Middleware ×3 -> errors.http_error (1)",
        "  APIRouter -> RWAPIKeyHeader (3)",
        "  APIRouter -> dependencies.authentication (6)",
        "  APIRouter -> dependencies.database (15)",
        "  APIRouter -> articles.articles_common (1)",
        "  APIRouter -> articles.articles_resource (2)",
        "  APIRouter -> routes.authentication (1)",
        "  dependencies.authentication -> app.db (3)",
        "  dependencies.authentication -> app.services (3)",
        "  dependencies.database -> FakeAsyncPGPool (4)",
        "  dependencies.database -> FakePoolAcquireContent (8)",
        "  dependencies.database -> app.db (7)",
        "  articles.articles_common -> app.db (1)",
        "  articles.articles_resource -> app.db (1)",
        "  articles.articles_resource -> app.models (2)",
        "  articles.articles_resource -> app.services (2)",
        "  routes.authentication -> app.db (1)",
        "  routes.authentication -> app.services (3)",
      ]
    `);
    expect(api.grouping.modules).toEqual(grouping.modules!.filter((module) => module !== "app.api"));
  });

  test("every box is placed for both views at once: 2D on the canvas, 3D on the style's floor", async () => {
    const run = await loadFixtureRun("fastapi-slug-refactor");
    const view = await layoutAt(run, { collapseMiddleware: true }, null);

    const corners = (axis: (node: Layout["nodes"][number]) => number) => [Math.min(...view.nodes.map(axis)), Math.max(...view.nodes.map(axis))].map(Math.round);
    expect({
      boxes: view.nodes.length,
      distinct2D: new Set(view.nodes.map((node) => `${node.flat.x},${node.flat.y}`)).size,
      distinct3D: new Set(view.nodes.map((node) => `${node.floor.x},${node.floor.z}`)).size,
      flatX: corners((node) => node.flat.x),
      floorX: corners((node) => node.floor.x),
      floorPieces: view.floor.pieces.length,
      flatProblem: view.flatProblem,
      notComparing: view.nodes.every((node) => node.change === null) && view.edges.every((edge) => edge.change === null),
    }).toMatchInlineSnapshot(`
      {
        "boxes": 25,
        "distinct2D": 25,
        "distinct3D": 25,
        "flatProblem": null,
        "flatX": [
          12,
          3118,
        ],
        "floorPieces": 1,
        "floorX": [
          -185,
          136,
        ],
        "notComparing": true,
      }
    `);
  });
});

describe("capped detail", () => {
  const node = (id: string, kind: ComponentKind, calls: number): GraphNode => ({
    id,
    kind,
    label: id,
    qualifiedName: kind === ComponentKind.Class ? `app.${id}` : null,
    zone: HexagonalZone.Core,
    zoneSource: "inferred" as never,
    zoneReason: "",
    smells: [],
    calls,
    instances: 0,
    scenarioIds: [],
  });

  test("past MAX_BOXES the quietest boxes are left out and counted; the request path and changed boxes never are", async () => {
    const classes = Array.from({ length: MAX_BOXES + 20 }, (_, i) => node(`c${i}`, ComponentKind.Class, 1000 - i));
    const graph: SystemGraph = {
      nodes: [node("client", ComponentKind.Client, 1), ...classes],
      edges: classes.map((to, i) => ({ id: `e${i}`, from: "client", to: to.id, calls: 2, scenarioIds: [], violation: null })),
      profile: HEXAGONAL,
    };
    const quietest = classes.at(-1)!.id;
    const changes = { nodes: new Map([[quietest, Change.Added]]), edges: new Map() };

    const view = await layout(graph, { level: { kind: "classes" }, grouping: { collapseMiddleware: true }, changes });

    const ids = new Set(view.nodes.map((n) => n.id));
    expect({
      drawn: view.nodes.length,
      hidden: view.hidden,
      client: ids.has("client"),
      quietestButAdded: ids.has(quietest),
      leftOut: classes.filter((c) => !ids.has(c.id)).map((c) => c.id).join(" "),
      changes: [...new Set(view.nodes.map((n) => n.change))],
    }).toMatchInlineSnapshot(`
      {
        "changes": [
          "unchanged",
          "added",
        ],
        "client": true,
        "drawn": 100,
        "hidden": {
          "calls": 42,
          "edges": 21,
          "nodes": 21,
        },
        "leftOut": "c98 c99 c100 c101 c102 c103 c104 c105 c106 c107 c108 c109 c110 c111 c112 c113 c114 c115 c116 c117 c118",
        "quietestButAdded": true,
      }
    `);
  });
});
