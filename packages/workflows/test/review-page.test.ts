/**
 * The PR page (page.json): one review as the reviewer opens it from the morning list. What to
 * look at first, the tests grouped by cause, and the threads to follow, each test with the id
 * the viewer opens it by. Worked out from the bundle so the UI only draws kernel types.
 */
import { describe, expect, test } from "vitest";

import { ZoneRules } from "@runshape/architecture";
import { buildReviewBundle } from "../src/review-bundle";
import { buildReviewPage } from "../src/review-page";
import { fixtureRuns } from "../../kernel/test/fixtures";

const side = (asked: string, recording: string) => ({ asked, recording, commit: "0123456789abcdef0123456789abcdef01234567", subject: `the ${asked} commit`, dirty: false, forkOf: null });

describe("buildReviewPage", () => {
  test("the slug refactor: two silent changes with one cause, two threads, and nothing else to look at", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");
    const bundle = buildReviewBundle({
      base: (await runs.previous())!,
      head: await runs.latest(),
      baseSide: side("main", "aaaaaaaaaaaa"),
      headSide: side("#7 Slugs", "bbbbbbbbbbbb"),
      baseRules: ZoneRules.none(),
      rules: ZoneRules.none(),
      createdAt: "2026-10-16T09:00:00Z",
    });

    const page = buildReviewPage(bundle);

    const CREATE = "tests/test_api/test_routes/test_articles.py::test_user_can_create_article";
    const DUPLICATE = "tests/test_api/test_routes/test_articles.py::test_user_can_not_create_article_with_duplicated_slug";
    // The cost is its own test below.
    const { cost, ...rest } = page;
    expect(cost).toBeDefined();
    // Each tag as "lens: text (by confidence)": the text says "no recorded effect", not "pure", at 0.4.
    const categories = rest.categories && { ...rest.categories, items: rest.categories.items.map((item) => ({ ...item, tags: item.tags.map((tag) => `${tag.lens}: ${tag.text} (${tag.by} ${tag.confidence})`) })) };
    expect({ ...rest, categories, sections: rest.sections.map((section) => ({ ...section, rows: section.rows.map((row) => ({ ...row, changes: row.changes.length })) })) }).toEqual({
      format: "runshape-review-page",
      version: 1,
      base: { asked: "main", recording: "aaaaaaaaaaaa", commit: "0123456789abcdef0123456789abcdef01234567", subject: "the main commit" },
      head: { asked: "#7 Slugs", recording: "bbbbbbbbbbbb", commit: "0123456789abcdef0123456789abcdef01234567", subject: "the #7 Slugs commit" },
      headline: "4 tests ran on both the base and this branch.",
      callouts: [
        { text: "2 still passing, run differently", tone: "warn" },
        { text: "1 route takes a new way", tone: "info" },
        // One recording each side: a database wait in unchanged code (see the trace module's cost test).
        { text: "1 workflow slower past the noise bands (one recording each side)", tone: "info" },
      ],
      moved: [],
      // One row for both tests: they changed through the same four functions, in two ways.
      sections: [
        {
          heading: "Still passing, but now run differently",
          rows: [
            {
              tests: [
                { id: DUPLICATE, name: "test_user_can_not_create_article_with_duplicated_slug", inHead: true },
                { id: CREATE, name: "test_user_can_create_article", inHead: true },
              ],
              cause: [
                { name: "_normalize_title", namespace: "app.services.articles", change: "added" },
                { name: "create_new_article", namespace: "app.api.routes.articles.articles_resource", change: "edited" },
                { name: "ensure_slug_available", namespace: "app.services.articles", change: "added" },
                { name: "get_slug_for_article", namespace: "app.services.articles", change: "edited" },
              ],
              changes: 2,
            },
          ],
        },
      ],
      threadsBasis: "source",
      threads: [
        {
          functions: [
            { name: "_normalize_title", namespace: "app.services.articles", change: "added" },
            { name: "ensure_slug_available", namespace: "app.services.articles", change: "added" },
          ],
          workflows: [{ kind: "new", tests: [{ id: CREATE, name: "test_user_can_create_article", inHead: true }, { id: DUPLICATE, name: "test_user_can_not_create_article_with_duplicated_slug", inHead: true }] }],
          routes: [{ label: "POST /api/articles", on: "head" }],
        },
        {
          functions: [
            { name: "create_new_article", namespace: "app.api.routes.articles.articles_resource", change: "edited" },
            { name: "get_slug_for_article", namespace: "app.services.articles", change: "edited" },
          ],
          workflows: [{ kind: "different", tests: [{ id: CREATE, name: "test_user_can_create_article", inHead: true }, { id: DUPLICATE, name: "test_user_can_not_create_article_with_duplicated_slug", inHead: true }] }],
          routes: [{ label: "POST /api/articles", on: "both" }],
        },
      ],
      // The changed functions as the categorizer sees them; no rules, so nothing to find and no new class to place.
      categories: {
        items: [
          {
            name: "app.api.routes.articles.articles_resource.create_new_article",
            kind: "callable",
            zone: "inbound-adapter",
            tags: ["ports-and-adapters: primary-adapter (detected 0.85)", "effect: reads-state (detected 0.95)", "effect: writes-state (detected 0.95)", "cqs: both (detected 0.7)", "failure: can-fail (detected 0.85)"],
          },
          { name: "app.services.articles._normalize_title", kind: "callable", zone: "core", tags: ["effect: no recorded effect (detected 0.4)", "cqs: query (detected 0.7)"] },
          { name: "app.services.articles.ensure_slug_available", kind: "callable", zone: "core", tags: ["effect: reads-state (detected 0.95)", "cqs: query (detected 0.7)", "failure: can-fail (detected 0.85)"] },
          { name: "app.services.articles.get_slug_for_article", kind: "callable", zone: "core", tags: ["effect: no recorded effect (detected 0.4)", "cqs: query (detected 0.7)"] },
        ],
        findings: [],
        proposals: [],
        omitted: { items: 0, findings: 0, proposals: 0 },
      },
    });
  });

  test("new architecture findings are a callout, red when a rule says error", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");
    const rules = ZoneRules.parse(
      JSON.stringify({
        version: 2,
        style: "hexagonal",
        zones: [{ match: "app.services.**", zone: "core", reason: "services", by: "user" }],
        taxonomy: { rules: [{ id: "services-compute-only", message: "a service helper that queries", match: "app.services.**", when: ["kind=callable"], flag: ["effect=reads-state"], severity: "error" }] },
      }),
    );
    const bundle = buildReviewBundle({ base: (await runs.previous())!, head: await runs.latest(), baseSide: side("main", "aaaaaaaaaaaa"), headSide: side("#7", "bbbbbbbbbbbb"), baseRules: rules, rules, createdAt: "2026-10-16T09:00:00Z" });

    const page = buildReviewPage(bundle);

    expect({ callouts: page.callouts, findings: page.categories?.findings }).toEqual({
      // Worst first: an error rule's finding leads, next to the cost callouts.
      callouts: [
        { text: "1 new architecture finding", tone: "failed" },
        { text: "2 still passing, run differently", tone: "warn" },
        { text: "1 route takes a new way", tone: "info" },
        { text: "1 workflow slower past the noise bands (one recording each side)", tone: "info" },
      ],
      findings: [
        {
          severity: "error",
          rule: "services-compute-only",
          item: "app.services.articles.ensure_slug_available",
          message: "a service helper that queries",
          evidence: [
            "reads-state: postgres: SELECT through app.db.repositories.articles.ArticlesRepository.get_article_by_slug; postgres: SELECT through app.db.repositories.articles.ArticlesRepository.get_favorites_count_for_article_by_slug; postgres: SELECT through app.db.repositories.articles.ArticlesRepository.get_tags_for_article_by_slug; postgres: SELECT through app.db.repositories.users.UsersRepository.get_user_by_username",
          ],
        },
      ],
    });
  });

  test("the cost, as the page draws it: the Django feed fix's route that pays, the workflows that changed, and its changed functions", async () => {
    const runs = fixtureRuns("django-feed-fix");
    const bundle = buildReviewBundle({ base: (await runs.previous())!, head: await runs.latest(), baseSide: side("main", "a"), headSide: side("head", "b"), baseRules: ZoneRules.none(), rules: ZoneRules.none(), createdAt: "2026-10-16T09:00:00Z" });

    const page = buildReviewPage(bundle);

    const count = ({ before, after }: { before: number | null; after: number | null }) => `${before}→${after}`;
    const time = (t: { beforeMs: number | null; afterMs: number | null; verdict?: string }) => `${t.beforeMs?.toFixed(1) ?? "—"}→${t.afterMs?.toFixed(1) ?? "—"}ms${t.verdict ? ` ${t.verdict}` : ""}`;
    const cost = page.cost!;
    expect({
      callouts: page.callouts.map((callout) => `${callout.tone}: ${callout.text}`),
      routes: cost.routes.map((route) => `${route.label} ${route.text} (${route.tests.map((t) => t.name).join(", ")})`),
      workflows: cost.workflows.map((w) => `${w.test.name}: ${time(w.time)} | calls ${count(w.calls)} | ext ${count(w.externalCalls)}`),
      unchanged: cost.unchanged,
      newWorkflows: cost.newWorkflows.map((w) => `${w.test.name}: calls ${w.calls}, ext ${w.externalCalls}`),
      goneWorkflows: cost.goneWorkflows.map((t) => t.name),
      functions: cost.functions.map((fn) => `${fn.function.name}: calls ${count(fn.calls)} | paths ${count(fn.paths)} | ext ${count(fn.externalCalls)} | per call ${time(fn.timePerCall)} (self ${time(fn.selfTimePerCall)})`),
    }).toMatchInlineSnapshot(`
      {
        "callouts": [
          "warn: 1 needs a zone decision",
          "warn: 2 new architecture findings",
          "warn: 1 workflow makes more external calls",
          "info: 2 routes take a new way",
        ],
        "functions": [
          "ConduitJSONRenderer.render: calls 24→24 | paths 3→2 | ext 0→0 | per call 0.0→0.0ms within-noise (self 0.0→0.0ms)",
          "core_exception_handler: calls 2→1 | paths 2→1 | ext 0→0 | per call 0.1→0.2ms within-noise (self 0.1→0.2ms)",
          "_handle_not_found_error: calls 1→0 | paths 1→0 | ext 0→0 | per call 0.0→—ms one-side (self 0.0→—ms)",
          "ArticlesFeedAPIView.get_queryset: calls 0→1 | paths 0→1 | ext 0→1 | per call —→0.9ms one-side (self —→0.9ms)",
          "ArticlesFeedAPIView.list: calls 0→1 | paths 0→1 | ext 0→9 | per call —→2.7ms one-side (self —→1.3ms)",
          "ArticleViewSet.retrieve: calls 1→0 | paths 1→0 | ext 1→0 | per call 0.8→—ms one-side (self 0.8→—ms)",
        ],
        "goneWorkflows": [],
        "newWorkflows": [],
        "routes": [
          "GET /api/articles/feed newly requested: makes 10 external calls (test_follower_sees_followed_authors_in_their_feed)",
          "GET /api/articles/{slug} no longer requested: it made 2 external calls (test_follower_sees_followed_authors_in_their_feed)",
        ],
        "unchanged": 6,
        "workflows": [
          "test_follower_sees_followed_authors_in_their_feed: 377.5→378.7ms within-noise | calls 51→58 | ext 28→36",
          "test_anonymous_visitor_cannot_publish: 2.2→4.5ms within-noise | calls 3→4 | ext 0→0",
        ],
      }
    `);
  });

  test("a new test's external calls are a callout and a list of their own, not 'the same' (second-model review)", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");
    const base = (await runs.previous())!;
    // As if this branch added the article-creating test: the base never ran it.
    (base as { scenarios: unknown }).scenarios = base.scenarios.filter((scenario) => scenario.name !== "test_user_can_create_article");
    const bundle = buildReviewBundle({ base, head: await runs.latest(), baseSide: side("main", "a"), headSide: side("head", "b"), baseRules: ZoneRules.none(), rules: ZoneRules.none(), createdAt: "2026-10-16T09:00:00Z" });

    const page = buildReviewPage(bundle);

    expect({
      callouts: page.callouts.filter((callout) => callout.text.includes("external")).map((callout) => `${callout.tone}: ${callout.text}`),
      newWorkflows: page.cost!.newWorkflows.map((w) => `${w.test.name}: ${w.externalCalls} external calls`),
      unchanged: page.cost!.unchanged,
    }).toMatchInlineSnapshot(`
      {
        "callouts": [
          "warn: 1 new workflow makes external calls",
        ],
        "newWorkflows": [
          "test_user_can_create_article: 10 external calls",
        ],
        "unchanged": 2,
      }
    `);
  });

  test("a test only the base has is named, not linked: head's graph has nothing to open it at (second-model review)", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");
    const head = await runs.latest();
    const dropped = head.scenarios[0]!;
    // As if head's branch had deleted that test.
    (head as { scenarios: unknown }).scenarios = head.scenarios.filter((scenario) => scenario.nodeid !== dropped.nodeid);
    const bundle = buildReviewBundle({ base: (await runs.previous())!, head, baseSide: side("main", "a"), headSide: side("head", "b"), baseRules: ZoneRules.none(), rules: ZoneRules.none(), createdAt: "2026-10-16T09:00:00Z" });

    const removed = buildReviewPage(bundle).sections.find((section) => section.heading === "Removed tests");

    expect(removed?.rows.flatMap((row) => row.tests)).toEqual([{ id: dropped.nodeid, name: dropped.name, inHead: false }]);
  });
});
