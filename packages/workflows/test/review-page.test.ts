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
    expect({ ...page, sections: page.sections.map((section) => ({ ...section, rows: section.rows.map((row) => ({ ...row, changes: row.changes.length })) })) }).toEqual({
      format: "runshape-review-page",
      version: 1,
      base: { asked: "main", recording: "aaaaaaaaaaaa", commit: "0123456789abcdef0123456789abcdef01234567", subject: "the main commit" },
      head: { asked: "#7 Slugs", recording: "bbbbbbbbbbbb", commit: "0123456789abcdef0123456789abcdef01234567", subject: "the #7 Slugs commit" },
      headline: "4 tests ran on both the base and this branch.",
      callouts: [
        { text: "2 still passing, run differently", tone: "warn" },
        { text: "1 route takes a new way", tone: "info" },
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
    });
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
