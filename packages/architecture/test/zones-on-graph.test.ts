/**
 * Declared zones (runshape.json) against observed behaviour. Inference only says what a
 * component does; declaring what it is supposed to be turns disagreements into findings.
 */
import { describe, expect, test } from "vitest";

import { buildSystemGraph, HEXAGONAL, HexagonalZone, ZoneRules } from "../src";
import { SystemGraph } from "@runshape/kernel";
import { loadFixtureRun } from "../../kernel/test/fixtures";

function describeZones(graph: SystemGraph, labels: string[]): string[] {
  return graph.nodes
    .filter((node) => labels.includes(node.label))
    .map((node) => `${node.label}: ${node.zone} [${node.zoneSource}] ${node.zoneReason}${node.smells.length ? ` !${node.smells.join(",")}` : ""}`);
}

function violations(graph: SystemGraph): string[] {
  const label = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return graph.edges.filter((edge) => edge.violation).map((edge) => `${label.get(edge.from)} -> ${label.get(edge.to)}: ${edge.violation}`);
}
describe("zones on the system graph", () => {
  test("without rules every zone is inferred, and says from what", async () => {
    const run = await loadFixtureRun("django");

    expect(describeZones(buildSystemGraph(run), ["Profile", "ArticleViewSet", "ProfileSerializer", "sqlite"])).toMatchInlineSnapshot(`
      [
        "ArticleViewSet: inbound-adapter [inferred] handles a route !touches-external",
        "Profile: outbound-adapter [inferred] calls sqlite directly",
        "ProfileSerializer: core [inferred] receives no requests and calls no external system",
        "sqlite: external [fixed] framework, test or external code",
      ]
    `);
  });

  test("declaring Django's models as core turns their database access into a finding", async () => {
    const run = await loadFixtureRun("django");
    const rules = new ZoneRules([
      { match: "conduit.apps.*.models.*", zone: HexagonalZone.Core, reason: "the domain entities", by: "user" },
    ]);

    const graph = buildSystemGraph(run, { rules });

    // Active record: in Django the entity *is* the persistence adapter. Declared core, the
    // models are flagged for talking to sqlite, and calls from views and serializers into
    // them are ordinary inward calls rather than adapter-to-adapter hops.
    expect(describeZones(graph, ["Profile", "User"])).toMatchInlineSnapshot(`
      [
        "User: core [rule] declared in runshape.json (conduit.apps.*.models.*): the domain entities",
        "Profile: core [rule] declared in runshape.json (conduit.apps.*.models.*): the domain entities !touches-external",
      ]
    `);
  });

  test("fastapi: route handlers that call repositories directly skip the core", async () => {
    const run = await loadFixtureRun("fastapi");

    // dependencies.database builds every repository (get_repository -> _get_repo) but never
    // calls one: constructing an adapter is dependency injection, so it isn't flagged.

    expect(violations(buildSystemGraph(run))).toMatchInlineSnapshot(`
      [
        "dependencies.authentication -> UsersRepository: a request handler using an outbound adapter directly: no core in between",
        "articles.articles_common -> ArticlesRepository: a request handler using an outbound adapter directly: no core in between",
        "articles.articles_resource -> ArticlesRepository: a request handler using an outbound adapter directly: no core in between",
        "routes.authentication -> UsersRepository: a request handler using an outbound adapter directly: no core in between",
      ]
    `);
  });

  test("a declared composition root wires the adapters: its calls aren't findings, everyone else's still are", async () => {
    const run = await loadFixtureRun("fastapi");
    const rules = ZoneRules.parse(
      JSON.stringify({
        version: 2,
        style: "hexagonal",
        zones: [{ match: "app.api.dependencies.**", zone: "inbound-adapter", reason: "FastAPI's dependency functions hand each route its repositories", role: "composition-root" }],
      }),
    );

    const graph = buildSystemGraph(run, { rules, profile: HEXAGONAL });

    expect(violations(graph).map((line) => line.split(":")[0])).toEqual([
      "articles.articles_common -> ArticlesRepository",
      "articles.articles_resource -> ArticlesRepository",
      "routes.authentication -> UsersRepository",
    ]);
    expect(describeZones(graph, ["dependencies.authentication"])).toEqual([
      "dependencies.authentication: inbound-adapter [rule] declared in runshape.json (app.api.dependencies.**): FastAPI's dependency functions hand each route its repositories (composition root: its calls wire the adapters, they don't skip the core)",
    ]);
    expect(() => ZoneRules.parse(JSON.stringify({ version: 2, zones: [{ match: "a.**", zone: "core", reason: "r", role: "boss" }] }))).toThrowError(/zones\[0\]\.role must be "composition-root", or left out/);
  });
});
