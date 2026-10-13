/**
 * Declared zones (runshape.json) against observed behaviour. Inference only says what a
 * component does; declaring what it is supposed to be turns disagreements into findings.
 */
import { describe, expect, test } from "vitest";

import { DeclaredZone, ZoneRules, ZoneRulesError } from "../src/zones";
import { buildSystemGraph, SystemGraph } from "../src/views/system-graph";
import { loadFixtureRun } from "./fixtures";

function describeZones(graph: SystemGraph, labels: string[]): string[] {
  return graph.nodes
    .filter((node) => labels.includes(node.label))
    .map((node) => `${node.label}: ${node.zone} [${node.zoneSource}] ${node.zoneReason}${node.smells.length ? ` !${node.smells.join(",")}` : ""}`);
}

function violations(graph: SystemGraph): string[] {
  const label = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return graph.edges.filter((edge) => edge.violation).map((edge) => `${label.get(edge.from)} -> ${label.get(edge.to)}: ${edge.violation}`);
}

describe("ZoneRules", () => {
  test("a runshape.json with mistakes reports every one of them", () => {
    const text = JSON.stringify({
      version: 2,
      zones: [
        { match: "app.domain.**", zone: "core", reason: "entities and services" },
        { match: "", zone: "domain", reason: "" },
        { match: "app.db.*", zone: "outbound-adapter", reason: "repositories", by: "robot" },
      ],
    });

    expect(() => ZoneRules.parse(text)).toThrowError(ZoneRulesError);
    expect(() => ZoneRules.parse(text)).toThrowErrorMatchingInlineSnapshot(`
      [Error: runshape.json is invalid:
        - zones[1].match must be a non-empty string
        - zones[1].zone must be one of inbound-adapter, core, outbound-adapter
        - zones[1].reason must say why
        - zones[2].by must be "user" or "llm"]
    `);
  });

  test("a version 1 file (\"rings\") still reads, and is saved back as version 2", () => {
    const v1 = JSON.stringify({ version: 1, rings: [{ match: "app.db.**", ring: "outbound-adapter", reason: "persistence" }] });

    const rules = ZoneRules.parse(v1);

    expect(rules.rules).toEqual([{ match: "app.db.**", zone: "outbound-adapter", reason: "persistence", by: "user" }]);
    expect(JSON.parse(rules.serialize())).toEqual({ version: 2, style: "hexagonal", zones: rules.rules });
  });

  test("a style the viewer can't draw yet is reported, not silently drawn as a hexagon", () => {
    const layered = JSON.stringify({ version: 2, style: "layered", zones: [] });

    expect(() => ZoneRules.parse(layered)).toThrowError(/"style" "layered" isn't drawn yet/);
  });

  test("first match wins; `*` stays within one dotted segment, `**` spans any number", () => {
    const rules = new ZoneRules([
      { match: "app.db.repositories.base.*", zone: DeclaredZone.Core, reason: "shared base", by: "user" },
      { match: "app.db.**", zone: DeclaredZone.OutboundAdapter, reason: "persistence", by: "user" },
      { match: "app.*", zone: DeclaredZone.InboundAdapter, reason: "top-level modules", by: "user" },
    ]);

    expect(
      ["app.db.repositories.base.BaseRepository", "app.db.repositories.users.UsersRepository", "app.main", "app.services.jwt"].map(
        (name) => `${name} -> ${rules.matchFor(name)?.rule.reason ?? "no rule"}`,
      ),
    ).toEqual([
      "app.db.repositories.base.BaseRepository -> shared base",
      "app.db.repositories.users.UsersRepository -> persistence",
      "app.main -> top-level modules",
      "app.services.jwt -> no rule",
    ]);
    // `**` also stands for no segments, so a package's own module matches its subtree rule.
    const subtree = new ZoneRules([{ match: "app.db.**", zone: DeclaredZone.OutboundAdapter, reason: "persistence", by: "user" }]);
    expect(["app.db", "app.db.users", "app.dbx"].map((name) => subtree.matchFor(name) !== null)).toEqual([true, true, false]);
    const middle = new ZoneRules([{ match: "a.**.b", zone: DeclaredZone.Core, reason: "r", by: "user" }]);
    expect(["a.b", "a.x.b", "a.x.y.b", "ab"].map((name) => middle.matchFor(name) !== null)).toEqual([true, true, true, false]);
  });

  test("setting the zone of one component adds the most specific rule first and round-trips", () => {
    const rules = ZoneRules.none()
      .withRuleFor("app.**", DeclaredZone.Core, "default", "user")
      .withRuleFor("app.db.users.UsersRepository", DeclaredZone.OutboundAdapter, "talks to postgres", "llm");

    expect(ZoneRules.parse(rules.serialize()).rules).toEqual([
      { match: "app.db.users.UsersRepository", zone: "outbound-adapter", reason: "talks to postgres", by: "llm" },
      { match: "app.**", zone: "core", reason: "default", by: "user" },
    ]);
  });
});

describe("zones on the system graph", () => {
  test("without rules every zone is inferred, and says from what", async () => {
    const run = await loadFixtureRun("django");

    expect(describeZones(buildSystemGraph(run), ["Profile", "ArticleViewSet", "ProfileSerializer", "sqlite"])).toMatchInlineSnapshot(`
      [
        "ArticleViewSet: inbound-adapter [inferred] handles a route !handler-touches-external",
        "Profile: outbound-adapter [inferred] calls sqlite directly",
        "ProfileSerializer: core [inferred] receives no requests and calls no external system",
        "sqlite: external [fixed] framework, test or external code",
      ]
    `);
  });

  test("declaring Django's models as core turns their database access into a finding", async () => {
    const run = await loadFixtureRun("django");
    const rules = new ZoneRules([
      { match: "conduit.apps.*.models.*", zone: DeclaredZone.Core, reason: "the domain entities", by: "user" },
    ]);

    const graph = buildSystemGraph(run, { rules });

    // Active record: in Django the entity *is* the persistence adapter. Declared core, the
    // models are flagged for talking to sqlite, and calls from views and serializers into
    // them are ordinary inward calls rather than adapter-to-adapter hops.
    expect(describeZones(graph, ["Profile", "User"])).toMatchInlineSnapshot(`
      [
        "User: core [rule] declared in runshape.json (conduit.apps.*.models.*): the domain entities",
        "Profile: core [rule] declared in runshape.json (conduit.apps.*.models.*): the domain entities !core-touches-external",
      ]
    `);
  });

  test("fastapi: route handlers that call repositories directly skip the core", async () => {
    const run = await loadFixtureRun("fastapi");

    // dependencies.database builds every repository (get_repository -> _get_repo) but never
    // calls one: constructing an adapter is dependency injection, so it isn't flagged.

    expect(violations(buildSystemGraph(run))).toMatchInlineSnapshot(`
      [
        "dependencies.authentication -> UsersRepository: skips-core",
        "articles.articles_common -> ArticlesRepository: skips-core",
        "articles.articles_resource -> ArticlesRepository: skips-core",
        "routes.authentication -> UsersRepository: skips-core",
      ]
    `);
  });
});
