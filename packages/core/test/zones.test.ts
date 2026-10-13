/**
 * Declared zones (runshape.json) against observed behaviour. Inference only says what a
 * component does; declaring what it is supposed to be turns disagreements into findings.
 */
import { describe, expect, test } from "vitest";

import { HexagonalZone, HEXAGONAL } from "../src/profiles";
import { ZoneRules, ZoneRulesError } from "../src/zones";
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
        - zones[1].zone must be one of inbound-adapter, core, outbound-adapter (the hexagonal zones)
        - zones[1].reason must say why
        - zones[2].by must be "user" or "llm"]
    `);
  });

  test("a version 1 file (\"rings\") still reads, and is saved back as version 2", () => {
    const v1 = JSON.stringify({ version: 1, rings: [{ match: "app.db.**", ring: "outbound-adapter", reason: "persistence" }] });

    const rules = ZoneRules.parse(v1);

    expect(rules.rules).toEqual([{ match: "app.db.**", zone: "outbound-adapter", reason: "persistence", by: "user" }]);
    expect(JSON.parse(rules.serialize())).toEqual({ version: 2, style: "hexagonal", zones: rules.rules });
    // A broken version 1 file is reported like a broken version 2 one: every problem, no crash.
    expect(() => ZoneRules.parse(JSON.stringify({ version: 1, rings: [null] }))).toThrowError(ZoneRulesError);
  });

  test("the file's style picks the zones its rules may use; an unknown style is reported", () => {
    const layered = ZoneRules.parse(JSON.stringify({ version: 2, style: "layered", zones: [{ match: "app.db.**", zone: "data", reason: "repositories" }] }));
    const wrongZone = JSON.stringify({ version: 2, style: "layered", zones: [{ match: "app.db.**", zone: "outbound-adapter", reason: "r" }] });
    const unknown = JSON.stringify({ version: 2, style: "microservices", zones: [] });

    expect(layered.profile.style).toBe("layered");
    expect(layered.rules[0]?.zone).toBe("data");
    expect(() => ZoneRules.parse(wrongZone)).toThrowError(/zone must be one of presentation, business, data \(the layered zones\)/);
    expect(() => ZoneRules.parse(unknown)).toThrowError(/"style" "microservices" is not one of hexagonal, layered, mvc, mvvm, mvp/);
  });

  test("first match wins; `*` stays within one dotted segment, `**` spans any number", () => {
    const rules = new ZoneRules([
      { match: "app.db.repositories.base.*", zone: HexagonalZone.Core, reason: "shared base", by: "user" },
      { match: "app.db.**", zone: HexagonalZone.OutboundAdapter, reason: "persistence", by: "user" },
      { match: "app.*", zone: HexagonalZone.InboundAdapter, reason: "top-level modules", by: "user" },
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
    const subtree = new ZoneRules([{ match: "app.db.**", zone: HexagonalZone.OutboundAdapter, reason: "persistence", by: "user" }]);
    expect(["app.db", "app.db.users", "app.dbx"].map((name) => subtree.matchFor(name) !== null)).toEqual([true, true, false]);
    const middle = new ZoneRules([{ match: "a.**.b", zone: HexagonalZone.Core, reason: "r", by: "user" }]);
    expect(["a.b", "a.x.b", "a.x.y.b", "ab"].map((name) => middle.matchFor(name) !== null)).toEqual([true, true, true, false]);
    const leading = new ZoneRules([{ match: "**.models", zone: HexagonalZone.Core, reason: "r", by: "user" }]);
    expect(["models", "app.models", "app.x.models", "app.modelsx"].map((name) => leading.matchFor(name) !== null)).toEqual([true, true, true, false]);
  });

  test("setting the zone of one component adds the most specific rule first and round-trips", () => {
    const rules = ZoneRules.none()
      .withRuleFor("app.**", HexagonalZone.Core, "default", "user")
      .withRuleFor("app.db.users.UsersRepository", HexagonalZone.OutboundAdapter, "talks to postgres", "llm");

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
});
