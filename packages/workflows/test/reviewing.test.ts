/**
 * Reviewing a saved comparison: the PR page turned into things to check off and comment on,
 * the draft kept beside the review, and the finished review sent through a comment sink (a PR
 * on GitHub, a revision request for a local agent: adapters, faked here by one that keeps what
 * it's given). The workflow does the loading and saving; the review module does the rest.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { ZoneRules } from "@runshape/architecture";
import { CommentSink, FinishedReview, KeptReviewDrafts, LogFields, Logger, LogLevel, ReviewDraft, ReviewPage, ReviewVerdict } from "@runshape/kernel";
import { buildReviewBundle } from "../src/review-bundle";
import { buildReviewPage } from "../src/review-page";
import { Reviewing } from "../src/reviewing";
import { fixtureRuns } from "../../kernel/test/fixtures";

/** The review module's own tests read this page; it's the slug refactor's, as compare makes it. */
const PAGE_FIXTURE = join(import.meta.dirname, "..", "..", "review", "test", "fixtures", "fastapi-slug-refactor.page.json");
const NAME = "aaaaaaaaaaaa..bbbbbbbbbbbb";

async function slugRefactorPage(): Promise<ReviewPage> {
  const runs = fixtureRuns("fastapi-slug-refactor");
  const side = (asked: string, recording: string, commit: string) => ({ asked, recording, commit, subject: `the ${asked} commit`, dirty: false, forkOf: null });
  const bundle = buildReviewBundle({
    base: (await runs.previous())!,
    head: await runs.latest(),
    baseSide: side("main", "aaaaaaaaaaaa", "1111111111111111111111111111111111111111"),
    headSide: side("slugs", "bbbbbbbbbbbb", "2222222222222222222222222222222222222222"),
    baseRules: ZoneRules.none(),
    rules: ZoneRules.none(),
    createdAt: "2026-10-16T09:00:00Z",
  });
  return buildReviewPage(bundle);
}

class MemoryDrafts implements KeptReviewDrafts {
  readonly drafts = new Map<string, ReviewDraft>();
  constructor(private readonly pages: Map<string, ReviewPage>) {}
  async page(name: string) {
    return this.pages.get(name) ?? null;
  }
  async draft(name: string) {
    return this.drafts.get(name) ?? null;
  }
  async saveDraft(name: string, draft: ReviewDraft) {
    this.drafts.set(name, draft);
  }
}

class KeepingSink implements CommentSink {
  readonly name = "a sink that keeps what it's given";
  readonly delivered: FinishedReview[] = [];
  preview(review: FinishedReview) {
    return { where: "memory", text: `${review.verdict}: ${review.comments.map((comment) => comment.body).join(" / ")}` };
  }
  async deliver(review: FinishedReview) {
    this.delivered.push(review);
    return { where: "memory", comments: review.comments.length };
  }
}

class KeepingLogger implements Logger {
  readonly lines: string[] = [];
  log(level: LogLevel, event: string, fields: LogFields = {}) {
    this.lines.push(`${level} ${event} ${JSON.stringify(fields)}`);
  }
  with(): Logger {
    return this;
  }
}

describe("Reviewing", () => {
  test("the review module's page fixture is the slug refactor's page as compare makes it today", async () => {
    const page = `${JSON.stringify(await slugRefactorPage(), null, 2)}\n`;
    // RUNSHAPE_WRITE_FIXTURES=1 rewrites it after a deliberate change to the page.
    if (process.env.RUNSHAPE_WRITE_FIXTURES === "1" || !existsSync(PAGE_FIXTURE)) writeFileSync(PAGE_FIXTURE, page);
    expect(readFileSync(PAGE_FIXTURE, "utf8")).toBe(page);
  });

  test("check off, comment, then send: a preview first, delivery only when asked, the draft kept throughout", async () => {
    const drafts = new MemoryDrafts(new Map([[NAME, await slugRefactorPage()]]));
    const logger = new KeepingLogger();
    const reviewing = new Reviewing(drafts, logger, () => new Date("2026-10-31T10:00:00Z"));

    const opened = await reviewing.open(NAME);
    // What there is to look at: each thread, each changed function in it, each test that changed.
    expect(opened.progress.map((entry) => `${entry.item.key} [${entry.state}]`)).toMatchInlineSnapshot(`
      [
        "thread:app.services.articles._normalize_title [to-review]",
        "function:app.services.articles._normalize_title [to-review]",
        "function:app.services.articles.ensure_slug_available [to-review]",
        "thread:app.api.routes.articles.articles_resource.create_new_article [to-review]",
        "function:app.api.routes.articles.articles_resource.create_new_article [to-review]",
        "function:app.services.articles.get_slug_for_article [to-review]",
        "test:tests/test_api/test_routes/test_articles.py::test_user_can_not_create_article_with_duplicated_slug [to-review]",
        "test:tests/test_api/test_routes/test_articles.py::test_user_can_create_article [to-review]",
      ]
    `);

    expect(await reviewing.check(NAME, ["1", "function:app.services.articles._normalize_title", "nonsense"])).toEqual({ errors: ["nothing in this review is called nonsense: `review <name>` lists what is"] });
    expect(await reviewing.comment(NAME, "2", "Why does the normaliser lower-case before slugging?")).toEqual({ errors: [] });
    expect(await reviewing.comment(NAME, "change", "   ")).toEqual({ errors: ["a comment needs some text"] });

    const sink = new KeepingSink();
    const preview = await reviewing.send(NAME, sink, ReviewVerdict.RequestChanges, { confirmed: false });
    const sent = await reviewing.send(NAME, sink, ReviewVerdict.RequestChanges, { confirmed: true });

    expect({ preview, sent, delivered: sink.delivered.map((review) => `${review.verdict}: ${review.comments.length} comment`), draft: drafts.drafts.get(NAME), log: logger.lines }).toMatchInlineSnapshot(`
      {
        "delivered": [
          "request-changes: 1 comment",
        ],
        "draft": {
          "change": {
            "base": {
              "commit": "1111111111111111111111111111111111111111",
              "recording": "aaaaaaaaaaaa",
            },
            "head": {
              "asked": "slugs",
              "commit": "2222222222222222222222222222222222222222",
              "recording": "bbbbbbbbbbbb",
              "subject": "the slugs commit",
            },
            "pullRequest": null,
            "review": "aaaaaaaaaaaa..bbbbbbbbbbbb",
          },
          "checked": [
            {
              "fingerprint": "1d9b23d7effec5",
              "key": "thread:app.services.articles._normalize_title",
            },
            {
              "fingerprint": "1d383ebc08e9e0",
              "key": "function:app.services.articles._normalize_title",
            },
          ],
          "comments": [
            {
              "at": "2026-10-31T10:00:00.000Z",
              "body": "Why does the normaliser lower-case before slugging?",
              "key": "function:app.services.articles._normalize_title",
              "target": {
                "function": {
                  "name": "_normalize_title",
                  "namespace": "app.services.articles",
                },
                "kind": "function",
              },
            },
          ],
          "format": "runshape-review-draft",
          "version": 1,
        },
        "log": [
          "info review.previewed {"review":"aaaaaaaaaaaa..bbbbbbbbbbbb","sink":"a sink that keeps what it's given","verdict":"request-changes","comments":1,"where":"memory"}",
          "info review.sent {"review":"aaaaaaaaaaaa..bbbbbbbbbbbb","sink":"a sink that keeps what it's given","verdict":"request-changes","comments":1,"where":"memory"}",
        ],
        "preview": {
          "preview": {
            "text": "request-changes: Why does the normaliser lower-case before slugging?",
            "where": "memory",
          },
          "sink": "a sink that keeps what it's given",
        },
        "sent": {
          "delivered": {
            "comments": 1,
            "where": "memory",
          },
          "sink": "a sink that keeps what it's given",
        },
      }
    `);
  });

  test("a review that isn't there, or has nothing to send, is refused with the reason, and nothing is sent", async () => {
    const drafts = new MemoryDrafts(new Map([[NAME, await slugRefactorPage()]]));
    const reviewing = new Reviewing(drafts, new KeepingLogger(), () => new Date("2026-10-31T10:00:00Z"));
    const sink = new KeepingSink();

    await expect(reviewing.open("cccccccccccc..working")).rejects.toThrow("no review cccccccccccc..working: `compare` makes one");
    expect(await reviewing.send(NAME, sink, ReviewVerdict.Comment, { confirmed: true })).toEqual({ errors: ["no comments to send: leave one with `review <name> comment <what> <text>`"] });
    expect(sink.delivered).toEqual([]);
  });
});
