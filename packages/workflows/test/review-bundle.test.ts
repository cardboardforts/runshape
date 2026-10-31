/**
 * One comparison, saved as a file: what every use case reads (docs/review-bundle.md). The
 * developer reviewing their own branch reads its Markdown before opening a PR; a lead's
 * morning page lists bundles for the PRs they're asked to review; a CI job posts the Markdown as
 * the PR comment and stores the JSON by commit for the team. So it's the stable contract:
 * versioned, made of what the views already compute, free of view options a reader can't see.
 */
import { describe, expect, test } from "vitest";

import { ZoneRules } from "@runshape/architecture";
import { buildReviewBundle, reviewBundleMarkdown } from "../src/review-bundle";
import { buildReviewPage } from "../src/review-page";
import { NoteKind, ReviewStory } from "../src/story";
import { fixtureRuns } from "../../kernel/test/fixtures";

const CREATED = "2026-10-16T09:00:00Z";
const side = (asked: string, recording: string) => ({ asked, recording, commit: "0123456789abcdef0123456789abcdef01234567", subject: `the ${asked} commit`, dirty: false, forkOf: null });

describe("buildReviewBundle", () => {
  test("a refactor: the tests that now run differently, the routes they changed, and an architecture nobody touched", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");
    const base = (await runs.previous())!;
    const head = await runs.latest();

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

      4 tests ran on both the base and this branch.

      **2 tests still pass but now run differently** — the changes a green CI won't show you.

      ### Still passing, but now run differently (2)

      | Test | What changed |
      |---|---|
      | 2 tests: \`test_user_can_not_create_article_with_duplicated_slug\`, \`test_user_can_create_article\` | through changed code: \`_normalize_title\` (added), \`create_new_article\` (edited), \`ensure_slug_available\` (added), \`get_slug_for_article\` (edited); 2 ways: now calls \`ensure_slug_available\`, \`_normalize_title\`; 17 calls moved under a new caller; different lines run in \`create_new_article\`, \`get_slug_for_article\`; now calls \`ensure_slug_available\`, \`_normalize_title\`; 4 calls moved under a new caller; different lines run in \`create_new_article\`, \`get_slug_for_article\` |

      2 tests behave exactly as before.

      Compared \`main\` (\`0123456\` the main commit) with the working tree (on \`0123456\`).

      ### Cost

      > Each side was recorded once, so a time difference may be noise: one is called out only past both 10 ms and 50%, and even then a second recording is what confirms it.
      > Times include the recorder's own overhead (settrace), which isn't subtracted: code that makes many calls looks slower than it runs untraced. Call counts don't depend on timing.
      > The recordings don't say which machine made them: if the two sides were recorded on different machines, their times differ for that reason alone.

      | Workflow | Time (ms) | Calls | External calls |
      |---|---|---|---|
      | \`test_user_can_create_article\` | 10.6 → 25.3, **slower** (+14.7, +138%) | 52 → 54 | 10 |
      | \`test_user_can_not_create_article_with_duplicated_slug\` | 20.8 → 20.0, within noise | 38 → 40 | 5 |

      2 workflows on both sides cost the same: the same calls and external calls, and no time change past the noise bands.

      Changed functions, over every workflow (time per call, so more callers isn't slower):

      | Function | Calls | Paths that ran | External calls under it | Time per call (ms) | Its own lines per call (ms) |
      |---|---|---|---|---|---|
      | \`_normalize_title\` (app.services.articles), added | 0 → 2 | 0 → 1 | 0 | — → 0.0 | — → 0.0 |
      | \`create_new_article\` (app.api.routes.articles.articles_resource), edited | 2 | 2 | 13 | 3.6 → 11.0, within noise | 0.7 → 0.2 |
      | \`ensure_slug_available\` (app.services.articles), added | 0 → 2 | 0 → 2 | 0 → 5 | — → 1.2 | — → 0.1 |
      | \`get_slug_for_article\` (app.services.articles), edited | 2 | 1 | 0 | 0.1 → 0.1, within noise | 0.1 → 0.1 |

      ### Threads to follow (4 changed functions)

      - \`_normalize_title\`, \`ensure_slug_available\` (app.services.articles), added: 2 workflows: 2 newly run through them
        - newly run through them: \`test_user_can_create_article\`, \`test_user_can_not_create_article_with_duplicated_slug\`
        - routes: \`POST /api/articles\` (new)
      - \`create_new_article\` (app.api.routes.articles.articles_resource), edited; \`get_slug_for_article\` (app.services.articles), edited: 2 workflows: 2 now run differently
        - now run differently: \`test_user_can_create_article\`, \`test_user_can_not_create_article_with_duplicated_slug\`
        - routes: \`POST /api/articles\`

      ### Architecture

      No architecture changes.

      ### What the changed code is

      - \`app.api.routes.articles.articles_resource.create_new_article\` (callable, inbound-adapter): primary-adapter; effect: reads-state, writes-state; cqs: both; failure: can-fail
      - \`app.services.articles._normalize_title\` (callable, core): effect: no recorded effect; cqs: query
      - \`app.services.articles.ensure_slug_available\` (callable, core): effect: reads-state; cqs: query; failure: can-fail
      - \`app.services.articles.get_slug_for_article\` (callable, core): effect: no recorded effect; cqs: query

      ### Routes

      - \`POST /api/articles\`: 2 ways changed
        - now calls \`ensure_slug_available\`, \`_normalize_title\` (2 ways)
      "
    `);
  });

  test("the cost section names the route that pays: the Django feed fix sends the feed to its own view, which makes 10 queries", async () => {
    // Before the fix the feed's URL matched the article-by-slug route and 404'd; now the feed
    // view serves it. The route lines come first because that's who waits. Times all move by
    // a few milliseconds, none past both noise bands, so none is named slower or faster.
    const runs = fixtureRuns("django-feed-fix");

    const bundle = buildReviewBundle({ base: (await runs.previous())!, head: await runs.latest(), baseSide: side("main", "aaaaaaaaaaaa"), headSide: side("working", "working"), baseRules: ZoneRules.none(), rules: ZoneRules.none(), createdAt: CREATED });

    const markdown = reviewBundleMarkdown(bundle);
    expect(markdown.slice(markdown.indexOf("External calls by route"), markdown.indexOf("Changed functions"))).toMatchInlineSnapshot(`
      "External calls by route:

      - \`GET /api/articles/feed\` newly requested: makes 10 external calls (\`test_follower_sees_followed_authors_in_their_feed\`)
      - \`GET /api/articles/{slug}\` no longer requested: it made 2 external calls (\`test_follower_sees_followed_authors_in_their_feed\`)

      | Workflow | Time (ms) | Calls | External calls |
      |---|---|---|---|
      | \`test_follower_sees_followed_authors_in_their_feed\` | 377.5 → 378.7, within noise | 51 → 58 | 28 → 36 |
      | \`test_anonymous_visitor_cannot_publish\` | 2.2 → 4.5, within noise | 3 → 4 | 0 |

      6 workflows on both sides cost the same: the same calls and external calls, and no time change past the noise bands.

      "
    `);
  });

  test("a branch that adds a zone rule: the Markdown says what was decided, by whom, and what it moved", async () => {
    const run = await fixtureRuns("go-shop").latest();
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

  test("the categorizer in review: only findings the branch adds, and a zone proposed for new code, never applied", async () => {
    // A project rule: the slug refactor's core helpers may compute, not query. Helpers that
    // already queried on main aren't news; the one the branch adds is.
    const slugRules = ZoneRules.parse(
      JSON.stringify({
        version: 2,
        style: "hexagonal",
        zones: [{ match: "app.services.**", zone: "core", reason: "services", by: "user" }],
        taxonomy: { rules: [{ id: "services-compute-only", message: "a service helper that queries", match: "app.services.**", when: ["kind=callable"], flag: ["effect=reads-state"], severity: "info" }] },
      }),
    );
    const slugs = fixtureRuns("fastapi-slug-refactor");
    const slugBundle = buildReviewBundle({ base: (await slugs.previous())!, head: await slugs.latest(), baseSide: side("main", "aaaaaaaaaaaa"), headSide: side("working", "working"), baseRules: slugRules, rules: slugRules, createdAt: CREATED });
    // The feed fix adds a view no rule places: its route makes it a primary adapter.
    const feed = fixtureRuns("django-feed-fix");
    const feedBundle = buildReviewBundle({ base: (await feed.previous())!, head: await feed.latest(), baseSide: side("main", "aaaaaaaaaaaa"), headSide: side("working", "working"), baseRules: ZoneRules.none(), rules: ZoneRules.none(), createdAt: CREATED });
    const feedMarkdown = reviewBundleMarkdown(feedBundle);

    expect({
      newFindings: slugBundle.categories.newFindings.map((finding) => `${finding.severity} ${finding.rule}: ${finding.item}`),
      proposals: feedBundle.categories.proposals,
    }).toMatchInlineSnapshot(`
      {
        "newFindings": [
          "info services-compute-only: app.services.articles.ensure_slug_available",
        ],
        "proposals": [
          {
            "by": "detected",
            "match": "conduit.apps.articles.views.ArticlesFeedAPIView",
            "reason": "its role: primary-adapter (the framework routes GET /api/^articles/feed/? to it)",
            "zone": "inbound-adapter",
          },
        ],
      }
    `);
    expect(feedMarkdown.slice(feedMarkdown.indexOf("### What the changed code is"), feedMarkdown.indexOf("### Routes"))).toMatchInlineSnapshot(`
      "### What the changed code is

      - \`conduit.apps.articles.views.ArticlesFeedAPIView\` (type, inbound-adapter): primary-adapter
      - \`conduit.apps.articles.views.ArticlesFeedAPIView.get_queryset\` (callable, inbound-adapter): effect: reads-state; io: direct-io
      - \`conduit.apps.articles.views.ArticlesFeedAPIView.list\` (callable, inbound-adapter): effect: reads-state; io: direct-io
      - \`conduit.apps.core.exceptions.core_exception_handler\` (callable, inbound-adapter): effect: no recorded effect
      - \`conduit.apps.core.renderers.ConduitJSONRenderer.render\` (callable, inbound-adapter): effect: no recorded effect

      New findings (2):

      - **warn** \`io-outside-allowed-zones\`: \`conduit.apps.articles.views.ArticlesFeedAPIView.get_queryset\` does I/O itself in a zone its style keeps free of it (direct-io: sqlite: SELECT)
      - **warn** \`io-outside-allowed-zones\`: \`conduit.apps.articles.views.ArticlesFeedAPIView.list\` does I/O itself in a zone its style keeps free of it (direct-io: sqlite: SELECT)

      Proposed zones for new code: add them to runshape.json to approve them in this diff (nothing is applied):

      \`\`\`json
      {"match":"conduit.apps.articles.views.ArticlesFeedAPIView","zone":"inbound-adapter","reason":"its role: primary-adapter (the framework routes GET /api/^articles/feed/? to it)","by":"detected"}
      \`\`\`

      "
    `);
  });

  test("a big change's findings and proposals are capped in review.md and page.json, and say how many more review.json holds (second-model review)", async () => {
    const feed = fixtureRuns("django-feed-fix");
    const bundle = buildReviewBundle({ base: (await feed.previous())!, head: await feed.latest(), baseSide: side("main", "aaaaaaaaaaaa"), headSide: side("working", "working"), baseRules: ZoneRules.none(), rules: ZoneRules.none(), createdAt: CREATED });
    // As if the change had touched 30 views: the same finding and proposal, many times over.
    const many = <T,>(items: T[], n: number) => Array.from({ length: n }, (_, i) => items[i % items.length]!);
    const big = { ...bundle, categories: { ...bundle.categories, items: many(bundle.categories.items, 50), newFindings: many(bundle.categories.newFindings, 30), proposals: many(bundle.categories.proposals, 30) } };

    const markdown = reviewBundleMarkdown(big);
    const page = buildReviewPage(big);

    expect({
      markdown: markdown.split("\n").filter((line) => /^(- and|and) \d+ more/.test(line)),
      page: { items: page.categories!.items.length, findings: page.categories!.findings.length, proposals: page.categories!.proposals.length, omitted: page.categories!.omitted },
    }).toEqual({
      markdown: ["- and 35 more (review.json lists every claim with its evidence)", "- and 15 more (review.json lists them all)", "and 20 more (review.json lists them all)"],
      page: { items: 40, findings: 25, proposals: 25, omitted: { items: 10, findings: 5, proposals: 5 } },
    });
  });

  test("names only: no query text, no request as sent, and unchanged routes counted, not copied (second-model review)", async () => {
    // A bundle may be stored centrally by commit: a query's text and a request's path (ids,
    // emails) stay in the recordings on the machine that made them.
    const runs = fixtureRuns("django-feed-fix");
    const bundle = buildReviewBundle({ base: (await runs.previous())!, head: await runs.latest(), baseSide: side("main", "aaaaaaaaaaaa"), headSide: side("working", "working"), baseRules: ZoneRules.none(), rules: ZoneRules.none(), createdAt: CREATED });
    const json = JSON.stringify(bundle);

    expect({
      queryText: /\b(SELECT|INSERT|UPDATE|DELETE)\b[^"]*\bFROM\b|"articles_article"/.test(json),
      queries: bundle.review.items.flatMap((item) => item.queriesAdded).slice(0, 2),
      routesKept: bundle.routes.routes.map((route) => `${route.label}: ${route.change}`),
      unchangedRoutes: bundle.routes.unchanged,
      requestLines: json.includes('"line"'),
    }).toEqual({
      queryText: false,
      queries: ["sqlite: SELECT", "sqlite: SELECT"],
      routesKept: ["GET /api/articles/feed: added", "GET /api/articles/{slug}: removed"],
      unchangedRoutes: 8,
      requestLines: false,
    });
  });

  test("the base is where the branch left main, and the Markdown says so, not 'main'", async () => {
    const run = await fixtureRuns("go-shop").latest();
    const fork = { ...side("main", "bbbbbbbbbbbb"), forkOf: { tip: "fedcba9876543210fedcba9876543210fedcba98", commitsSince: 3 } };
    const dirtyHead = { ...side("working", "working"), dirty: true };

    const markdown = reviewBundleMarkdown(buildReviewBundle({ base: run, head: run, baseSide: fork, headSide: dirtyHead, baseRules: ZoneRules.none(), rules: ZoneRules.none(), createdAt: CREATED }));

    expect(markdown.split("\n").find((line) => line.startsWith("Compared"))).toBe(
      "Compared where this branch left `main` (`0123456` the main commit; `main` has 3 commits since) with the working tree (on `0123456`, with uncommitted changes).",
    );
  });

  test("the story: the PR, its tickets, what couldn't be read and the docs and comments changed, as one-line plain text a posted comment can't be hijacked by", async () => {
    // Titles are the PR author's and ticket writers' text, and review.md may be posted as a PR
    // comment: an image there would load from anywhere, a tag would render. Escaped, they read
    // as typed. Ticket and PR bodies aren't here at all: they go to the explainer only.
    // Every "#" before a number and every "://" carries an invisible zero-width space (plainMarkdown).
    const run = await fixtureRuns("go-shop").latest();
    const story: ReviewStory = {
      pullRequest: { number: 7, title: "Refuse orders ![x](https://evil.example/beacon.png) <img src=x>", url: "https://github.com/acme/shop/pull/7" },
      tickets: [
        { id: "#12", source: "GitHub Issues", title: "Orders over\nthe limit go *through*", url: "https://github.com/acme/shop/issues/12", state: "open" },
        { id: "SHOP-7", source: "Jira", title: "Credit limits", url: null, state: "In Progress" },
      ],
      unread: [{ id: "#30", source: "GitHub Issues", reason: "gh issue view: HTTP 401: Bad credentials" }],
      notes: [
        { path: "docs/orders.md", kind: NoteKind.Doc, added: 3, removed: 1 },
        { path: "src/orders.ts", kind: NoteKind.Comments, added: 2, removed: 0 },
      ],
    };
    const bundle = buildReviewBundle({ base: run, head: run, baseSide: side("main", "bbbbbbbbbbbb"), headSide: side("feature", "cccccccccccc"), baseRules: ZoneRules.none(), rules: ZoneRules.none(), createdAt: CREATED, story });
    const empty = buildReviewBundle({ base: run, head: run, baseSide: side("main", "bbbbbbbbbbbb"), headSide: side("feature", "cccccccccccc"), baseRules: ZoneRules.none(), rules: ZoneRules.none(), createdAt: CREATED, story: { pullRequest: null, tickets: [], unread: [], notes: [] } });
    const section = (markdown: string) => markdown.slice(markdown.indexOf("### The story"), markdown.indexOf("### Cost"));

    expect(bundle.story).toEqual(story);
    expect(section(reviewBundleMarkdown(bundle))).toMatchInlineSnapshot(`
      "### The story

      Pull request [#​7](https://github.com/acme/shop/pull/7): Refuse orders \\!\\[x\\](https:​//evil.example/beacon.png) \\<img src=x\\>

      Tickets:

      - [#​12](https://github.com/acme/shop/issues/12) Orders over the limit go \\*through\\* (GitHub Issues, open)
      - SHOP-7 Credit limits (Jira, In Progress)

      Mentioned, not read: #​30 (gh issue view: HTTP 401: Bad credentials)

      Docs and comments changed:

      - \`docs/orders.md\`: doc, +3 −1 lines
      - \`src/orders.ts\`: comments, +2 lines

      "
    `);
    expect(section(reviewBundleMarkdown(empty))).toBe("### The story\n\nNo pull request, ticket, doc or comment says what this change is for: its commit messages are all there is.\n\n");
  });

  test("when the base's rules aren't known, the bundle and its Markdown say both sides used head's", async () => {
    const run = await fixtureRuns("go-shop").latest();

    const bundle = buildReviewBundle({ base: run, head: run, baseSide: side("main", "bbbbbbbbbbbb"), headSide: side("working", "working"), baseRules: null, rules: ZoneRules.none(), createdAt: CREATED });

    const markdown = reviewBundleMarkdown(bundle);
    expect({ known: bundle.baseRulesKnown, said: markdown.includes("drawn with the current runshape.json"), nothing: markdown.includes("No architecture changes.") }).toEqual({
      known: false,
      said: true,
      nothing: true,
    });
  });
});
