/**
 * Reviewing a change by behaviour, on the two real before/after fixtures. The output is the
 * Markdown a PR comment would carry, so the snapshots read as the review itself.
 */
import { describe, expect, test } from "vitest";

import { reviewOf } from "./graphs";

import { Change, Outcome, ReviewCategory } from "@runshape/kernel";
import { reviewCategoryOf, reviewMarkdown } from "../src";
import { FixtureApp, fixtureRuns } from "../../kernel/test/fixtures";

async function review(app: FixtureApp) {
  const runs = fixtureRuns(app);
  return reviewOf((await runs.previous())!, await runs.latest());
}

describe("buildReview", () => {
  test("a pure refactor: every test still green, two of them now run differently", async () => {
    const summary = await review("fastapi-slug-refactor");

    expect(summary.counts[ReviewCategory.SilentChange]).toBe(2);
    expect(reviewMarkdown(summary)).toMatchInlineSnapshot(`
      "## Behaviour changes (Runshape)

      4 tests ran on both the base and this branch.

      **2 tests still pass but now run differently** — the changes a green CI won't show you.

      ### Still passing, but now run differently (2)

      | Test | What changed |
      |---|---|
      | \`test_user_can_not_create_article_with_duplicated_slug\` | now calls \`ensure_slug_available\`, \`_normalize_title\`; 17 calls moved under a new caller; different lines run in \`create_new_article\`, \`get_slug_for_article\` |
      | \`test_user_can_create_article\` | now calls \`ensure_slug_available\`, \`_normalize_title\`; 4 calls moved under a new caller; different lines run in \`create_new_article\`, \`get_slug_for_article\` |

      2 tests behave exactly as before.
      "
    `);
  });

  test("a bug fix: the known-broken journey now passes, and nothing else moved", async () => {
    const summary = await review("django-feed-fix");

    expect(reviewMarkdown(summary)).toMatchInlineSnapshot(`
      "## Behaviour changes (Runshape)

      8 tests ran on both the base and this branch.

      ### Now passing (1)

      | Test | What changed |
      |---|---|
      | \`test_follower_sees_followed_authors_in_their_feed\` | xfailed → passed; now calls \`ArticlesFeedAPIView.list\`, \`ArticlesFeedAPIView.get_queryset\`, \`ProfileSerializer.get_image\`, \`ProfileSerializer.get_following\`, \`Profile.is_following\` and 6 more; no longer calls \`ArticleViewSet.retrieve\`, \`core_exception_handler\`, \`_handle_not_found_error\`; +9 external calls; −1 external call; different lines run in \`ConduitJSONRenderer.render\` |

      7 tests behave exactly as before.
      "
    `);
  });
});

describe("reviewCategoryOf", () => {
  // Each heading makes a claim ("still passing", "now passing"); a test lands under one only
  // when that claim is true of it. Read as: execution change, outcome before → after.
  test("every outcome transition lands under a heading that is true of it", () => {
    const P = Outcome.Passed, F = Outcome.Failed, S = Outcome.Skipped, X = Outcome.ExpectedFailure;
    const cases: [Change, Outcome | null, Outcome | null][] = [
      [Change.Changed, P, P],
      [Change.Unchanged, P, P],
      [Change.Changed, P, F],
      [Change.Changed, P, X],
      [Change.Changed, F, P],
      [Change.Changed, X, P],
      [Change.Changed, P, S],
      [Change.Changed, F, S],
      [Change.Changed, S, P],
      [Change.Changed, F, F],
      [Change.Changed, F, X],
      [Change.Added, null, P],
      [Change.Added, null, F],
      [Change.Added, null, X],
      [Change.Removed, P, null],
    ];
    expect(cases.map(([change, before, after]) => `${change.padEnd(9)} ${before ?? "—"} → ${after ?? "—"}: ${reviewCategoryOf(change, before, after)}`)).toMatchInlineSnapshot(`
      [
        "changed   passed → passed: silent-change",
        "unchanged passed → passed: unchanged",
        "changed   passed → failed: now-failing",
        "changed   passed → xfailed: now-failing",
        "changed   failed → passed: now-passing",
        "changed   xfailed → passed: now-passing",
        "changed   passed → skipped: now-skipped",
        "changed   failed → skipped: now-skipped",
        "changed   skipped → passed: now-passing",
        "changed   failed → failed: still-failing",
        "changed   failed → xfailed: still-failing",
        "added     — → passed: added",
        "added     — → failed: now-failing",
        "added     — → xfailed: added",
        "removed   passed → —: removed",
      ]
    `);
  });
});

describe("a new test has no base to differ from", () => {
  test("so its lines aren't listed as 'different lines run': every line it ran is new", async () => {
    // Two different apps' tests: every head test is new. Listing "different lines run in …
    // and 128 more" for each said nothing and filled every PR comment.
    const base = await fixtureRuns("go-shop").latest();
    const head = await fixtureRuns("go-shop-running").latest();

    const added = reviewOf(base, head).items.filter((item) => item.outcomeBefore === null);

    expect({ added: added.length, listingLines: added.filter((item) => item.changedPaths.length > 0).map((item) => item.name) }).toEqual({ added: 7, listingLines: [] });
  });
});
