/**
 * Declared rings (hexvis.json) against observed behaviour. Inference only says what a
 * component does; declaring what it is supposed to be turns disagreements into findings.
 */
import { describe, expect, test } from "vitest";

import { DeclaredRing, RingRules, RingRulesError } from "../src/rings";
import { buildSystemGraph, SystemGraph } from "../src/views/system-graph";
import { loadFixtureRun } from "./fixtures";

function describeRings(graph: SystemGraph, labels: string[]): string[] {
  return graph.nodes
    .filter((node) => labels.includes(node.label))
    .map((node) => `${node.label}: ${node.ring} [${node.ringSource}] ${node.ringReason}${node.smells.length ? ` !${node.smells.join(",")}` : ""}`);
}

function violations(graph: SystemGraph): string[] {
  const label = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return graph.edges.filter((edge) => edge.violation).map((edge) => `${label.get(edge.from)} -> ${label.get(edge.to)}: ${edge.violation}`);
}

describe("RingRules", () => {
  test("a hexvis.json with mistakes reports every one of them", () => {
    const text = JSON.stringify({
      version: 1,
      rings: [
        { match: "app.domain.**", ring: "core", reason: "entities and services" },
        { match: "", ring: "domain", reason: "" },
        { match: "app.db.*", ring: "outbound-adapter", reason: "repositories", by: "robot" },
      ],
    });

    expect(() => RingRules.parse(text)).toThrowError(RingRulesError);
    expect(() => RingRules.parse(text)).toThrowErrorMatchingInlineSnapshot(`
      [Error: hexvis.json is invalid:
        - rings[1].match must be a non-empty string
        - rings[1].ring must be one of inbound-adapter, core, outbound-adapter
        - rings[1].reason must say why
        - rings[2].by must be "user" or "llm"]
    `);
  });

  test("first match wins; `*` stays within one dotted segment, `**` spans any number", () => {
    const rules = new RingRules([
      { match: "app.db.repositories.base.*", ring: DeclaredRing.Core, reason: "shared base", by: "user" },
      { match: "app.db.**", ring: DeclaredRing.OutboundAdapter, reason: "persistence", by: "user" },
      { match: "app.*", ring: DeclaredRing.InboundAdapter, reason: "top-level modules", by: "user" },
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
  });

  test("setting the ring of one component adds the most specific rule first and round-trips", () => {
    const rules = RingRules.none()
      .withRuleFor("app.**", DeclaredRing.Core, "default", "user")
      .withRuleFor("app.db.users.UsersRepository", DeclaredRing.OutboundAdapter, "talks to postgres", "llm");

    expect(RingRules.parse(rules.serialize()).rules).toEqual([
      { match: "app.db.users.UsersRepository", ring: "outbound-adapter", reason: "talks to postgres", by: "llm" },
      { match: "app.**", ring: "core", reason: "default", by: "user" },
    ]);
  });
});

describe("rings on the system graph", () => {
  test("without rules every ring is inferred, and says from what", async () => {
    const run = await loadFixtureRun("django");

    expect(describeRings(buildSystemGraph(run), ["Profile", "ArticleViewSet", "ProfileSerializer", "sqlite"])).toMatchInlineSnapshot(`
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
    const rules = new RingRules([
      { match: "conduit.apps.*.models.*", ring: DeclaredRing.Core, reason: "the domain entities", by: "user" },
    ]);

    const graph = buildSystemGraph(run, { rules });

    // Active record: in Django the entity *is* the persistence adapter. Declared core, the
    // models are flagged for talking to sqlite, and calls from views and serializers into
    // them are ordinary inward calls rather than adapter-to-adapter hops.
    expect(describeRings(graph, ["Profile", "User"])).toMatchInlineSnapshot(`
      [
        "User: core [rule] declared in hexvis.json (conduit.apps.*.models.*): the domain entities",
        "Profile: core [rule] declared in hexvis.json (conduit.apps.*.models.*): the domain entities !core-touches-external",
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
