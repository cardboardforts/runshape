/**
 * The runtime wiring diagram: who holds whom, from the recorder's `W` events. In the FastAPI
 * example, repositories are built per request by a FastAPI dependency and hold each other.
 */
import { describe, expect, test } from "vitest";

import { aggregateWiring, buildObjectGraph } from "../src/views/object-graph";
import { buildSystemGraph } from "../src/views/system-graph";
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
