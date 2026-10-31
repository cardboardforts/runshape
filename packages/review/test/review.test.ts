/**
 * The review module: a PR page (the slug refactor's, as compare makes it: see the workflows'
 * reviewing test, which keeps the fixture honest) turned into things to check off and comment
 * on. A reviewer works down the list: each thread (changed functions with the same tests
 * through them), the functions in it with the tests through each (the beams to follow), then
 * each test whose behaviour changed. What they check off is kept with what it looked like, so
 * comparing again (the working tree after a fix, say) un-checks only what now looks different.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { ReviewPage, ReviewVerdict } from "@runshape/kernel";
import { addComment, checkOff, draftFor, finishReview, MAX_COMMENT_LENGTH, progress, reviewables, startDraft, unpinnedComments } from "../src";

const PAGE: ReviewPage = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "fastapi-slug-refactor.page.json"), "utf8"));
const NAME = "aaaaaaaaaaaa..bbbbbbbbbbbb";
const AT = new Date("2026-10-31T10:00:00Z");

describe("reviewables", () => {
  test("each thread, its functions with the tests through them, then each changed test: labelled, numbered from 1", () => {
    const items = reviewables(PAGE);

    expect(items.map((item, index) => `${index + 1}. ${item.kind}: ${item.label}; beams: ${item.beams.map((beam) => `${beam.kind} ${beam.tests.map((t) => t.name).join(", ")}`).join(" | ") || "-"}`)).toMatchInlineSnapshot(`
      [
        "1. thread: through app.services.articles._normalize_title, app.services.articles.ensure_slug_available; beams: new test_user_can_create_article, test_user_can_not_create_article_with_duplicated_slug",
        "2. function: app.services.articles._normalize_title (added); beams: new test_user_can_create_article, test_user_can_not_create_article_with_duplicated_slug",
        "3. function: app.services.articles.ensure_slug_available (added); beams: new test_user_can_create_article, test_user_can_not_create_article_with_duplicated_slug",
        "4. thread: through app.api.routes.articles.articles_resource.create_new_article, app.services.articles.get_slug_for_article; beams: different test_user_can_create_article, test_user_can_not_create_article_with_duplicated_slug",
        "5. function: app.api.routes.articles.articles_resource.create_new_article (edited); beams: different test_user_can_create_article, test_user_can_not_create_article_with_duplicated_slug",
        "6. function: app.services.articles.get_slug_for_article (edited); beams: different test_user_can_create_article, test_user_can_not_create_article_with_duplicated_slug",
        "7. test: test_user_can_not_create_article_with_duplicated_slug (still passing, but now run differently); beams: -",
        "8. test: test_user_can_create_article (still passing, but now run differently); beams: -",
      ]
    `);
  });

  test("an empty page (the change behaves as before) has nothing to check off", () => {
    expect(reviewables({ ...PAGE, threads: [], sections: [] })).toEqual([]);
  });
});

describe("a draft", () => {
  test("comparing again un-checks only what now looks different; comments on what's gone stay, unpinned", () => {
    const items = reviewables(PAGE);
    let draft = checkOff(startDraft(NAME, PAGE), items, ["1", "2", "3", "7"]).draft;
    draft = addComment(draft, items, "test:tests/test_api/test_routes/test_articles.py::test_user_can_create_article", "Add a case for a title that's all punctuation.", AT).draft;
    draft = addComment(draft, items, "change", "Nice and small.", AT).draft;

    // The fix: the second thread's tests now also run the normaliser, so the first thread's
    // workflows change, and the create test is no longer a change at all.
    const [first, second] = PAGE.threads;
    const again: ReviewPage = {
      ...PAGE,
      threads: [{ ...first!, workflows: [...first!.workflows, { kind: "same", tests: [{ id: "t", name: "test_list_articles", inHead: true }] }] }, second!],
      sections: PAGE.sections.map((section) => ({ ...section, rows: section.rows.map((row) => ({ ...row, tests: row.tests.filter((t) => t.name !== "test_user_can_create_article") })) })),
    };
    const after = reviewables(again);
    const redrafted = draftFor(NAME, again, draft);

    expect({
      progress: progress(redrafted, after).map((entry) => `${entry.item.key} [${entry.state}] ${entry.comments.map((c) => c.body).join(" ")}`),
      unpinned: unpinnedComments(redrafted, after).map((comment) => `${comment.key}: ${comment.body}`),
    }).toMatchInlineSnapshot(`
      {
        "progress": [
          "thread:app.services.articles._normalize_title [changed-since-checked] ",
          "function:app.services.articles._normalize_title [changed-since-checked] ",
          "function:app.services.articles.ensure_slug_available [changed-since-checked] ",
          "thread:app.api.routes.articles.articles_resource.create_new_article [to-review] ",
          "function:app.api.routes.articles.articles_resource.create_new_article [to-review] ",
          "function:app.services.articles.get_slug_for_article [to-review] ",
          "test:tests/test_api/test_routes/test_articles.py::test_user_can_not_create_article_with_duplicated_slug [checked] ",
        ],
        "unpinned": [
          "test:tests/test_api/test_routes/test_articles.py::test_user_can_create_article: Add a case for a title that's all punctuation.",
          "change: Nice and small.",
        ],
      }
    `);
  });

  test("every refusal is said at once, and the rest of the edit still applies", () => {
    const items = reviewables(PAGE);
    const draft = startDraft(NAME, PAGE);

    const checked = checkOff(draft, items, ["change", "99", "2", "function:nowhere"]);
    const tooLong = addComment(draft, items, "nowhere", "x".repeat(MAX_COMMENT_LENGTH + 1), AT);

    expect({ checked: checked.draft.checked.map((entry) => entry.key), errors: checked.errors, tooLong: tooLong.errors, unchanged: tooLong.draft === draft }).toEqual({
      checked: ["function:app.services.articles._normalize_title"],
      errors: [
        "the change as a whole isn't checked off: send it with --approve",
        "nothing in this review is called 99: `review <name>` lists what is",
        "nothing in this review is called function:nowhere: `review <name>` lists what is",
      ],
      tooLong: ["nothing in this review is called nowhere: `review <name>` lists what is", `a comment is at most ${MAX_COMMENT_LENGTH} characters; this one is ${MAX_COMMENT_LENGTH + 1}`],
      unchanged: true,
    });
  });

  test("approving needs no comment; commenting or asking for changes does", () => {
    const draft = startDraft(NAME, PAGE);

    expect({
      approve: finishReview(draft, ReviewVerdict.Approve).review?.verdict,
      requestChanges: finishReview(draft, ReviewVerdict.RequestChanges),
    }).toEqual({
      approve: ReviewVerdict.Approve,
      requestChanges: { review: null, errors: ["no comments to send: leave one with `review <name> comment <what> <text>`"] },
    });
  });
});
