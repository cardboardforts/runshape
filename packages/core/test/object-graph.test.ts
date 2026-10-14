/**
 * The runtime wiring diagram: who holds whom, from the recorder's `W` events. In the FastAPI
 * example, repositories are built per request by a FastAPI dependency and hold each other.
 */
import { describe, expect, test } from "vitest";

import { Phase } from "@runshape/trace";
import { aggregateWiring, buildObjectGraph } from "@runshape/views";
import { buildReplay } from "@runshape/views";
import { buildSystemGraph } from "@runshape/views";
import { loadFixtureRun } from "./fixtures";

const CREATE = "tests/test_api/test_routes/test_articles.py::test_user_can_create_article";
const short = (id: string) => id.split(".").pop();

describe("object wiring", () => {
  test("one test's objects: what built each one and what it holds", async () => {
    const run = await loadFixtureRun("fastapi");
    const graph = buildObjectGraph(run.scenario(CREATE)!);
    const label = new Map(graph.objects.map((o) => [o.id, `${short(o.className)}#${o.id}`]));

    expect({
      built: graph.objects.filter((o) => o.builtBy !== null).map((o) => `${label.get(o.id)} built by ${o.builtBy}`),
      wires: graph.wires.map((w) => `${label.get(w.from)}.${w.attribute} -> ${label.get(w.to)}`),
    }).toMatchInlineSnapshot(`
      {
        "built": [
          "UsersRepository#1 built by test_user",
          "UsersRepository#3 built by get_repository.<locals>._get_repo",
          "ArticlesRepository#5 built by get_repository.<locals>._get_repo",
          "ProfilesRepository#6 built by ArticlesRepository.__init__",
          "UsersRepository#7 built by ProfilesRepository.__init__",
          "TagsRepository#8 built by ArticlesRepository.__init__",
        ],
        "wires": [
          "ArticlesRepository#5._profiles_repo -> ProfilesRepository#6",
          "ArticlesRepository#5._tags_repo -> TagsRepository#8",
          "ProfilesRepository#6._users_repo -> UsersRepository#7",
        ],
      }
    `);
  });

  test("across all tests: each class's holdings, by attribute", async () => {
    const run = await loadFixtureRun("fastapi");

    expect(aggregateWiring(run).map((w) => `${short(w.from)} -> ${short(w.to)} via ${w.attributes.join(", ")} (${w.references}x)`))
      .toMatchInlineSnapshot(`
        [
          "ArticlesRepository -> ProfilesRepository via _profiles_repo (6x)",
          "ArticlesRepository -> TagsRepository via _tags_repo (6x)",
          "ProfilesRepository -> UsersRepository via _users_repo (6x)",
        ]
      `);
  });

  test("an object's component is the same box its method calls are drawn in", async () => {
    const run = await loadFixtureRun("fastapi");
    const nodeIds = new Set(buildSystemGraph(run).nodes.map((n) => n.id));

    const wiredComponents = aggregateWiring(run).flatMap((w) => [w.from, w.to]);

    expect(wiredComponents.filter((id) => !nodeIds.has(id))).toEqual([]);
  });
});

describe("assembly over time", () => {
  // A replay builds the object graph as it happened: each object appears when it was first
  // seen, each wire when its holder's __init__ finished, and each hop names the object doing
  // the work. Here: the fixture's user, then per request a repository for the route, which
  // builds the repositories it needs, which hold each other.
  test("creating an article: objects appear and get wired in the order the requests built them", async () => {
    const run = await loadFixtureRun("fastapi");
    const scenario = run.scenario(CREATE)!;
    const graph = buildObjectGraph(scenario);
    const label = new Map(graph.objects.map((o) => [o.id, `${short(o.className)}#${o.id}`]));

    const events = [
      ...graph.objects.map((o) => ({ t: o.seenUs, text: `+ ${label.get(o.id)}${o.builtBy ? ` (by ${o.builtBy})` : ""}` })),
      ...graph.wires.map((w) => ({ t: w.atUs, text: `  ${label.get(w.from)}.${w.attribute} -> ${label.get(w.to)}` })),
    ].sort((a, b) => a.t - b.t);
    expect(events.map((e) => e.text)).toMatchInlineSnapshot(`
      [
        "+ TestAppSettings#0",
        "+ UsersRepository#1 (by test_user)",
        "+ UserInDB#2",
        "+ UsersRepository#3 (by get_repository.<locals>._get_repo)",
        "+ RWAPIKeyHeader#4",
        "+ ArticlesRepository#5 (by get_repository.<locals>._get_repo)",
        "+ ProfilesRepository#6 (by ArticlesRepository.__init__)",
        "+ UsersRepository#7 (by ProfilesRepository.__init__)",
        "  ProfilesRepository#6._users_repo -> UsersRepository#7",
        "+ TagsRepository#8 (by ArticlesRepository.__init__)",
        "  ArticlesRepository#5._profiles_repo -> ProfilesRepository#6",
        "  ArticlesRepository#5._tags_repo -> TagsRepository#8",
      ]
    `);

    // The hops into those objects carry them, so a replay can light the very object called.
    const steps = buildReplay(scenario, [Phase.Setup, Phase.Call], { collapseMiddleware: true });
    const intoObjects = steps.filter((s) => s.kind === "call" && s.objectId !== null).slice(0, 6);
    expect(intoObjects.map((s) => `${s.label} on ${label.get(s.objectId!)}`)).toMatchInlineSnapshot(`
      [
        "AppSettings.configure_logging on TestAppSettings#0",
        "AppSettings.fastapi_kwargs on TestAppSettings#0",
        "BaseRepository.__init__ on UsersRepository#1",
        "UsersRepository.create_user on UsersRepository#1",
        "UserInDB.change_password on UserInDB#2",
        "BaseRepository.__init__ on UsersRepository#3",
      ]
    `);
  });
});
