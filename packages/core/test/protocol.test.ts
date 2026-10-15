/**
 * The webview names a function by the key a view handed it (FunctionRef.key), never by
 * rebuilding a language's names: the session never has to know how Python, Go or TypeScript
 * spell a function to find the one a person clicked.
 */
import { describe, expect, test } from "vitest";

import { Phase } from "@runshape/trace";
import { ViewerSession } from "../src/session";
import { loadLatestRun, loadPreviousRun } from "@runshape/trace";
import { fixtureFiles } from "../../trace/test/fixtures";

const CREATE = "tests/test_api/test_routes/test_articles.py::test_user_can_create_article";
const GROUPING = { collapseMiddleware: true };

async function refactorSession(): Promise<ViewerSession> {
  const files = fixtureFiles("fastapi-slug-refactor");
  const baseline = await loadPreviousRun(files);
  return new ViewerSession(await loadLatestRun(files), { sources: { readLines: async () => null }, baseline });
}

describe("naming functions on the wire", () => {
  test("a function a view lists opens by its key, in the function view and the execution diff alike", async () => {
    const session = await refactorSession();
    const component = await session.handle({ type: "component", id: "module:app.services.articles", grouping: GROUPING });
    if (component?.type !== "component") throw new Error(`expected a component view, got ${JSON.stringify(component)}`);
    const listed = component.view.functions.find((fn) => fn.name === "check_article_exists")!;

    expect(listed.symbol).toEqual({
      key: JSON.stringify([["app", "services", "articles"], [], "check_article_exists"]),
      namespace: "app.services.articles",
      path: "check_article_exists",
      kind: "function",
    });

    const opened = await session.handle({ type: "function", symbol: listed.symbol.key });
    const compared = await session.handle({ type: "functionExecutionDiff", scenarioId: CREATE, symbol: listed.symbol.key, phases: [Phase.Call] });
    expect([opened?.type === "function" && opened.view.symbol, compared?.type === "functionExecutionDiff" && compared.diff.symbol]).toEqual([
      listed.symbol,
      listed.symbol,
    ]);
  });

  test("a request that doesn't name a function by key is refused, not guessed at", async () => {
    const session = await refactorSession();
    const malformed = [
      { type: "function", module: "app.services.articles", qualname: "check_article_exists" },
      { type: "function", symbol: 42 },
      { type: "functionExecutionDiff", scenarioId: CREATE, symbol: null, phases: [Phase.Call] },
    ];

    const responses = await Promise.all(malformed.map((request) => session.handle(request as never)));
    expect(responses).toEqual(malformed.map(() => ({ type: "error", message: "a function is asked for by the symbol key a view gave it" })));
  });
});

describe("the route view on the wire", () => {
  test("routes come with how they changed in compare mode, and alone otherwise", async () => {
    const session = await refactorSession();

    const alone = await session.handle({ type: "routes", phases: [Phase.Call], compare: false });
    const compared = await session.handle({ type: "routes", phases: [Phase.Call], compare: true });
    if (alone?.type !== "routes" || compared?.type !== "routes") throw new Error(`expected routes, got ${alone?.type} and ${compared?.type}`);

    expect({
      routes: alone.routes.routes.map((route) => `${route.label} ×${route.requestCount}`),
      diffWhenAlone: alone.diff,
      changed: compared.diff?.routes.filter((route) => route.change !== "unchanged").map((route) => route.label),
    }).toEqual({
      routes: ["POST /api/articles ×2", "GET /api/articles/feed ×1", "POST /api/users ×1"],
      diffWhenAlone: null,
      changed: ["POST /api/articles"],
    });
  });

  test("comparing with no earlier recording is an error, not an empty diff", async () => {
    const session = new ViewerSession(await loadLatestRun(fixtureFiles("go-shop-running")), { sources: { readLines: async () => null } });

    expect(await session.handle({ type: "routes", phases: [Phase.Call], compare: true })).toEqual({
      type: "error",
      message: "There is no earlier recording to compare with yet.",
    });
  });
});
