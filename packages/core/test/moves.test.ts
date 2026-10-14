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
import { Phase } from "@runshape/trace";
import { buildReview, Change, detectMoves, diffExecution, diffRuns, mergeReplays, Op } from "@runshape/views";
import { fixtureFiles } from "./fixtures";

const FROM = "app.services.articles";
const TO = "app.domain.articles";
const CREATE = "tests/test_api/test_routes/test_articles.py::test_user_can_create_article";

/** The recording as if app/services/articles.py had been moved to app/domain/articles.py. */
function movedModule(files: TraceFiles, options: { keepSources: boolean } = { keepSources: true }): TraceFiles {
  const rename = (name: string) => (name === FROM || name.startsWith(`${FROM}.`) ? TO + name.slice(FROM.length) : name);
  const file = (path: string) => path.replace("app/services/articles.py", "app/domain/articles.py");
  return {
    async readText(path) {
      const data = JSON.parse(await files.readText(path));
      if (path.endsWith("manifest.json")) {
        for (const fn of data.catalog) Object.assign(fn, { module: rename(fn.module), file: file(fn.file) });
        if (options.keepSources) data.sources = Object.fromEntries(Object.entries(data.sources ?? {}).map(([path, lines]) => [file(path), lines]));
        else delete data.sources;
        for (const route of data.framework?.routes ?? []) route.handler = rename(route.handler);
      } else if (path.includes("/scenarios/")) {
        for (const fn of data.functions) Object.assign(fn, { module: rename(fn.module), file: fn.file && file(fn.file) });
        for (const event of data.events) if (event[0] === "O") event[3] = rename(event[3]);
      }
      return JSON.stringify(data);
    },
  };
}

async function baseAndMoved(options?: { keepSources: boolean }): Promise<{ base: Run; head: Run }> {
  const files = fixtureFiles("fastapi-slug-refactor");
  const base = await loadLatestRun(files);
  if (options?.keepSources === false) (base as { sources: unknown }).sources = null;
  return { base, head: await loadLatestRun(movedModule(files, options)) };
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
