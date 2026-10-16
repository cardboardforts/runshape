/**
 * One comparison, saved as a file: what every use case reads (docs/review-bundle.md). The
 * developer reviewing their own branch reads its Markdown before opening a PR; a lead's
 * morning page lists bundles for the PRs they're asked to review; a CI job posts the Markdown as
 * the PR comment and stores the JSON by commit for the team. So it's the stable contract:
 * versioned, made of what the views already compute, free of view options a reader can't see.
 */
import { describe, expect, test } from "vitest";

import { loadLatestRun, loadPreviousRun } from "@runshape/trace";
import { ZoneRules } from "@runshape/architecture";
import { buildReviewBundle, reviewBundleMarkdown } from "../src/review-bundle";
import { fixtureFiles } from "../../trace/test/fixtures";

const CREATED = "2026-10-16T09:00:00Z";
const side = (asked: string, recording: string) => ({ asked, recording, commit: "0123456789abcdef0123456789abcdef01234567", subject: `the ${asked} commit` });

describe("buildReviewBundle", () => {
  test("a refactor: the tests that now run differently, the routes they changed, and an architecture nobody touched", async () => {
    const files = fixtureFiles("fastapi-slug-refactor");
    const base = (await loadPreviousRun(files))!;
    const head = await loadLatestRun(files);

    const bundle = buildReviewBundle({ base, head, baseSide: side("main", "aaaaaaaaaaaa"), headSide: side("working", "working"), baseRules: ZoneRules.none(), rules: ZoneRules.none(), createdAt: CREATED });

    expect({
      format: bundle.format,
      version: bundle.version,
      sides: `${bundle.base.asked} ${bundle.base.recording} -> ${bundle.head.asked} ${bundle.head.recording}`,
      baseRulesKnown: bundle.baseRulesKnown,
      silentChanges: bundle.review.counts["silent-change"],
      changedRoutes: bundle.routes.routes.filter((route) => route.change !== "unchanged").map((route) => route.label),
      decided: bundle.architecture.decided.length,
    }).toEqual({
      format: "runshape-review",
      version: 1,
      sides: "main aaaaaaaaaaaa -> working working",
      baseRulesKnown: true,
      silentChanges: 2,
      changedRoutes: ["POST /api/articles"],
      decided: 0,
    });
    expect(reviewBundleMarkdown(bundle)).toMatchInlineSnapshot(`
      "## Behaviour changes (Runshape)

      4 tests recorded on the base and on this branch.

      **2 tests still pass but now run differently** — the changes a green CI won't show you.

      ### Still passing, but now run differently (2)

      | Test | What changed |
      |---|---|
      | \`test_user_can_not_create_article_with_duplicated_slug\` | now calls \`ensure_slug_available\`, \`_normalize_title\`; 17 calls moved under a new caller; different lines run in \`create_new_article\`, \`get_slug_for_article\` |
      | \`test_user_can_create_article\` | now calls \`ensure_slug_available\`, \`_normalize_title\`; 4 calls moved under a new caller; different lines run in \`create_new_article\`, \`get_slug_for_article\` |

      2 tests behave exactly as before.

      Compared \`main\` (\`0123456\` the main commit) with the working tree (on \`0123456\`).

      ### Architecture

      No architecture changes.

      ### Routes

      - \`POST /api/articles\`: 2 ways changed
        - now calls \`ensure_slug_available\`, \`_normalize_title\`
        - now calls \`ensure_slug_available\`, \`_normalize_title\`
      "
    `);
  });

  test("a branch that adds a zone rule: the Markdown says what was decided, by whom, and what it moved", async () => {
    const run = await loadLatestRun(fixtureFiles("go-shop"));
    const rules = ZoneRules.parse(
      JSON.stringify({ version: 2, style: "hexagonal", zones: [{ match: "example\\.com.shop.internal.storage.**", zone: "outbound-adapter", reason: "stores orders", by: "llm" }] }),
    );

    const bundle = buildReviewBundle({ base: run, head: run, baseSide: side("main", "bbbbbbbbbbbb"), headSide: side("feature", "cccccccccccc"), baseRules: ZoneRules.none(), rules, createdAt: CREATED });

    const markdown = reviewBundleMarkdown(bundle);
    expect(markdown.slice(markdown.indexOf("### Architecture"))).toMatchInlineSnapshot(`
      "### Architecture

      Decided in this change:

      - Rule added: \`example\\.com.shop.internal.storage.**\` → Outbound adapters (a model): stores orders
      - \`example\\.com.shop.internal.storage\`: Core (inferred) → Outbound adapters (a model)
      - \`example\\.com.shop.internal.storage.MemoryRepository\`: Core (inferred) → Outbound adapters (a model)
      "
    `);
  });

  test("when the base's rules aren't known, the bundle and its Markdown say both sides used head's", async () => {
    const run = await loadLatestRun(fixtureFiles("go-shop"));

    const bundle = buildReviewBundle({ base: run, head: run, baseSide: side("main", "bbbbbbbbbbbb"), headSide: side("working", "working"), baseRules: null, rules: ZoneRules.none(), createdAt: CREATED });

    expect({ known: bundle.baseRulesKnown, said: reviewBundleMarkdown(bundle).includes("drawn with the current runshape.json") }).toEqual({ known: false, said: true });
  });
});
