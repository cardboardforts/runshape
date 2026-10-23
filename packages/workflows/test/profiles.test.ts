/**
 * Drawing an app in a style other than the hexagon: the profile decides the zones, how
 * unplaced components are inferred (names first, then behaviour), which calls break the
 * style, and which zones may talk to external systems. On the real example recordings.
 */
import { describe, expect, test } from "vitest";

import { ArchitectureStyle, HexagonalZone, profileFor } from "@runshape/architecture";
import { ViewerSession, ZoneRuleStore } from "../src/session";
import { ZoneRules } from "@runshape/architecture";
import { buildSystemGraph, SystemGraph } from "@runshape/views";
import { Phase } from "@runshape/trace";
import { loadFixtureRun } from "../../trace/test/fixtures";

const GROUPING = { collapseMiddleware: true };

function zonesByComponent(graph: SystemGraph): string[] {
  return graph.nodes
    .filter((node) => node.zoneSource !== "fixed")
    .map((node) => `${node.zone.padEnd(13)}${node.label} — ${node.zoneReason}${node.smells.length ? `  !${node.smells.join(",")}` : ""}`)
    .sort();
}

function violations(graph: SystemGraph): string[] {
  const label = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return graph.edges.filter((edge) => edge.violation).map((edge) => `${label.get(edge.from)} -> ${label.get(edge.to)}: ${edge.violation}`);
}

describe("layered", () => {
  test("FastAPI as relaxed layers: routes and dependencies on top, services in the middle, repositories at the bottom", async () => {
    const run = await loadFixtureRun("fastapi");

    const graph = buildSystemGraph(run, { grouping: GROUPING, profile: profileFor(ArchitectureStyle.Layered) });

    // Relaxed layering allows routes to call repositories, so nothing the hexagon flagged
    // as "skips the core" is a violation here. The one finding is real: the users repository
    // calls UserInDB.change_password (a domain model) while saving — data reaching up into
    // business logic.
    expect(zonesByComponent(graph)).toMatchInlineSnapshot(`
      [
        "business     UserInDB — named like business code ("domain")",
        "business     domain.rwmodel — named like business code ("domain")",
        "business     services.articles — named like business code ("services")",
        "business     services.authentication — named like business code ("services")",
        "business     services.jwt — named like business code ("services")",
        "business     services.security — named like business code ("services")",
        "data         ArticlesRepository — named like data access code ("repositories")",
        "data         DateTimeModelMixin — named like data access code ("models")",
        "data         ProfilesRepository — named like data access code ("repositories")",
        "data         TagsRepository — named like data access code ("repositories")",
        "data         UsersRepository — named like data access code ("repositories")",
        "presentation RWAPIKeyHeader — named like presentation code ("dependencies")",
        "presentation articles.articles_common — named like presentation code ("routes")",
        "presentation articles.articles_resource — named like presentation code ("routes")",
        "presentation dependencies.authentication — named like presentation code ("dependencies")",
        "presentation dependencies.database — named like presentation code ("dependencies")",
        "presentation errors.http_error — named like presentation code ("api")",
        "presentation routes.authentication — named like presentation code ("routes")",
      ]
    `);
    expect(violations(graph)).toMatchInlineSnapshot(`
      [
        "UsersRepository -> UserInDB: data access calling up into business logic",
      ]
    `);
  });
});

describe("mvc", () => {
  test("Django as MVT: views are controllers, models query for themselves, serializers and renderers are the view", async () => {
    const run = await loadFixtureRun("django");

    const graph = buildSystemGraph(run, { grouping: GROUPING, profile: profileFor(ArchitectureStyle.Mvc) });

    // Names place almost everything. The smells are MVC's real tension in Django: viewsets and
    // serializers build ORM querysets themselves, so they reach the database without going
    // through a model method. No call goes against MVC's directions.
    expect(zonesByComponent(graph)).toMatchInlineSnapshot(`
      [
        "controller   ArticleViewSet — named like controller code ("views")  !touches-external",
        "controller   ArticlesFavoriteAPIView — named like controller code ("views")  !touches-external",
        "controller   CommentsListCreateAPIView — named like controller code ("views")  !touches-external",
        "controller   JWTAuthentication — the framework calls it while serving requests (in conduit)  !touches-external",
        "controller   LoginAPIView — named like controller code ("views")",
        "controller   ProfileFollowAPIView — named like controller code ("views")  !touches-external",
        "controller   RegistrationAPIView — named like controller code ("views")  !touches-external",
        "controller   UserRetrieveUpdateAPIView — named like controller code ("views")  !touches-external",
        "controller   core.exceptions — the framework calls it while serving requests (in conduit)",
        "model        Profile — named like model code ("models")",
        "model        TagRelatedField — calls sqlite directly",
        "model        User — named like model code ("models")",
        "model        UserManager — named like model code ("models")",
        "model        articles.signals — named like model code ("signals")",
        "model        authentication.signals — named like model code ("signals")",
        "model        core.utils — receives no requests and calls no external system",
        "view         ArticleJSONRenderer — named like view code ("renderers")",
        "view         ArticleSerializer — named like view code ("serializers")  !touches-external",
        "view         CommentJSONRenderer — named like view code ("renderers")",
        "view         CommentSerializer — named like view code ("serializers")  !touches-external",
        "view         LoginSerializer — named like view code ("serializers")  !touches-external",
        "view         ProfileJSONRenderer — named like view code ("renderers")",
        "view         ProfileSerializer — named like view code ("serializers")",
        "view         RegistrationSerializer — named like view code ("serializers")",
        "view         UserJSONRenderer — named like view code ("renderers")",
      ]
    `);
    expect(violations(graph)).toMatchInlineSnapshot(`[]`);
  });
});

describe("drawing in another style", () => {
  test("the viewer can draw a run in any style without saving it; the file's own rules apply only to its own style", async () => {
    const run = await loadFixtureRun("fastapi");
    const rules = new ZoneRules([{ match: "app.db.repositories.users.UsersRepository", zone: HexagonalZone.Core, reason: "a test rule", by: "user" }]);
    const session = new ViewerSession(run, { sources: { readLines: async () => null }, rules });
    const usersRepository = async (style?: string) => {
      const response = await session.handle({ type: "graph", phases: [Phase.Call], grouping: GROUPING, style });
      if (response?.type !== "graph") return response;
      const node = response.graph.nodes.find((n) => n.label === "UsersRepository")!;
      return `${response.graph.profile.style}: ${node.zone} (${node.zoneSource})`;
    };

    expect(session.summary().style).toBe("hexagonal");
    expect(await usersRepository()).toBe("hexagonal: core (rule)");
    expect(await usersRepository("layered")).toBe("layered: data (inferred)");
    expect(await usersRepository("microservices")).toEqual({ type: "error", message: 'unknown style "microservices"; one of hexagonal, layered, mvc, mvvm, mvp' });
  });
});

describe("detect and adopt", () => {
  test("the viewer ranks the styles, and adopting one rewrites runshape.json only once the person confirms", async () => {
    const run = await loadFixtureRun("fastapi");
    const asked: string[] = [];
    let saved: string | null = null;
    let confirm = false;
    const store: ZoneRuleStore = {
      save: async (rules, change) => {
        asked.push(`${change.question} [${change.confirm}]\n${change.detail}`);
        if (confirm) saved = rules.serialize();
        return confirm;
      },
    };
    const session = new ViewerSession(run, { sources: { readLines: async () => null }, ruleStore: store });

    const detected = await session.handle({ type: "detectArchitecture" });
    const declined = await session.handle({ type: "adoptArchitecture", style: "layered", from: "detected" });
    confirm = true;
    const adopted = await session.handle({ type: "adoptArchitecture", style: "layered", from: "detected" });
    const graph = await session.handle({ type: "graph", phases: [Phase.Call], grouping: GROUPING });

    expect(detected?.type === "architecture" && detected.candidates.map((c) => `${c.style} ${c.score}`)).toMatchInlineSnapshot(`
      [
        "layered 0.96",
        "hexagonal 0.77",
        "mvc 0.26",
        "mvvm 0.03",
        "mvp 0.03",
      ]
    `);
    expect(declined).toBeNull();
    expect(asked[0]).toMatchInlineSnapshot(`
      "Rewrite runshape.json as Layered (n-tier, relaxed)? [Rewrite runshape.json]
      Style: Layered (n-tier, relaxed)
        app.models.domain.** → business
        app.api.** → presentation
        app.db.** → data
        app.models.** → data
        app.services.** → business

      runshape.json has no rules now (hexagonal style)."
    `);
    expect(adopted).toEqual({ type: "rulesChanged", count: 5, style: "layered" });
    expect(JSON.parse(saved!).style).toBe("layered");
    expect(session.summary().style).toBe("layered");
    const userInDb = graph?.type === "graph" ? graph.graph.nodes.find((n) => n.label === "UserInDB") : undefined;
    expect(`${userInDb?.zone} (${userInDb?.zoneSource}: ${userInDb?.zoneReason})`).toMatchInlineSnapshot(`"business (rule: declared in runshape.json (app.models.domain.**): business: the package is named "domain")"`);
  });
});

describe("adopting over hand-written rules", () => {
  test("the confirmation names every rule that would be discarded, and why it was there", async () => {
    const run = await loadFixtureRun("fastapi");
    const rules = new ZoneRules([{ match: "app.services.jwt", zone: HexagonalZone.Core, reason: "pure token logic", by: "user" }]);
    const asked: string[] = [];
    const store: ZoneRuleStore = { save: async (_rules, change) => (asked.push(change.detail), false) };
    const session = new ViewerSession(run, { sources: { readLines: async () => null }, ruleStore: store, rules });

    await session.handle({ type: "adoptArchitecture", style: "mvc", from: "detected" });

    expect(asked[0]!.split("\n").slice(-2)).toEqual([
      "It replaces runshape.json's 1 rule(s) (hexagonal style), which are discarded:",
      "  app.services.jwt → core (user: pure token logic)",
    ]);
  });
});
