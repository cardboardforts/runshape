/**
 * Threads to follow (PLAN.md Phase 1): for each function a change touched, every workflow that
 * runs through it, on the base and on head. A reviewer works down the list function by
 * function: "these 2 workflows run through create_new_article, and both now run differently".
 *
 * A workflow is a recorded scenario: a test, or a request to a running program. "Same" ones are
 * listed too: still green and still the same is what the change has to keep.
 */
import { describe, expect, test } from "vitest";

import { Run, TraceDirectory } from "@runshape/kernel";
import { buildThreads, detectMoves, groupThreads, reviewRows, Threads } from "../src";
import { fixtureFiles, fixtureRuns } from "../../kernel/test/fixtures";
import { diffOf, reviewOf } from "./graphs";
import { rewritten } from "./rewrite";

/** One line per changed function: what changed, its threads (by kind) and routes (and on which side). */
function summary(threads: Threads): string[] {
  return threads.functions.map((fn) => {
    const kinds = fn.threads.map((thread) => thread.kind).join(" ");
    const routes = fn.routes.map((route) => `${route.label} (${route.on})`).join(", ");
    return `${fn.change}: ${fn.label} | ${kinds} | ${routes}`;
  });
}

function threadsOf(base: Run, head: Run): Threads {
  const moves = detectMoves(base, head);
  return buildThreads(base, head, diffOf(base, head, { moves }), { moves });
}

describe("buildThreads", () => {
  test("the slug refactor: four functions changed, and the two article-creating tests run through all of them", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");

    const threads = threadsOf((await runs.previous())!, await runs.latest());

    // Both recordings keep their source, so "changed" is the function's own text.
    expect(threads.basis).toBe("source");
    expect(summary(threads)).toEqual([
      "added: _normalize_title (app.services.articles) | new new | POST /api/articles (head)",
      "edited: create_new_article (app.api.routes.articles.articles_resource) | different different | POST /api/articles (both)",
      "added: ensure_slug_available (app.services.articles) | new new | POST /api/articles (head)",
      "edited: get_slug_for_article (app.services.articles) | different different | POST /api/articles (both)",
    ]);
    expect(threads.functions[1]!.threads.map((thread) => thread.name)).toEqual(["test_user_can_create_article", "test_user_can_not_create_article_with_duplicated_slug"]);
  });

  test("code that only moved isn't a change: a module renamed, its lines the same, leaves nothing to follow", async () => {
    const base = await new TraceDirectory(fixtureFiles("fastapi-slug-refactor")).latest();
    const head = await new TraceDirectory(rewritten(fixtureFiles("fastapi-slug-refactor"), { modules: { "app.services.articles": "app.domain.articles" } })).latest();

    expect(threadsOf(base, head).functions).toEqual([]);
  });

  test("a line edited in a moved module is a change, under its new name", async () => {
    const base = await new TraceDirectory(fixtureFiles("fastapi-slug-refactor")).latest();
    const file = base.catalog.find((fn) => fn.symbol.key.includes("get_slug_for_article"))!;
    const head = await new TraceDirectory(
      rewritten(fixtureFiles("fastapi-slug-refactor"), { modules: { "app.services.articles": "app.domain.articles" }, lines: { [file.file]: { [file.firstLine + 1]: "    # edited" } } }),
    ).latest();

    // Both tests that run it now run differently: they execute the edited line.
    expect(summary(threadsOf(base, head))).toEqual(["edited: get_slug_for_article (app.domain.articles) | different different | POST /api/articles (both)"]);
  });

  test("a function edited where nothing runs (a comment) is a change, but the workflows through it run as before", async () => {
    const base = await new TraceDirectory(fixtureFiles("fastapi-slug-refactor")).latest();
    const fn = base.catalog.find((candidate) => candidate.symbol.key.includes('"get_slug_for_article"'))!;
    // Its def line holds no statement that runs: a comment added there changes the text alone.
    const def = base.sourceLine(fn.file, fn.firstLine)!;
    const head = await new TraceDirectory(rewritten(fixtureFiles("fastapi-slug-refactor"), { lines: { [fn.file]: { [fn.firstLine]: `${def}  # reworded` } } })).latest();

    // "Different" is about this function: a workflow that changed only elsewhere isn't counted here.
    expect(summary(threadsOf(base, head))).toEqual(["edited: get_slug_for_article (app.services.articles) | same same | POST /api/articles (both)"]);
  });

  test("tests are the workflows, not code to follow: a test edited is no changed function", async () => {
    const base = await new TraceDirectory(fixtureFiles("fastapi-slug-refactor")).latest();
    const test = base.catalog.find((candidate) => candidate.symbol.key.includes('"test_user_can_create_article"'))!;
    const head = await new TraceDirectory(rewritten(fixtureFiles("fastapi-slug-refactor"), { lines: { [test.file]: { [test.firstLine + 1]: "    # reworded" } } })).latest();

    expect(threadsOf(base, head).functions).toEqual([]);
  });

  test("a file whose source wasn't kept: its functions count only when a workflow ran them differently", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");
    const [base, head] = [(await runs.previous())!, await runs.latest()];
    // As if the recorder hadn't kept app/services/articles.py on head (a file too big to keep, say).
    (head.sources as Map<string, string[]>).delete("app/services/articles.py");

    // check_article_exists wasn't edited, but its lines moved down the file: without the text,
    // a moved line reads as another line run. The same blind spot as recordings with no source.
    expect(summary(threadsOf(base, head)).filter((line) => line.includes("app.services.articles"))).toEqual([
      "added: _normalize_title (app.services.articles) | new new | POST /api/articles (head)",
      "ran differently: check_article_exists (app.services.articles) | different different | POST /api/articles (both)",
      "added: ensure_slug_available (app.services.articles) | new new | POST /api/articles (head)",
      "ran differently: get_slug_for_article (app.services.articles) | different different | POST /api/articles (both)",
    ]);
  });

  test("recordings without their source: changed means some workflow ran the function differently", async () => {
    const runs = fixtureRuns("django-feed-fix");

    const threads = threadsOf((await runs.previous())!, await runs.latest());

    // The routing fix: the feed is reached at last, and the 404 it used to hit is gone.
    expect(threads.basis).toBe("behaviour");
    expect(summary(threads).filter((line) => !line.includes("ConduitJSONRenderer"))).toEqual([
      "ran differently: core_exception_handler (conduit.apps.core.exceptions) | gone same | GET /api/articles/{slug} (base), POST /api/articles (both)",
      "ran differently: _handle_not_found_error (conduit.apps.core.exceptions) | gone | GET /api/articles/{slug} (base)",
      "ran differently: ArticlesFeedAPIView.get_queryset (conduit.apps.articles.views) | new | GET /api/articles/feed (head)",
      "ran differently: ArticlesFeedAPIView.list (conduit.apps.articles.views) | new | GET /api/articles/feed (head)",
      "ran differently: ArticleViewSet.retrieve (conduit.apps.articles.views) | gone | GET /api/articles/{slug} (base)",
    ]);
  });
});

describe("group by cause", () => {
  test("functions with the same workflows are one thread; tests through the same changed functions are one review row", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");
    const [base, head] = [(await runs.previous())!, await runs.latest()];
    const threads = threadsOf(base, head);

    const groups = groupThreads(threads).map((group) => `${group.functions.map((fn) => fn.symbol.path).join(", ")}: ${group.threads.map((t) => t.kind).join(" ")}`);
    const rows = reviewRows(reviewOf(base, head).items.filter((item) => item.category === "silent-change"), threads).map((row) => `${row.items.length} tests through ${row.cause.length} changed functions`);

    // The two added helpers share both tests, as do the two edited functions: two threads, not four.
    expect(groups).toEqual(["_normalize_title, ensure_slug_available: new new", "create_new_article, get_slug_for_article: different different"]);
    // Both tests that run differently do so through the same four functions: one row, not two.
    expect(rows).toEqual(["2 tests through 4 changed functions"]);
  });

  test("without threads every test is its own row, as before", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");
    const items = reviewOf((await runs.previous())!, await runs.latest()).items;

    expect(reviewRows(items).every((row) => row.items.length === 1 && row.cause.length === 0)).toBe(true);
  });
});
