/**
 * A CodeSymbol is how the viewer names a function without knowing the language it was written
 * in. The recorder (today, the trace parser on its behalf) splits a name into segments once;
 * nothing past the parser splits strings on a language's separators. Comparisons across runs
 * (diffs, review) rely on one rule: the same function recorded twice has the same key.
 */
import { describe, expect, test } from "vitest";

import { CodeSymbol, FunctionInfo, Phase, Role, Span, SymbolKind } from "../src/model";
import { loadLatestRun, loadPreviousRun } from "../src/trace/load";
import { pythonSymbol } from "../src/trace/parse";
import { componentOf } from "../src/views/components";
import { diffFunctionExecution } from "../src/views/execution-diff";
import { fixtureFiles, loadFixtureRun } from "./fixtures";

describe("CodeSymbol", () => {
  test("Python names split into namespace, container and name, whatever the nesting", async () => {
    const run = await loadFixtureRun("fastapi");
    const named = (dotted: string) => run.catalog.find((fn) => `${fn.symbol.namespaceName.text}:${fn.symbol.localName.text}` === dotted)!.symbol;

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

  test("each symbol says what kind of code it is and which type owns it", () => {
    // Views ask these instead of looking for __init__, <module> or <locals> in a name: a Go
    // or Rust recorder says "constructor" or "nested" without Python's spelling.
    const described = [
      ["app.db.repositories.users", "UsersRepository.get_user_by_email"],
      ["app.db.repositories.users", "UsersRepository.__init__"],
      ["app.services.articles", "check_article_exists"],
      ["app.api.dependencies.database", "get_repository.<locals>._get_repo"],
      ["app.db.repositories.tags", "TagsRepository.get_all_tags.<locals>.<listcomp>"],
      ["conduit.apps.articles.migrations.0002_comment", "<module>"],
      ["app.models", "Outer.Inner.method"],
    ].map(([module, qualname]) => {
      const { kind, ownerType } = pythonSymbol(module!, qualname!);
      return `${qualname}: ${kind}${ownerType ? ` of ${ownerType}` : ""}`;
    });

    expect(described).toEqual([
      "UsersRepository.get_user_by_email: method of UsersRepository",
      "UsersRepository.__init__: constructor of UsersRepository",
      "check_article_exists: function",
      "get_repository.<locals>._get_repo: nested",
      // A comprehension in a method still belongs to the method's class box.
      "TagsRepository.get_all_tags.<locals>.<listcomp>: nested of TagsRepository",
      "<module>: initializer",
      // Nested classes are drawn as their outermost class, as before.
      "Outer.Inner.method: method of Outer",
    ]);
  });

  test("the same function in two recordings has the same key, so diffs can pair them up", async () => {
    const files = fixtureFiles("django-feed-fix");
    const before = (await loadPreviousRun(files))!;
    const after = await loadLatestRun(files);

    const keysBefore = new Set(before.catalog.map((fn) => fn.symbol.key));
    const unmatched = after.catalog.filter((fn) => !keysBefore.has(fn.symbol.key)).map((fn) => fn.symbol.localName.text);
    expect(unmatched, "the routing fix moved a URL pattern; it added and removed no functions").toEqual([]);

    // A span's symbol and the catalog's are built separately but find each other by key.
    const span = after.scenarios.flatMap((s) => s.spans).find((s) => s.fn.symbol.localName.text === "ArticlesFeedAPIView.get_queryset")!;
    expect(after.catalogFunction(span.fn.symbol.key)?.file).toBe("conduit/apps/articles/views.py");
  });

  test("two functions with the same name in different modules stay apart", async () => {
    // Real: the FastAPI example's tests define test_frw_validation_error_format in two modules.
    const run = await loadFixtureRun("fastapi");
    const modules = ["tests.test_api.test_errors.test_422_error", "tests.test_api.test_errors.test_error"];
    expect(modules.map((module) => run.catalogFunction(pythonSymbol(module, "test_frw_validation_error_format").key)?.file)).toEqual([
      "tests/test_api/test_errors/test_422_error.py",
      "tests/test_api/test_errors/test_error.py",
    ]);

    // Neither runs in a recorded scenario, so for the execution diff, plant a namesake of
    // check_article_exists from another module in the "after" recording.
    const files = fixtureFiles("fastapi-slug-refactor");
    const before = (await loadPreviousRun(files))!;
    const after = await loadLatestRun(files);
    const create = "tests/test_api/test_routes/test_articles.py::test_user_can_create_article";
    const calls = (symbol: CodeSymbol) => {
      const diff = diffFunctionExecution(before, after, create, symbol);
      return `${diff.callsBefore} -> ${diff.callsAfter}`;
    };
    const real = after.catalog.find((fn) => fn.symbol.localName.text === "check_article_exists")!.symbol;
    const realCalls = calls(real);

    const namesake = new CodeSymbol(["app", "legacy", "articles"], [], "check_article_exists", SymbolKind.Function, null);
    const fn: FunctionInfo = { role: Role.Source, symbol: namesake, file: "app/legacy/articles.py", firstLine: 1, landmarkKind: null };
    after.scenario(create)!.spans.push(new Span(1_000_000, fn, null, null, Phase.Call, 0, 1));

    expect({ real: calls(real), namesake: calls(namesake) }).toEqual({ real: realCalls, namesake: "0 -> 1" });
  });
});

describe("components are named from segments", () => {
  // A Go package: module "example.com/shop", package "orders". Its first segment holds a dot,
  // so any code that rebuilt the name by splitting "example.com.shop.orders" would see four
  // segments where the recorder sent three.
  const GO_PACKAGE = ["example.com", "shop", "orders"];
  const spanOf = (symbol: CodeSymbol) => {
    const fn: FunctionInfo = { role: Role.Source, symbol, file: "orders/service.go", firstLine: 1, landmarkKind: null };
    return new Span(1, fn, null, null, Phase.Call, 0, 1);
  };

  test("a method's box is its type; a free function's box is its package, labelled by its last two segments", () => {
    const method = componentOf(spanOf(new CodeSymbol(GO_PACKAGE, ["Service"], "Place", SymbolKind.Method, "Service")));
    const free = componentOf(spanOf(new CodeSymbol(GO_PACKAGE.slice(0, 2), [], "Handle", SymbolKind.Function, null)));

    // Ids use Runshape's dotted syntax, where a dot inside a segment is escaped, so
    // "example.com"+"shop" and "example"+"com.shop" can't share a box.
    expect([method, free].map(({ id, kind, label, name }) => ({ id, kind, label, segments: name?.segments }))).toEqual([
      { id: "class:example\\.com.shop.orders.Service", kind: "class", label: "Service", segments: [...GO_PACKAGE, "Service"] },
      // Split text would have labelled this "com.shop".
      { id: "module:example\\.com.shop", kind: "module", label: "example.com.shop", segments: ["example.com", "shop"] },
    ]);
  });
});
