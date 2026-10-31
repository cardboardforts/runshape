/**
 * The webview names a function by the key a view handed it (FunctionRef.key), never by
 * rebuilding a language's names: the session never has to know how Python, Go or TypeScript
 * spell a function to find the one a person clicked.
 */
import { describe, expect, test } from "vitest";

import { Phase } from "@runshape/kernel";
import { ZoneRules } from "@runshape/architecture";
import { ViewerSession } from "../src/session";
import { fixtureRuns } from "../../kernel/test/fixtures";

const CREATE = "tests/test_api/test_routes/test_articles.py::test_user_can_create_article";
const GROUPING = { collapseMiddleware: true };

async function refactorSession(): Promise<ViewerSession> {
  const runs = fixtureRuns("fastapi-slug-refactor");
  const baseline = await runs.previous();
  return new ViewerSession(await runs.latest(), { sources: { readLines: async () => null }, baseline });
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
    const session = new ViewerSession(await fixtureRuns("go-shop-running").latest(), { sources: { readLines: async () => null } });

    expect(await session.handle({ type: "routes", phases: [Phase.Call], compare: true })).toEqual({
      type: "error",
      message: "There is no earlier recording to compare with yet.",
    });
  });
});

describe("comparing two commits' architecture on the wire", () => {
  const shopRules = (zones: object[]) => ZoneRules.parse(JSON.stringify({ version: 2, style: "hexagonal", zones }));
  const STORAGE = { match: "example\\.com.shop.internal.storage.**", zone: "outbound-adapter", reason: "stores orders", by: "llm" };

  test("each side drawn with its own rules: the branch's new rule is a decision in the diff", async () => {
    const run = await fixtureRuns("go-shop").latest();
    const session = new ViewerSession(run, { sources: { readLines: async () => null }, baseline: run, rules: shopRules([STORAGE]), baselineRules: shopRules([]) });

    const response = await session.handle({ type: "diff", phases: [Phase.Call], grouping: GROUPING });
    if (response?.type !== "diff") throw new Error(`expected a diff, got ${response?.type}`);

    expect({
      baseRulesKnown: response.baseRulesKnown,
      added: response.architecture.rules.added.map((rule) => rule.match),
      decided: response.architecture.decided.map((change) => `${change.component}: ${change.before?.zone} -> ${change.after?.zone}`),
    }).toEqual({
      baseRulesKnown: true,
      added: [STORAGE.match],
      decided: ["example\\.com.shop.internal.storage: core -> outbound-adapter", "example\\.com.shop.internal.storage.MemoryRepository: core -> outbound-adapter"],
    });
  });

  test("a style changed in the branch is one change, not every class moving", async () => {
    const run = await fixtureRuns("go-shop").latest();
    const mvc = ZoneRules.parse(JSON.stringify({ version: 2, style: "mvc", zones: [] }));
    const session = new ViewerSession(run, { sources: { readLines: async () => null }, baseline: run, rules: shopRules([]), baselineRules: mvc });

    const response = await session.handle({ type: "diff", phases: [Phase.Call], grouping: GROUPING });
    if (response?.type !== "diff") throw new Error(`expected a diff, got ${response?.type}`);

    const { styleBefore, styleAfter, observed, decided } = response.architecture;
    expect({ styleBefore, styleAfter, observed: observed.length, decided: decided.length }).toEqual({ styleBefore: "mvc", styleAfter: "hexagonal", observed: 0, decided: 0 });
  });

  test("the zones are named in the commit's own style, whatever style the graph previews", async () => {
    const run = await fixtureRuns("go-shop").latest();
    const session = new ViewerSession(run, { sources: { readLines: async () => null }, baseline: run, rules: shopRules([STORAGE]), baselineRules: shopRules([]) });

    const response = await session.handle({ type: "diff", phases: [Phase.Call], grouping: GROUPING, style: "mvc" });
    if (response?.type !== "diff") throw new Error(`expected a diff, got ${response?.type}`);

    expect(response.architecture.zones.map((zone) => zone.id)).toEqual(["inbound-adapter", "core", "outbound-adapter"]);
  });

  test("a head runshape.json that can't be read isn't 'every rule removed': both sides use what the session has, and the response says so", async () => {
    const run = await fixtureRuns("go-shop").latest();
    const session = new ViewerSession(run, { sources: { readLines: async () => null }, baseline: run, rulesProblem: "not valid JSON", baselineRules: shopRules([STORAGE]) });

    const response = await session.handle({ type: "diff", phases: [Phase.Call], grouping: GROUPING });
    if (response?.type !== "diff") throw new Error(`expected a diff, got ${response?.type}`);

    expect({ baseRulesKnown: response.baseRulesKnown, removed: response.architecture.rules.removed }).toEqual({ baseRulesKnown: false, removed: [] });
  });

  test("without the base's rules both sides use the current ones, and the response says so", async () => {
    const run = await fixtureRuns("go-shop").latest();
    const session = new ViewerSession(run, { sources: { readLines: async () => null }, baseline: run, rules: shopRules([STORAGE]) });

    const response = await session.handle({ type: "diff", phases: [Phase.Call], grouping: GROUPING });
    if (response?.type !== "diff") throw new Error(`expected a diff, got ${response?.type}`);

    expect({ baseRulesKnown: response.baseRulesKnown, decided: response.architecture.decided }).toEqual({ baseRulesKnown: false, decided: [] });
  });
});

describe("the canvas on the wire: a layout, placed once for 2D and 3D", () => {
  test("the module view, a module opened from it (its classes; replays must use the layout's grouping), and the same compared", async () => {
    const session = await refactorSession();
    const modules = session.summary().modules;
    const grouping = { ...GROUPING, modules };

    const atModules = await session.handle({ type: "graph", phases: [Phase.Call], grouping });
    const opened = await session.handle({ type: "graph", phases: [Phase.Call], grouping, opened: "app.services" });
    const compared = await session.handle({ type: "diff", phases: [Phase.Call], grouping, opened: "app.services" });
    if (atModules?.type !== "graph" || opened?.type !== "graph" || compared?.type !== "diff") throw new Error("expected two layouts and a diff");

    const boxes = (nodes: { label: string; opens: string | null; change: string | null }[]) =>
      nodes.map((node) => `${node.label}${node.opens ? " ▸" : ""}${node.change && node.change !== "unchanged" ? ` (${node.change})` : ""}`).join(", ");
    expect({
      modules: boxes(atModules.layout.nodes),
      opened: boxes(opened.layout.nodes),
      openedGrouping: opened.layout.grouping.modules,
      compared: boxes(compared.layout.nodes),
    }).toMatchInlineSnapshot(`
      {
        "compared": "app.api ▸, app.db ▸, app.models ▸, services.articles (changed), services.authentication, services.jwt, services.security",
        "modules": "Client (tests), FakeAsyncPGPool, FakePoolAcquireContent, postgres, FastAPI, Middleware ×3, APIRouter, app.api ▸, app.db ▸, app.models ▸, app.services ▸",
        "opened": "app.api ▸, app.db ▸, app.models ▸, services.articles, services.authentication, services.jwt, services.security",
        "openedGrouping": [
          "app.api",
          "app.core",
          "app.db",
          "app.main",
          "app.models",
        ],
      }
    `);
  });

  test("opening a module the view doesn't have is refused, not drawn as nothing", async () => {
    const session = await refactorSession();

    const response = await session.handle({ type: "graph", phases: [Phase.Call], grouping: GROUPING, opened: "app.services" });

    expect(response).toEqual({ type: "error", message: `"app.services" isn't one of this view's modules: open a module from the module view` });
  });
});

describe("moving a box on the wire", () => {
  /** The arrangement file as the app keeps it: text in, text out. */
  const memoryFile = (text: string | null = null) => ({
    where: ".runshape/arrangement.json",
    text,
    async read() {
      return this.text;
    },
    async write(next: string) {
      this.text = next;
    },
  });

  test("a box moved in 2D is saved, and the next session (the next recording, the next diff) draws it there", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");
    const file = memoryFile();
    const first = new ViewerSession(await runs.latest(), { sources: { readLines: async () => null }, arrangements: file });
    const drawn = await first.handle({ type: "graph", phases: [Phase.Call], grouping: GROUPING });
    if (drawn?.type !== "graph") throw new Error("expected a layout");
    const repository = drawn.layout.nodes.find((node) => node.label === "UsersRepository")!;

    const moved = await first.handle({ type: "arrange", level: drawn.layout.level, style: drawn.layout.profile.style, node: repository.id, to: { flat: { x: -500, y: 900 } } });
    const base = new ViewerSession((await runs.previous())!, { sources: { readLines: async () => null }, arrangements: file });
    const again = await base.handle({ type: "graph", phases: [Phase.Call], grouping: GROUPING });
    if (again?.type !== "graph") throw new Error("expected a layout");

    const there = again.layout.nodes.find((node) => node.label === "UsersRepository")!;
    expect({
      moved,
      saved: Object.keys(JSON.parse(file.text!).levels),
      there: { flat: there.flat, arranged: there.arranged },
      notArranged: again.layout.nodes.filter((node) => !node.arranged).map((node) => `${node.label}${node.placedNearNeighbours ? " (placed near its neighbours)" : ""}`),
    }).toMatchInlineSnapshot(`
      {
        "moved": null,
        "notArranged": [],
        "saved": [
          "classes@hexagonal",
        ],
        "there": {
          "arranged": true,
          "flat": {
            "x": -500,
            "y": 900,
          },
        },
      }
    `);
  });

  test("a move that names no drawn box, or no spot, is refused; so is saving over a file that can't be read", async () => {
    const run = await fixtureRuns("fastapi-slug-refactor").latest();
    const session = new ViewerSession(run, { sources: { readLines: async () => null }, arrangements: memoryFile("{ not json") });
    const drawn = await session.handle({ type: "graph", phases: [Phase.Call], grouping: GROUPING });
    if (drawn?.type !== "graph") throw new Error("expected a layout");
    const at = { level: drawn.layout.level, style: drawn.layout.profile.style };

    const answers = await Promise.all([
      session.handle({ type: "arrange", ...at, node: "class:nowhere.Nothing", to: { flat: { x: 1, y: 2 } } }),
      session.handle({ type: "arrange", ...at, node: drawn.layout.nodes[0]!.id, to: { flat: { x: "1", y: 2 } } } as never),
      session.handle({ type: "arrange", ...at, node: drawn.layout.nodes[0]!.id, to: { floor: { x: 1, z: 2 } } }),
    ]);

    expect(answers.map((answer) => (answer?.type === "error" ? answer.message : answer))).toMatchInlineSnapshot(`
      [
        "That box isn't drawn at this level any more: nothing was moved.",
        "Can't move that box: no spot: flat x and y, or floor x and z, as numbers",
        "Fix .runshape/arrangement.json before moving boxes (it would be overwritten): not JSON: Expected property name or '}' in JSON at position 2 (line 1 column 3)",
      ]
    `);
  });
});
