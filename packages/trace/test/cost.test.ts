/**
 * What a change costs at run time (PLAN.md Phase 4): per workflow and per changed function,
 * time, calls into project code, external calls (SQL, HTTP: whatever the recorder saw at a
 * boundary), and distinct paths that ran.
 *
 * Counts are facts of the two recordings. Time is one measurement on each side, recorder
 * overhead included, so it's called out only when it moves past both noise bands (an absolute
 * floor and a share of the base's time), and never across recordings made differently. Only
 * workflows both sides have are compared; a new or gone one is reported apart.
 */
import { describe, expect, test } from "vitest";

import { Run, Scenario, TraceDirectory, TraceFiles } from "@runshape/kernel";
import { buildThreads, CostDiff, detectMoves, diffCost, FunctionCost, Measure, moreExternalCalls, Threads, TIME_NOISE_FLOOR_US, TIME_NOISE_RATIO, workflowCostChanged, WorkflowCost } from "../src";
import { fixtureFiles, fixtureRuns } from "../../kernel/test/fixtures";
import { diffOf } from "./graphs";

function threadsOf(base: Run, head: Run): Threads {
  const moves = detectMoves(base, head);
  return buildThreads(base, head, diffOf(base, head, { moves }), { moves });
}

function costOf(base: Run, head: Run, threads: Threads = threadsOf(base, head)): CostDiff {
  return diffCost(base, head, threads, { moves: detectMoves(base, head) });
}

const m = ({ before, after }: Measure) => `${before ?? "—"}→${after ?? "—"}`;
const ms = ({ before, after }: Measure) => `${before === null ? "—" : (before / 1000).toFixed(1)}→${after === null ? "—" : (after / 1000).toFixed(1)}ms`;

/** One line per workflow: which sides have it, time and its verdict, calls, external calls, and each route's. */
function workflowLine(w: WorkflowCost): string {
  const routes = w.routes.map((route) => `${route.label} ext ${m(route.externalCalls)}`).join(", ");
  return `${w.name} (${w.sides}): ${ms(w.timeUs)} ${w.time} | calls ${m(w.calls)} | ext ${m(w.externalCalls)}${routes ? ` | ${routes}` : ""}`;
}

function functionLine(fn: FunctionCost): string {
  return `${fn.change} ${fn.symbol.path}: calls ${m(fn.calls)} | paths ${m(fn.paths)} | ext ${m(fn.externalCalls)} | per call ${ms(fn.timePerCallUs)} ${fn.time} (self ${ms(fn.selfTimePerCallUs)}; total ${ms(fn.timeUs)})`;
}

/** A run with its scenarios replaced: the same recording, as if the suite had been different. */
function withScenarios(run: Run, scenarios: Scenario[]): Run {
  return new Run(run.root, run.createdAt, run.language, run.runtime, run.backend, run.topology, run.catalog, scenarios, run.problems, run.recorderVersion, run.sources);
}

/** One scenario run again: under another id (a second test through the same code), or the same id (a retry). */
function again(scenario: Scenario, nodeid: string): Scenario {
  return new Scenario(nodeid, scenario.outcome, scenario.durationUs, scenario.spans, scenario.objects, scenario.boundaryCalls, scenario.recorderErrors);
}

describe("diffCost", () => {
  test("the noise bands: 10 ms and 50%, both", () => {
    expect([TIME_NOISE_FLOOR_US, TIME_NOISE_RATIO]).toEqual([10_000, 0.5]);
  });

  test("the Django feed fix: the feed now runs its query per followed author's article, and no time change is past both bands", async () => {
    const runs = fixtureRuns("django-feed-fix");

    const cost = costOf((await runs.previous())!, await runs.latest());

    // Before the fix, GET /api/articles/feed matched the article-by-slug route ("feed" as a
    // slug) and 404'd after 2 external calls; now the feed view serves it with 10. That's the
    // line a reviewer needs: the route that pays, and how much. Its list makes 9 of them in one
    // call. Every time moves by milliseconds, and none past both bands: the follow test is
    // 10.9 ms faster but that's 3% of 378 ms; the anonymous test doubled, but by 2.3 ms. The
    // two bands together are what keep both out of the callouts. Functions the base never ran
    // (the feed view's) have no time before, not zero time: they're one-sided, not "slower".
    expect(cost.workflows.map(workflowLine)).toMatchInlineSnapshot(`
      [
        "test_follower_sees_followed_authors_in_their_feed (both): 377.5→378.7ms within-noise | calls 51→58 | ext 28→36 | GET /api/articles/feed ext 0→10, GET /api/articles/{slug} ext 2→0, POST /api/articles ext 12→12, POST /api/profiles/{username}/follow ext 6→6, POST /api/users ext 8→8",
        "test_anonymous_visitor_cannot_publish (both): 2.2→4.5ms within-noise | calls 3→4 | ext 0→0 | POST /api/articles ext 0→0",
        "test_author_publishes_a_tagged_article (both): 194.9→196.7ms within-noise | calls 29→29 | ext 21→21 | POST /api/articles ext 17→17, POST /api/users ext 4→4",
        "test_member_logs_in_and_reads_their_profile (both): 367.2→366.4ms within-noise | calls 23→23 | ext 7→7 | GET /api/user ext 2→2, POST /api/users ext 4→4, POST /api/users/login ext 1→1",
        "test_reader_browses_articles_by_tag (both): 197.0→194.1ms within-noise | calls 56→56 | ext 32→32 | GET /api/articles ext 4→4, POST /api/articles ext 24→24, POST /api/users ext 4→4",
        "test_reader_favorites_and_comments_on_an_article (both): 374.3→373.0ms within-noise | calls 59→59 | ext 34→34 | POST /api/articles ext 12→12, POST /api/articles/{article_slug}/comments ext 4→4, POST /api/articles/{article_slug}/favorite ext 10→10, POST /api/users ext 8→8",
        "test_reader_follows_an_author (both): 378.5→367.6ms within-noise | calls 26→26 | ext 14→14 | POST /api/profiles/{username}/follow ext 6→6, POST /api/users ext 8→8",
        "test_visitor_registers_an_account (both): 211.9→214.8ms within-noise | calls 9→9 | ext 4→4 | POST /api/users ext 4→4",
      ]
    `);
    expect(cost.functions.map(functionLine)).toMatchInlineSnapshot(`
      [
        "ran differently ConduitJSONRenderer.render: calls 24→24 | paths 3→2 | ext 0→0 | per call 0.0→0.0ms within-noise (self 0.0→0.0ms; total 0.3→0.2ms)",
        "ran differently core_exception_handler: calls 2→1 | paths 2→1 | ext 0→0 | per call 0.1→0.2ms within-noise (self 0.1→0.2ms; total 0.2→0.2ms)",
        "ran differently _handle_not_found_error: calls 1→0 | paths 1→0 | ext 0→0 | per call 0.0→—ms one-side (self 0.0→—ms; total 0.0→—ms)",
        "ran differently ArticlesFeedAPIView.get_queryset: calls 0→1 | paths 0→1 | ext 0→1 | per call —→0.9ms one-side (self —→0.9ms; total —→0.9ms)",
        "ran differently ArticlesFeedAPIView.list: calls 0→1 | paths 0→1 | ext 0→9 | per call —→2.7ms one-side (self —→1.3ms; total —→2.7ms)",
        "ran differently ArticleViewSet.retrieve: calls 1→0 | paths 1→0 | ext 1→0 | per call 0.8→—ms one-side (self 0.8→—ms; total 0.8→—ms)",
      ]
    `);
    expect(cost.caveats).toMatchInlineSnapshot(`
      [
        "Each side was recorded once, so a time difference may be noise: one is called out only past both 10 ms and 50%, and even then a second recording is what confirms it.",
        "Times include the recorder's own overhead (monitoring), which isn't subtracted: code that makes many calls looks slower than it runs untraced. Call counts don't depend on timing.",
        "The recordings don't say which machine made them: if the two sides were recorded on different machines, their times differ for that reason alone.",
      ]
    `);
  });

  test("the FastAPI slug refactor: same external calls, two new helpers on the article route, and one workflow time past both bands in a single run", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");

    const cost = costOf((await runs.previous())!, await runs.latest());

    // test_user_can_create_article took 14.7 ms longer, past both bands, so it's called out.
    // But look where the time went: create_new_article's own lines didn't slow down; the 15 ms
    // is a gap between two external calls inside create_article, code this change didn't
    // touch. A database wait in one run, most likely. That's why a callout from one recording
    // says to record again, and why functions carry own-lines time: "slower, but not in its
    // own code" is visible without opening the trace. Per call, create_new_article moves 7.3
    // ms: under the floor. The counts are steady: the refactor adds two calls per request (the
    // new helpers) and no external call; ensure_slug_available makes the duplicate check's
    // call that create_new_article used to make directly.
    expect(cost.workflows.map(workflowLine)).toMatchInlineSnapshot(`
      [
        "test_user_can_create_article (both): 10.6→25.3ms slower | calls 52→54 | ext 10→10 | POST /api/articles ext 10→10",
        "test_user_can_not_create_article_with_duplicated_slug (both): 20.8→20.0ms within-noise | calls 38→40 | ext 5→5 | POST /api/articles ext 5→5",
        "test_empty_feed_if_user_has_not_followings (both): 986.8→973.5ms within-noise | calls 711→711 | ext 267→267 | GET /api/articles/feed ext 2→2",
        "test_user_success_registration (both): 381.0→383.6ms within-noise | calls 26→26 | ext 6→6 | POST /api/users ext 5→5",
      ]
    `);
    expect(cost.functions.map(functionLine)).toMatchInlineSnapshot(`
      [
        "added _normalize_title: calls 0→2 | paths 0→1 | ext 0→0 | per call —→0.0ms one-side (self —→0.0ms; total —→0.0ms)",
        "edited create_new_article: calls 2→2 | paths 2→2 | ext 13→13 | per call 3.6→11.0ms within-noise (self 0.7→0.2ms; total 7.2→21.9ms)",
        "added ensure_slug_available: calls 0→2 | paths 0→2 | ext 0→5 | per call —→1.2ms one-side (self —→0.1ms; total —→2.4ms)",
        "edited get_slug_for_article: calls 2→2 | paths 1→1 | ext 0→0 | per call 0.1→0.1ms within-noise (self 0.1→0.1ms; total 0.1→0.2ms)",
      ]
    `);
  });

  test("a second test through unchanged code doubles its total time, not its time per call: no 'slower'", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");
    const head = await runs.latest();
    const create = head.scenarios.find((s) => s.name === "test_user_can_create_article")!;
    const twice = withScenarios(head, [...head.scenarios, again(create, `${create.nodeid}_again`)]);
    // create_new_article, as the slug refactor's threads name it: one function to follow.
    const threads = threadsOf((await runs.previous())!, head);
    const only = { ...threads, functions: threads.functions.filter((fn) => fn.symbol.path === "create_new_article") };

    const [fn] = costOf(head, twice, only).functions;

    // The same recording on both sides, plus one more test calling it: total 21.9 → 41.9 ms
    // would be "slower" past both bands; per call it's 11.0 → 14.0 ms (the extra test's call is
    // quicker than the one with the database wait), within noise.
    expect(functionLine(fn!)).toMatchInlineSnapshot(`"edited create_new_article: calls 2→3 | paths 2→2 | ext 13→22 | per call 11.0→14.0ms within-noise (self 0.2→0.2ms; total 21.9→41.9ms)"`);
  });

  test("new and gone workflows aren't 'the same': they're reported apart, and a new one's external calls still count", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");
    const [base, head] = [(await runs.previous())!, await runs.latest()];
    const create = "test_user_can_create_article";
    const register = "test_user_success_registration";
    // As if this branch added the create test (the base lacks it) and deleted the registration test.
    const before = withScenarios(base, base.scenarios.filter((s) => s.name !== create));
    const after = withScenarios(head, head.scenarios.filter((s) => s.name !== register));

    const cost = costOf(before, after);

    expect({
      oneSided: cost.workflows.filter((w) => w.sides !== "both").map(workflowLine),
      changed: cost.workflows.filter(workflowCostChanged).map((w) => w.name),
      more: moreExternalCalls(cost.workflows),
    }).toMatchInlineSnapshot(`
      {
        "changed": [
          "test_user_can_not_create_article_with_duplicated_slug",
        ],
        "more": {
          "compared": 0,
          "new": 1,
        },
        "oneSided": [
          "test_user_can_create_article (new): —→25.3ms one-side | calls —→54 | ext —→10 | POST /api/articles ext —→10",
          "test_user_success_registration (gone): 381.0→—ms one-side | calls 26→— | ext 6→— | POST /api/users ext 5→—",
        ],
      }
    `);
  });

  test("a retried test (one nodeid recorded twice) is counted once, the last attempt, in workflows and functions alike", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");
    const [base, head] = [(await runs.previous())!, await runs.latest()];
    const create = head.scenarios.find((s) => s.name === "test_user_can_create_article")!;
    const retried = withScenarios(head, [again(create, create.nodeid), ...head.scenarios]);

    const [plain, withRetry] = [costOf(base, head), costOf(base, retried)];

    expect({ workflows: withRetry.workflows.map(workflowLine), functions: withRetry.functions.map(functionLine) }).toEqual({
      workflows: plain.workflows.map(workflowLine),
      functions: plain.functions.map(functionLine),
    });
    expect(withRetry.caveats.at(-1)).toMatchInlineSnapshot(`"1 test run was a retry: only each test's last attempt is counted."`);
  });

  test("paths are named by line offset when only one side kept its source: the same lines, the same paths", async () => {
    const base = await fixtureRuns("fastapi-slug-refactor").latest();
    const head = await new TraceDirectory(patched(fixtureFiles("fastapi-slug-refactor"), (manifest) => ({ ...manifest, sources: undefined }))).latest();
    const threads = threadsOf((await fixtureRuns("fastapi-slug-refactor").previous())!, base);

    const cost = costOf(base, head, threads);

    // The same recording, one side without its source: every path count is the same both sides.
    expect(cost.functions.map((fn) => `${fn.symbol.path}: paths ${m(fn.paths)}`)).toMatchInlineSnapshot(`
      [
        "_normalize_title: paths 1→1",
        "create_new_article: paths 2→2",
        "ensure_slug_available: paths 2→2",
        "get_slug_for_article: paths 1→1",
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

  test("recordings made differently compare counts, never time; a runtime's patch release isn't a difference", async () => {
    const base = (await fixtureRuns("fastapi-slug-refactor").previous())!;
    const files = fixtureFiles("fastapi-slug-refactor");
    const recorder = await new TraceDirectory(patched(files, (manifest) => ({ ...manifest, recorder: "0.2.0" }))).latest();
    const patch = await new TraceDirectory(patched(files, (manifest) => ({ ...manifest, python: "3.9.22" }))).latest();
    const backend = await new TraceDirectory(patched(files, (manifest) => ({ ...manifest, backend: "monitoring" }))).latest();

    const [byRecorder, byPatch, byBackend] = [costOf(base, recorder), costOf(base, patch), costOf(base, backend)];

    expect({
      recorder: { timeComparable: byRecorder.timeComparable, verdicts: [...new Set(byRecorder.workflows.map((w) => w.time))], lastCaveat: byRecorder.caveats.at(-1) },
      patchRelease: byPatch.timeComparable,
      backendCaveats: byBackend.caveats.slice(1),
    }).toMatchInlineSnapshot(`
      {
        "backendCaveats": [
          "Times include the recorder's own overhead (settrace on the base, monitoring on this branch), which isn't subtracted: code that makes many calls looks slower than it runs untraced. Call counts don't depend on timing.",
          "The recordings don't say which machine made them: if the two sides were recorded on different machines, their times differ for that reason alone.",
          "The two sides were recorded differently (python 3.9.21, settrace, recorder 0.1.0 vs python 3.9.21, monitoring, recorder 0.1.0): their overheads differ, so no time is called out.",
        ],
        "patchRelease": true,
        "recorder": {
          "lastCaveat": "The two sides were recorded differently (python 3.9.21, settrace, recorder 0.1.0 vs python 3.9.21, settrace, recorder 0.2.0): their overheads differ, so no time is called out.",
          "timeComparable": false,
          "verdicts": [
            "not-comparable",
          ],
        },
      }
    `);
  });
});

/** The recording with its manifest changed: another recorder, runtime, backend, or no source. */
function patched(files: TraceFiles, change: (manifest: Record<string, unknown>) => Record<string, unknown>): TraceFiles {
  return {
    async readText(path) {
      const text = await files.readText(path);
      return path.endsWith("manifest.json") ? JSON.stringify(change(JSON.parse(text))) : text;
    },
  };
}
