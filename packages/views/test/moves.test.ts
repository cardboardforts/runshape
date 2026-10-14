/**
 * Moving code is not changing it. A function's symbol includes where it lives, so a module
 * moved to another package (Runshape's own split into packages, say) would otherwise read as
 * every function in it gone and a namesake added: "now calls parseRun; no longer calls parseRun".
 *
 * A move is a function present only in the base and one present only in head with the same name
 * within its namespace, the same kind and the same source text, paired one to one. A namespace
 * moved when it is gone from head and all its moved functions went to one new namespace; its
 * module and class boxes follow it. Comparisons read base names as head names first, so a pure
 * move compares as unchanged and is listed as a move.
 */
import { describe, expect, test } from "vitest";

import { loadLatestRun, Run, TraceFiles } from "@runshape/trace";
import { CodeSymbol, FunctionInfo, Outcome, Phase, Role, Scenario, Span, SymbolKind } from "@runshape/trace";
import { buildReview, Change, detectMoves, diffExecution, diffFunctionExecution, diffRuns, mergeReplays, Op } from "../src";
import { fixtureFiles } from "../../trace/test/fixtures";

const FROM = "app.services.articles";
const TO = "app.domain.articles";
const CREATE = "tests/test_api/test_routes/test_articles.py::test_user_can_create_article";

/** What to change in a recording, to stage a move from real data. */
interface Rewrite {
  /** Whole modules renamed (the module itself and the classes in it). */
  modules?: Record<string, string>;
  /** Single functions moved: "module:qualname" -> new module. */
  functions?: Record<string, string>;
  /** Object classes renamed, by full dotted name. */
  classes?: Record<string, string>;
  /** Source lines rewritten in the manifest's sources: file -> line number -> new text. */
  lines?: Record<string, Record<number, string>>;
  keepSources?: boolean;
}

function rewritten(files: TraceFiles, rewrite: Rewrite): TraceFiles {
  const modules = rewrite.modules ?? {};
  const renameModule = (name: string) => modules[name] ?? name;
  const renameDotted = (name: string) => {
    for (const [from, to] of Object.entries(modules)) if (name.startsWith(`${from}.`)) return to + name.slice(from.length);
    return rewrite.classes?.[name] ?? name;
  };
  const moveFunction = (fn: { module: string; qualname: string }) => {
    fn.module = rewrite.functions?.[`${fn.module}:${fn.qualname}`] ?? renameModule(fn.module);
  };
  return {
    async readText(path) {
      const data = JSON.parse(await files.readText(path));
      if (path.endsWith("manifest.json")) {
        for (const fn of data.catalog) moveFunction(fn);
        for (const route of data.framework?.routes ?? []) route.handler = renameDotted(route.handler);
        for (const [file, edits] of Object.entries(rewrite.lines ?? {})) {
          for (const [line, text] of Object.entries(edits)) data.sources[file][Number(line) - 1] = text;
        }
        if (rewrite.keepSources === false) delete data.sources;
      } else if (path.includes("/scenarios/")) {
        for (const fn of data.functions) moveFunction(fn);
        for (const event of data.events) if (event[0] === "O") event[3] = renameDotted(event[3]);
      }
      return JSON.stringify(data);
    },
  };
}

const SLUG = () => fixtureFiles("fastapi-slug-refactor");

/** The base as recorded, head as if app/services/articles.py had moved to app/domain/articles.py. */
async function baseAndMoved(options?: { keepSources: boolean }): Promise<{ base: Run; head: Run }> {
  const base = await loadLatestRun(SLUG());
  if (options?.keepSources === false) (base as { sources: unknown }).sources = null;
  return { base, head: await loadLatestRun(rewritten(SLUG(), { modules: { [FROM]: TO }, keepSources: options?.keepSources })) };
}

/** Boxes and edges that appear or disappear between the runs: none, for a pure move. */
function churn(base: Run, head: Run): string[] {
  const diff = diffRuns(base, head);
  return [...diff.nodes, ...diff.edges].filter((item) => item.change === Change.Added || item.change === Change.Removed).map((item) => `${item.change} ${item.id}`);
}

describe("moved code", () => {
  test("a module moved whole: each function pairs with its namesake, and the namespace with its new home", async () => {
    const { base, head } = await baseAndMoved();

    const moves = detectMoves(base, head);

    expect(moves.namespaces.map(({ from, to }) => `${from.text} -> ${to.text}`)).toEqual([`${FROM} -> ${TO}`]);
    expect(moves.functions.map(({ from, to }) => `${from.localName.text}: ${from.namespaceName.text} -> ${to.namespaceName.text}`)).toEqual(
      ["check_article_exists", "ensure_slug_available", "check_user_can_modify_article", "get_slug_for_article", "_normalize_title"].map(
        (name) => `${name}: ${FROM} -> ${TO}`,
      ),
    );
  });

  test("a pure move compares as unchanged, test by test and box by box, and the review says what moved", async () => {
    const { base, head } = await baseAndMoved();

    const diff = diffRuns(base, head);
    const review = buildReview(base, head);

    expect(diff.scenarios.filter((scenario) => scenario.change !== Change.Unchanged).map((scenario) => scenario.name)).toEqual([]);
    expect(diff.nodes.filter((node) => node.change === Change.Added || node.change === Change.Removed).map((node) => node.id)).toEqual([]);
    // A namespace that moved whole is one line; a function that moved on its own would be its own.
    expect(review.moved).toEqual([`${FROM} -> ${TO} (5 functions)`]);
  });

  test("in one test's execution, a moved function's calls line up with themselves and say where they came from", async () => {
    const { base, head } = await baseAndMoved();
    const moves = detectMoves(base, head);
    const before = base.scenario(CREATE)!;
    const after = head.scenario(CREATE)!;

    const execution = diffExecution(before, after, [Phase.Call], moves);
    const replay = mergeReplays(before, after, [Phase.Call], { collapseMiddleware: true }, moves);

    expect(execution.calls.filter((call) => call.op !== Op.Same)).toEqual([]);
    expect(execution.calls.filter((call) => call.movedFrom !== null).map((call) => `${call.symbol.path}: ${call.movedFrom} -> ${call.symbol.namespace}`)).toEqual([
      `ensure_slug_available: ${FROM} -> ${TO}`,
      `get_slug_for_article: ${FROM} -> ${TO}`,
      `_normalize_title: ${FROM} -> ${TO}`,
      `check_article_exists: ${FROM} -> ${TO}`,
    ]);
    expect(replay.filter((step) => step.op !== Op.Same)).toEqual([]);
  });

  test("without source text a move can't be told from a rewrite, so it shows as one", async () => {
    const { base, head } = await baseAndMoved({ keepSources: false });

    expect(detectMoves(base, head).functions).toEqual([]);
    expect(diffRuns(base, head).scenarios.some((scenario) => scenario.change !== Change.Unchanged)).toBe(true);
  });
});

describe("moves the first version got wrong (second-model review)", () => {
  test("a parent namespace moving into a submodule renames only itself, not the modules beside it", async () => {
    // BaseRepository moves from app.db.repositories into app.db.repositories.base: the users,
    // articles, profiles and tags repositories, also under app.db.repositories, stay put.
    const base = await loadLatestRun(rewritten(SLUG(), { modules: { "app.db.repositories.base": "app.db.repositories" } }));
    const head = await loadLatestRun(SLUG());

    expect(detectMoves(base, head).describe()).toEqual(["app.db.repositories -> app.db.repositories.base (2 functions)"]);
    expect(churn(base, head)).toEqual([]);
  });

  test("a module merged into one that already existed is one box, with the calls of both", async () => {
    const base = await loadLatestRun(SLUG());
    const head = await loadLatestRun(rewritten(SLUG(), { modules: { "app.services.authentication": "app.services.jwt" } }));

    const jwt = diffRuns(base, head).nodes.find((node) => node.id === "module:app.services.jwt")!;
    expect([jwt.change, churn(base, head)]).toEqual([Change.Unchanged, []]);
  });

  test("a class moved to another module that stays is the same box", async () => {
    const authentication = "app.api.dependencies.authentication";
    const base = await loadLatestRun(SLUG());
    const head = await loadLatestRun(
      rewritten(SLUG(), {
        functions: { [`${authentication}:RWAPIKeyHeader.__call__`]: "app.api.dependencies.database" },
        classes: { [`${authentication}.RWAPIKeyHeader`]: "app.api.dependencies.database.RWAPIKeyHeader" },
      }),
    );

    expect(detectMoves(base, head).describe()).toEqual([`RWAPIKeyHeader.__call__: ${authentication} -> app.api.dependencies.database`]);
    expect(churn(base, head)).toEqual([]);
  });

  test("a function moved and edited with its module is paired as edited, so its real change shows", async () => {
    const base = await loadLatestRun(SLUG());
    const head = await loadLatestRun(
      rewritten(SLUG(), { modules: { [FROM]: TO }, lines: { "app/services/articles.py": { 15: "        await articles_repo.get_article_by_slug(slug)" } } }),
    );

    const moves = detectMoves(base, head);
    const create = diffRuns(base, head).scenarios.find((scenario) => scenario.id === CREATE)!;
    const reviewed = buildReview(base, head).items.find((item) => item.scenarioId === CREATE)!;

    expect(moves.describe()).toEqual([`${FROM} -> ${TO} (5 functions, 1 edited)`]);
    expect(create.functionsChanged.map((fn) => `${fn.symbol.namespace}:${fn.symbol.path} +${fn.linesNowReached} -${fn.linesNoLongerReached}`)).toEqual([
      `${TO}:check_article_exists +15 -15`,
    ]);
    expect([reviewed.newCalls, reviewed.goneCalls]).toEqual([[], []]);
  });

  test("a moved function's statement diff reads its base calls too", async () => {
    const { base, head } = await baseAndMoved();
    const moves = detectMoves(base, head);
    const moved = head.catalog.find((fn) => fn.symbol.name === "ensure_slug_available")!.symbol;

    const diff = diffFunctionExecution(base, head, CREATE, moved, [Phase.Call], moves);

    expect([diff.callsBefore, diff.callsAfter, diff.statements.filter((statement) => statement.op !== Op.Same)]).toEqual([1, 1, []]);
  });

  test("a one-line body pairs only inside a namespace that moved, never on its text alone", async () => {
    // _get_db_pool is `return request.app.state.pool`: a namesake anywhere with that body isn't a move.
    const base = await loadLatestRun(SLUG());
    const head = await loadLatestRun(rewritten(SLUG(), { functions: { "app.api.dependencies.database:_get_db_pool": "app.services.jwt" } }));

    expect(detectMoves(base, head).functions).toEqual([]);
  });
});

describe("moved tests", () => {
  // A test's id is its file and name, so moving a test file (Runshape's own tests moving into
  // their packages, say) read as every test in it removed and a namesake added.
  const FROM_FILE = "tests/test_api/test_routes/test_articles.py";
  const TO_FILE = "tests/api/test_articles.py";
  const FROM_MODULE = "tests.test_api.test_routes.test_articles";
  const TO_MODULE = "tests.api.test_articles";

  /** The recording as if the articles tests had moved to tests/api/test_articles.py. */
  function movedTests(files: TraceFiles): TraceFiles {
    const moved = rewritten(files, { modules: { [FROM_MODULE]: TO_MODULE } });
    const rename = (nodeid: string) => nodeid.replace(`${FROM_FILE}::`, `${TO_FILE}::`);
    return {
      async readText(path) {
        const data = JSON.parse(await moved.readText(path));
        if (path.endsWith("manifest.json")) for (const entry of data.scenarios) Object.assign(entry, { nodeid: rename(entry.nodeid), file: entry.file });
        else if (path.includes("/scenarios/")) data.nodeid = rename(data.nodeid);
        return JSON.stringify(data);
      },
    };
  }

  test("a moved test file's tests pair with themselves by name, and compare as unchanged", async () => {
    const base = await loadLatestRun(SLUG());
    const head = await loadLatestRun(movedTests(SLUG()));
    const movedCreate = CREATE.replace(FROM_FILE, TO_FILE);

    const diff = diffRuns(base, head);
    const review = buildReview(base, head);
    const moves = detectMoves(base, head);

    expect(diff.scenarios.filter((scenario) => scenario.change !== Change.Unchanged).map((scenario) => `${scenario.change} ${scenario.id}`)).toEqual([]);
    expect(review.moved).toEqual([`${FROM_MODULE} -> ${TO_MODULE} (19 functions)`, `${FROM_FILE} -> ${TO_FILE} (3 tests)`]);
    // The test's own calls line up too: its function moved with it.
    const execution = diffExecution(base.scenario(CREATE)!, head.scenario(movedCreate)!, [Phase.Call], moves);
    expect([moves.baseScenarioId(movedCreate), execution.calls.filter((call) => call.op !== Op.Same)]).toEqual([CREATE, []]);
  });

  test("tests pair by their whole name within the file, and only out of a file that's gone", async () => {
    // Python's name for a test includes its class; a test whose file is still there didn't move.
    const run = (nodeids: string[]) => ({ scenarios: nodeids.map((nodeid) => scenarioNamed(nodeid)), catalog: [], sources: null }) as unknown as Run;
    const pairs = (base: string[], head: string[]) => detectMoves(run(base), run(head)).describe();

    expect([
      pairs(["a.py::A::test_x", "a.py::B::test_x"], ["b.py::A::test_x", "b.py::B::test_x"]),
      pairs(["a.py::A::test_x"], ["b.py::B::test_x"]),
      pairs(["a.py::test_x", "a.py::test_y"], ["a.py::test_y", "b.py::test_x"]),
      // A retried test is written twice: still one test.
      pairs(["a.py::test_x", "a.py::test_x"], ["b.py::test_x", "b.py::test_x"]),
    ]).toEqual([["a.py -> b.py (2 tests)"], [], [], ["a.py -> b.py (1 test)"]]);
  });
});

/** Just enough of a scenario for pairing tests: its id, and a test span at its root. */
function scenarioNamed(nodeid: string) {
  const symbol = new CodeSymbol([nodeid.split("::")[0]!], [], nodeid.split("::").at(-1)!, SymbolKind.Function, null);
  const fn: FunctionInfo = { role: Role.Test, symbol, file: null, firstLine: 1, landmarkKind: null };
  return new Scenario(nodeid, Outcome.Passed, 0, [new Span(1, fn, null, null, Phase.Call, 0, 1)], [], [], []);
}
