/**
 * The module view's boxes (PLAN.md Phase 2): a project opens at its modules, not its classes.
 * A region declared at the top of runshape.json is a module as written. Elsewhere the names
 * decide: below each top-level name, down while there's only one way down, then one module per
 * branch. Runshape's own code is packages.<name>.src.…, so its modules are its packages.
 */
import { describe, expect, test } from "vitest";

import { QualifiedName } from "@runshape/kernel";
import { buildSystemGraph, moduleRoots, ZoneRules } from "../src";
import { loadFixtureRun } from "../../kernel/test/fixtures";

const namesOf = (dotted: string[]) => dotted.map((name) => QualifiedName.parse(name));

describe("moduleRoots", () => {
  test("Runshape's layout: each package a module; a recorder alone at the top is one too", () => {
    const names = namesOf(["packages.trace.src.moves", "packages.trace.src.threads", "packages.cli.src.main", "packages.kernel.src.trace.model.trace", "recorder-ts.src.instrument", "recorder-ts.src.run"]);

    expect(moduleRoots(names, ZoneRules.none())).toEqual(["packages.cli", "packages.kernel", "packages.trace", "recorder-ts.src.instrument", "recorder-ts.src.run"]);
  });

  test("the example apps, from their recordings; a region is a module as written", async () => {
    const modulesOf = async (fixture: "fastapi" | "go-shop", rules = ZoneRules.none()) => {
      const run = await loadFixtureRun(fixture);
      return moduleRoots(run.catalog.map((fn) => fn.symbol.namespaceName), rules);
    };
    const billing = ZoneRules.parse(JSON.stringify({ version: 3, style: "hexagonal", zones: [], regions: [{ name: "db", match: "app.db.repositories.**", in: "outbound-adapter", style: "layered", reason: "r" }] }));

    expect({
      fastapi: await modulesOf("fastapi"),
      goShop: await modulesOf("go-shop"),
      withRegion: await modulesOf("fastapi", billing),
    }).toEqual({
      // Python's catalog has the tests too; test code is drawn as the client, so they never show as boxes.
      fastapi: ["app.api", "app.core", "app.db", "app.main", "app.models", "app.services", "tests.conftest", "tests.fake_asyncpg_pool", "tests.test_api", "tests.test_db", "tests.test_schemas", "tests.test_services"],
      // Go's internal/ is one module until regions say more.
      goShop: ["example\\.com.shop.cmd", "example\\.com.shop.internal"],
      // The region is a module of its own; the rest of app.db stays one beside it.
      withRegion: ["app.api", "app.core", "app.db", "app.db.repositories", "app.main", "app.models", "app.services", "tests.conftest", "tests.fake_asyncpg_pool", "tests.test_api", "tests.test_db", "tests.test_schemas", "tests.test_services"],
    });
  });

  test("the graph drawn by module: one box per module, its calls between modules, and the style's findings on them", async () => {
    const run = await loadFixtureRun("fastapi");
    const modules = moduleRoots(run.catalog.map((fn) => fn.symbol.namespaceName), ZoneRules.none());

    const graph = buildSystemGraph(run, { grouping: { collapseMiddleware: true, modules } });

    const label = new Map(graph.nodes.map((node) => [node.id, node.label]));
    expect({
      boxes: graph.nodes.map((node) => `${node.label}: ${node.zone}`),
      findings: graph.edges.filter((edge) => edge.violation !== null).map((edge) => `${label.get(edge.from)} -> ${label.get(edge.to)}`),
    }).toEqual({
      // Startup code (app.core, app.main) runs in setup, not in the test bodies drawn by default.
      boxes: ["Client (tests): edge", "FakeAsyncPGPool: test-double", "FakePoolAcquireContent: test-double", "postgres: external", "FastAPI: edge", "Middleware ×3: edge", "APIRouter: edge", "app.api: inbound-adapter", "app.db: outbound-adapter", "app.models: core", "app.services: core"],
      // The routes that call repositories directly, four of them at class level, are one line here.
      findings: ["app.api -> app.db"],
    });
  });

  test("a module no rule names sits where its own code's rules put most of it", async () => {
    const run = await loadFixtureRun("fastapi");
    const modules = moduleRoots(run.catalog.map((fn) => fn.symbol.namespaceName), ZoneRules.none());
    // As Runshape's own rules are written: under the module's name, not on it.
    const rules = ZoneRules.parse(JSON.stringify({ version: 2, style: "hexagonal", zones: [{ match: "app.services.*", zone: "outbound-adapter", reason: "say so" }] }));

    const graph = buildSystemGraph(run, { grouping: { collapseMiddleware: true, modules }, rules });

    expect(graph.nodes.filter((node) => node.label === "app.services").map((node) => `${node.zone} [${node.zoneSource}] ${node.zoneReason}`)).toEqual([
      "outbound-adapter [rule] declared in runshape.json (app.services.*): most of its code: say so",
    ]);
  });
});
