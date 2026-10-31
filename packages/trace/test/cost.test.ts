/**
 * What a change costs at run time (PLAN.md Phase 4): per workflow and per changed function,
 * time, calls into project code, queries (external calls), and distinct paths that ran.
 *
 * Counts are facts of the two recordings. Time is one measurement on each side, recorder
 * overhead included, so it's called out only when it moves past both noise bands (an absolute
 * floor and a share of the base's time), and never across recordings made differently.
 */
import { describe, expect, test } from "vitest";

import { Run, TraceDirectory } from "@runshape/kernel";
import { buildThreads, CostDiff, detectMoves, diffCost, FunctionCost, Measure, TIME_NOISE_FLOOR_US, TIME_NOISE_RATIO, workflowCostChanged, WorkflowCost } from "../src";
import { fixtureFiles, fixtureRuns } from "../../kernel/test/fixtures";
import { diffOf } from "./graphs";

function costOf(base: Run, head: Run): CostDiff {
  const moves = detectMoves(base, head);
  return diffCost(base, head, buildThreads(base, head, diffOf(base, head, { moves }), { moves }), { moves });
}

const m = ({ before, after }: Measure) => `${before ?? "—"}→${after ?? "—"}`;
const ms = ({ before, after }: Measure) => `${before === null ? "—" : (before / 1000).toFixed(1)}→${after === null ? "—" : (after / 1000).toFixed(1)}ms`;

/** One line per workflow: time and its verdict, calls, queries, and each route's queries. */
function workflowLine(w: WorkflowCost): string {
  const routes = w.routes.map((route) => `${route.label} q ${m(route.queries)}`).join(", ");
  return `${w.name}: ${ms(w.timeUs)} ${w.time} | calls ${m(w.calls)} | q ${m(w.queries)}${routes ? ` | ${routes}` : ""}`;
}

function functionLine(fn: FunctionCost): string {
  return `${fn.change} ${fn.symbol.path}: calls ${m(fn.calls)} | paths ${m(fn.paths)} | q ${m(fn.queries)} | ${ms(fn.timeUs)} ${fn.time} (self ${ms(fn.selfTimeUs)})`;
}

describe("diffCost", () => {
  test("the noise bands: 10 ms and 50%, both", () => {
    expect([TIME_NOISE_FLOOR_US, TIME_NOISE_RATIO]).toEqual([10_000, 0.5]);
  });

  test("the Django feed fix: the feed now runs its query per followed author's article, and no time change is past both bands", async () => {
    const runs = fixtureRuns("django-feed-fix");

    const cost = costOf((await runs.previous())!, await runs.latest());

    // Before the fix, GET /api/articles/feed matched the article-by-slug route ("feed" as a
    // slug) and 404'd after 2 queries; now the feed view serves it with 10. That's the line a
    // reviewer needs: the route that pays, and how much. Its list makes 9 of them in one call.
    // Every time moves by milliseconds, and none past both bands: the follow test is 10.9 ms
    // faster but that's 3% of 378 ms; the anonymous test doubled, but by 2.3 ms. The two bands
    // together are what keep both out of the callouts.
    expect(cost.workflows.map(workflowLine)).toMatchInlineSnapshot(`
      [
        "test_follower_sees_followed_authors_in_their_feed: 377.5→378.7ms within-noise | calls 51→58 | q 28→36 | GET /api/articles/feed q 0→10, GET /api/articles/{slug} q 2→0, POST /api/articles q 12→12, POST /api/profiles/{username}/follow q 6→6, POST /api/users q 8→8",
        "test_anonymous_visitor_cannot_publish: 2.2→4.5ms within-noise | calls 3→4 | q 0→0 | POST /api/articles q 0→0",
        "test_author_publishes_a_tagged_article: 194.9→196.7ms within-noise | calls 29→29 | q 21→21 | POST /api/articles q 17→17, POST /api/users q 4→4",
        "test_member_logs_in_and_reads_their_profile: 367.2→366.4ms within-noise | calls 23→23 | q 7→7 | GET /api/user q 2→2, POST /api/users q 4→4, POST /api/users/login q 1→1",
        "test_reader_browses_articles_by_tag: 197.0→194.1ms within-noise | calls 56→56 | q 32→32 | GET /api/articles q 4→4, POST /api/articles q 24→24, POST /api/users q 4→4",
        "test_reader_favorites_and_comments_on_an_article: 374.3→373.0ms within-noise | calls 59→59 | q 34→34 | POST /api/articles q 12→12, POST /api/articles/{article_slug}/comments q 4→4, POST /api/articles/{article_slug}/favorite q 10→10, POST /api/users q 8→8",
        "test_reader_follows_an_author: 378.5→367.6ms within-noise | calls 26→26 | q 14→14 | POST /api/profiles/{username}/follow q 6→6, POST /api/users q 8→8",
        "test_visitor_registers_an_account: 211.9→214.8ms within-noise | calls 9→9 | q 4→4 | POST /api/users q 4→4",
      ]
    `);
    expect(cost.functions.map(functionLine)).toMatchInlineSnapshot(`
      [
        "ran differently ConduitJSONRenderer.render: calls 24→24 | paths 3→2 | q 0→0 | 0.3→0.2ms within-noise (self 0.3→0.2ms)",
        "ran differently core_exception_handler: calls 2→1 | paths 2→1 | q 0→0 | 0.2→0.2ms within-noise (self 0.2→0.2ms)",
        "ran differently _handle_not_found_error: calls 1→0 | paths 1→0 | q 0→0 | 0.0→0.0ms within-noise (self 0.0→0.0ms)",
        "ran differently ArticlesFeedAPIView.get_queryset: calls 0→1 | paths 0→1 | q 0→1 | 0.0→0.9ms within-noise (self 0.0→0.9ms)",
        "ran differently ArticlesFeedAPIView.list: calls 0→1 | paths 0→1 | q 0→9 | 0.0→2.7ms within-noise (self 0.0→1.3ms)",
        "ran differently ArticleViewSet.retrieve: calls 1→0 | paths 1→0 | q 1→0 | 0.8→0.0ms within-noise (self 0.8→0.0ms)",
      ]
    `);
    expect(cost.caveats).toMatchInlineSnapshot(`
      [
        "Each side was recorded once, so a time difference may be noise: one is called out only past both 10 ms and 50%, and even then a second recording is what confirms it.",
        "Times include the recorder's own overhead (monitoring), which isn't subtracted: code that makes many calls looks slower than it runs untraced. Call and query counts don't depend on timing.",
      ]
    `);
  });

  test("the FastAPI slug refactor: same queries, two new helpers on the article route, and one time change past both bands in a single run", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");

    const cost = costOf((await runs.previous())!, await runs.latest());

    // test_user_can_create_article took 14.7 ms longer, past both bands, so it's called out.
    // But look where the time went: create_new_article's own lines didn't slow down (self 1.4
    // → 0.5 ms over both tests); the 15 ms is a gap between two queries inside create_article, code this change
    // didn't touch. A database wait in one run, most likely. That's why a callout from one
    // recording says to record again, and why functions carry self time: "slower, but not in
    // its own code" is visible without opening the trace. The counts are steady: the refactor
    // adds two calls per request (the new helpers) and no query; ensure_slug_available makes
    // the duplicate check's query that create_new_article used to make.
    expect(cost.workflows.map(workflowLine)).toMatchInlineSnapshot(`
      [
        "test_user_can_create_article: 10.6→25.3ms slower | calls 52→54 | q 10→10 | POST /api/articles q 10→10",
        "test_user_can_not_create_article_with_duplicated_slug: 20.8→20.0ms within-noise | calls 38→40 | q 5→5 | POST /api/articles q 5→5",
        "test_empty_feed_if_user_has_not_followings: 986.8→973.5ms within-noise | calls 711→711 | q 267→267 | GET /api/articles/feed q 2→2",
        "test_user_success_registration: 381.0→383.6ms within-noise | calls 26→26 | q 6→6 | POST /api/users q 5→5",
      ]
    `);
    expect(cost.functions.map(functionLine)).toMatchInlineSnapshot(`
      [
        "added _normalize_title: calls 0→2 | paths 0→1 | q 0→0 | 0.0→0.0ms within-noise (self 0.0→0.0ms)",
        "edited create_new_article: calls 2→2 | paths 2→2 | q 13→13 | 7.2→21.9ms slower (self 1.4→0.5ms)",
        "added ensure_slug_available: calls 0→2 | paths 0→2 | q 0→5 | 0.0→2.4ms within-noise (self 0.0→0.2ms)",
        "edited get_slug_for_article: calls 2→2 | paths 1→1 | q 0→0 | 0.1→0.2ms within-noise (self 0.1→0.2ms)",
      ]
    `);
  });

  test("a no-op change: the same recording on both sides costs the same and calls nothing out", async () => {
    const run = await fixtureRuns("django-feed-fix").latest();

    const cost = costOf(run, run);

    expect({ changed: cost.workflows.filter(workflowCostChanged).map((w) => w.name), functions: cost.functions.length, verdicts: [...new Set(cost.workflows.map((w) => w.time))] }).toEqual({
      changed: [],
      functions: 0,
      verdicts: ["within-noise"],
    });
  });

  test("recordings made differently (another recorder version) compare counts, never time", async () => {
    const base = await fixtureRuns("fastapi-slug-refactor").previous();
    const head = await new TraceDirectory(withRecorder(fixtureFiles("fastapi-slug-refactor"), "0.2.0")).latest();

    const cost = costOf(base!, head);

    expect({ timeComparable: cost.timeComparable, verdicts: [...new Set(cost.workflows.map((w) => w.time))], lastCaveat: cost.caveats.at(-1) }).toMatchInlineSnapshot(`
      {
        "lastCaveat": "The two sides were recorded differently (python 3.9.21, settrace, recorder 0.1.0 vs python 3.9.21, settrace, recorder 0.2.0): their overheads differ, so no time is called out.",
        "timeComparable": false,
        "verdicts": [
          "not-comparable",
        ],
      }
    `);
  });
});

/** The recording as another recorder version would have stamped it. */
function withRecorder(files: ReturnType<typeof fixtureFiles>, version: string): ReturnType<typeof fixtureFiles> {
  return {
    async readText(path) {
      const text = await files.readText(path);
      if (!path.endsWith("manifest.json")) return text;
      return JSON.stringify({ ...JSON.parse(text), recorder: version });
    },
  };
}
