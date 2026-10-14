/**
 * A CodeSymbol is how the viewer names a function without knowing the language it was written
 * in. The recorder (today, the trace parser on its behalf) splits a name into segments once;
 * nothing past the parser splits strings on a language's separators. Comparisons across runs
 * (diffs, review) rely on one rule: the same function recorded twice has the same key.
 */
import { describe, expect, test } from "vitest";

import { loadLatestRun, loadPreviousRun } from "../src/trace/load";
import { pythonSymbol } from "../src/trace/parse";
import { fixtureFiles, loadFixtureRun } from "./fixtures";

describe("CodeSymbol", () => {
  test("Python names split into namespace, container and name, whatever the nesting", async () => {
    const run = await loadFixtureRun("fastapi");
    const named = (dotted: string) => run.catalog.find((fn) => `${fn.symbol.dottedNamespace}:${fn.symbol.dottedPath}` === dotted)!.symbol;

    const shapes = [
      named("app.db.repositories.users:UsersRepository.get_user_by_email"),
      named("app.api.dependencies.database:get_repository.<locals>._get_repo"),
      named("app.db.repositories.tags:TagsRepository.get_all_tags.<locals>.<listcomp>"),
      pythonSymbol("conduit.apps.articles.migrations.0002_comment", "<module>"),
    ].map(({ namespace, container, name }) => ({ namespace, container, name }));

    expect(shapes).toMatchInlineSnapshot(`
      [
        {
          "container": [
            "UsersRepository",
          ],
          "name": "get_user_by_email",
          "namespace": [
            "app",
            "db",
            "repositories",
            "users",
          ],
        },
        {
          "container": [
            "get_repository",
            "<locals>",
          ],
          "name": "_get_repo",
          "namespace": [
            "app",
            "api",
            "dependencies",
            "database",
          ],
        },
        {
          "container": [
            "TagsRepository",
            "get_all_tags",
            "<locals>",
          ],
          "name": "<listcomp>",
          "namespace": [
            "app",
            "db",
            "repositories",
            "tags",
          ],
        },
        {
          "container": [],
          "name": "<module>",
          "namespace": [
            "conduit",
            "apps",
            "articles",
            "migrations",
            "0002_comment",
          ],
        },
      ]
    `);
  });

  test("the same function in two recordings has the same key, so diffs can pair them up", async () => {
    const files = fixtureFiles("django-feed-fix");
    const before = (await loadPreviousRun(files))!;
    const after = await loadLatestRun(files);

    const keysBefore = new Set(before.catalog.map((fn) => fn.symbol.key));
    const unmatched = after.catalog.filter((fn) => !keysBefore.has(fn.symbol.key)).map((fn) => fn.symbol.dottedPath);
    expect(unmatched, "the routing fix moved a URL pattern; it added and removed no functions").toEqual([]);

    // A span's symbol and the catalog's are built separately but find each other by key.
    const span = after.scenarios.flatMap((s) => s.spans).find((s) => s.fn.symbol.dottedPath === "ArticlesFeedAPIView.get_queryset")!;
    expect(after.catalogFunction(span.fn.symbol)?.file).toBe("conduit/apps/articles/views.py");
  });
});
