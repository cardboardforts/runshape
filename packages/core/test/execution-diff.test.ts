/**
 * Execution diff on a real refactor of the FastAPI example (fixtures/fastapi-slug-refactor),
 * the kind of change an AI agent makes: the route's slug check is extracted into a new
 * service function `ensure_slug_available`, a class is added above `check_article_exists`
 * (shifting every line below it), and `get_slug_for_article` moves to the end of the file and
 * gains a `_normalize_title` helper. Compared by what ran, not by line numbers.
 */
import { describe, expect, test } from "vitest";

import { Op } from "../src/align";
import { Run } from "../src/model";
import { loadLatestRun, loadPreviousRun } from "../src/trace/load";
import { pythonSymbol } from "../src/trace/parse";
import { diffExecution, diffFunctionExecution, FunctionExecutionDiff, mergeReplays } from "../src/views/execution-diff";
import { diffRuns } from "../src/views/run-diff";
import { fixtureFiles } from "./fixtures";

const CREATE = "tests/test_api/test_routes/test_articles.py::test_user_can_create_article";

async function loadRefactor(): Promise<{ before: Run; after: Run }> {
  const files = fixtureFiles("fastapi-slug-refactor");
  return { before: (await loadPreviousRun(files))!, after: await loadLatestRun(files) };
}

const mark = { [Op.Same]: " ", [Op.Added]: "+", [Op.Removed]: "-" };

function describeStatements(diff: FunctionExecutionDiff): string[] {
  return diff.statements.map((s) => `${mark[s.op]} ${String(s.beforeLine ?? "").padStart(3)} ${String(s.afterLine ?? "").padStart(3)}  ${s.text}`);
}

describe("diffExecution", () => {
  test("the extracted service shows as a new parent; the calls under it are otherwise the same", async () => {
    const { before, after } = await loadRefactor();

    const diff = diffExecution(before.scenario(CREATE)!, after.scenario(CREATE)!);

    // ↪ marks a call that still happens, under a new caller; only _normalize_title and
    // ensure_slug_available are genuinely new.
    expect(
      diff.calls
        .filter((call) => call.op !== Op.Same)
        .map((call) => `${mark[call.op]}${call.reparented ? "↪" : " "} ${"  ".repeat(call.depth)}${call.qualname}`),
    )
      .toMatchInlineSnapshot(`
        [
          "-↪     get_slug_for_article",
          "-↪     check_article_exists",
          "-↪       ArticlesRepository.get_article_by_slug",
          "-↪         BaseRepository.connection",
          "+      ensure_slug_available",
          "+↪       get_slug_for_article",
          "+          _normalize_title",
          "+↪       check_article_exists",
          "+↪         ArticlesRepository.get_article_by_slug",
          "+↪           BaseRepository.connection",
        ]
      `);
  });
});

describe("diffFunctionExecution", () => {
  test("the route now delegates: its old check is gone and the new call takes its place", async () => {
    const { before, after } = await loadRefactor();

    const diff = diffFunctionExecution(before, after, CREATE, pythonSymbol("app.api.routes.articles.articles_resource", "create_new_article"));

    expect(describeStatements(diff)).toMatchInlineSnapshot(`
      [
        "-  64      slug = get_slug_for_article(article_create.title)",
        "-  65      if await check_article_exists(articles_repo, slug):",
        "+      69  try:",
        "+      70  slug = await ensure_slug_available(articles_repo, article_create.title)",
        "   71  77  article = await articles_repo.create_article(",
        "   72  78  slug=slug,",
        "   73  79  title=article_create.title,",
        "   74  80  description=article_create.description,",
        "   75  81  body=article_create.body,",
        "   76  82  author=user,",
        "   77  83  tags=article_create.tags,",
        "   71  77  article = await articles_repo.create_article(",
        "   79  85  return ArticleInResponse(article=ArticleForResponse.from_orm(article))",
      ]
    `);
  });

  test("a function that only moved matches line for line by text, though every line number changed", async () => {
    const { before, after } = await loadRefactor();

    const byText = diffFunctionExecution(before, after, CREATE, pythonSymbol("app.services.articles", "check_article_exists"));
    const withoutSources = Object.assign(Object.create(Object.getPrototypeOf(before)), before, { sources: null });
    const byLineNumber = diffFunctionExecution(withoutSources, after, CREATE, pythonSymbol("app.services.articles", "check_article_exists"));

    expect(byText.matchedBy).toBe("text");
    expect(describeStatements(byText)).toMatchInlineSnapshot(`
      [
        "   10  14  try:",
        "   11  15  await articles_repo.get_article_by_slug(slug=slug)",
        "   12  16  except EntityDoesNotExist:",
        "   13  17  return False",
      ]
    `);
    // Without recorded source, only line numbers are left to match on, and the move looks
    // like a rewrite. Older recordings degrade to this, and say so.
    expect(byLineNumber.matchedBy).toBe("line-number");
    expect(byLineNumber.statements.every((s) => s.op !== Op.Same)).toBe(true);
  });
});

describe("mergeReplays", () => {
  test("between components the refactor barely registers: the route calls the service module once instead of twice", async () => {
    const { before, after } = await loadRefactor();

    // The architecture didn't change, so the component-level replay hardly does: the two
    // calls into app.services.articles became one, and the rest happens inside that module.
    const merged = mergeReplays(before.scenario(CREATE)!, after.scenario(CREATE)!, undefined, { collapseMiddleware: true });

    const short = (id: string) => id.split(/[.:]/).pop();
    expect(merged.filter((m) => m.op !== Op.Same).map((m) => `${mark[m.op]} ${m.step.kind} ${short(m.step.from)} -> ${short(m.step.to)}`))
      .toMatchInlineSnapshot(`
        [
          "- return articles -> articles_resource",
          "- call articles_resource -> articles",
        ]
      `);
  });
});

describe("diffRuns on the same refactor", () => {
  test("lines-reached compares statements by text too, so the moved function isn't listed", async () => {
    const { before, after } = await loadRefactor();

    const changed = diffRuns(before, after).scenarios.find((s) => s.id === CREATE)!.functionsChanged;

    // check_article_exists moved down four lines and is absent; get_slug_for_article's one
    // statement really did change (it now normalises the title first).
    expect(changed.map((fn) => `${fn.qualname}: +${fn.linesNowReached.length} −${fn.linesNoLongerReached.length}`)).toMatchInlineSnapshot(`
      [
        "create_new_article: +2 −2",
        "_normalize_title: +1 −0",
        "ensure_slug_available: +3 −0",
        "get_slug_for_article: +1 −1",
      ]
    `);
  });
});

describe("diffRuns: identical lines", () => {
  test("switching from one `return None` to another identical one later in the function is a change", async () => {
    const { before, after } = await loadRefactor();
    // Rewrite the recordings' source of one function so it holds two identical lines, and
    // make "before" reach the first and "after" the second.
    const file = "app/services/articles.py";
    const withTwins = (run: Run, reached: number): Run => {
      const lines = [...(run.sources!.get(file) ?? [])];
      const fn = run.catalog.find((f) => f.file === file && f.symbol.dottedPath === "check_article_exists")!;
      lines[fn.firstLine] = "    return None";
      lines[fn.firstLine + 2] = "    return None";
      const sources = new Map(run.sources!);
      sources.set(file, lines);
      const copy = Object.assign(Object.create(Object.getPrototypeOf(run)), run, { sources });
      for (const span of copy.scenario(CREATE)!.spans) {
        if (span.fn.symbol.dottedPath === "check_article_exists") span.lines.splice(0, span.lines.length, fn.firstLine + 1 + reached);
      }
      return copy;
    };

    const changed = diffRuns(withTwins(before, 0), withTwins(after, 2)).scenarios.find((s) => s.id === CREATE)!.functionsChanged;

    expect(changed.find((fn) => fn.qualname === "check_article_exists")).toBeDefined();
  });
});
