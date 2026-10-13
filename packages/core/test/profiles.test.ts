/**
 * Drawing an app in a style other than the hexagon: the profile decides the zones, how
 * unplaced components are inferred (names first, then behaviour), which calls break the
 * style, and which zones may talk to external systems. On the real example recordings.
 */
import { describe, expect, test } from "vitest";

import { ArchitectureStyle, HexagonalZone, profileFor } from "../src/profiles";
import { ViewerSession } from "../src/session";
import { ZoneRules } from "../src/zones";
import { buildSystemGraph, SystemGraph } from "../src/views/system-graph";
import { Phase } from "../src/model";
import { loadFixtureRun } from "./fixtures";

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
