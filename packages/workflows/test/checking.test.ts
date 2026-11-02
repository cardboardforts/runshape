/**
 * `runshape check`: whether a branch may go to a person for review (PLAN.md, Phase 8). An agent
 * that wrote the branch runs it as it goes; a pre-push hook (or CI) runs it with --gate before
 * anyone is asked to look. The user's rule: self-correction is optional, the check isn't, and
 * a branch goes past it only when the agent has told the person what's left and the person
 * said it's fine. So the check fails closed (no review, unreadable rules, an unreadable OK all
 * block), and an OK is kept naming the commit and the findings it covers: anything new, or
 * any other commit, is checked afresh.
 */
import { describe, expect, test } from "vitest";

import { ZoneRules } from "@runshape/architecture";
import { KeptChecks, KeptRecordings, LogFields, Logger, LogLevel, Repository } from "@runshape/kernel";
import { WorkflowSides } from "@runshape/trace";
import { CheckBypass, checkExitCode, CheckFinding, checkFindings, Checking, CheckResult, checkText, Comparer, readCheckRules } from "../src/checking";
import { buildReviewBundle, ReviewBundle } from "../src/review-bundle";
import { FixtureApp, fixtureRuns } from "../../kernel/test/fixtures";

const BASE_COMMIT = "1111111111111111111111111111111111111111";
const HEAD_COMMIT = "2222222222222222222222222222222222222222";
const DEFAULTS = readCheckRules(null).rules;

async function bundleOf(fixture: FixtureApp, { reversed = false, dirty = false, headCommit = HEAD_COMMIT } = {}): Promise<ReviewBundle> {
  const runs = fixtureRuns(fixture);
  const [previous, latest] = [(await runs.previous())!, await runs.latest()];
  const [base, head] = reversed ? [latest, previous] : [previous, latest];
  const side = (asked: string, recording: string, commit: string, isDirty: boolean) => ({ asked, recording, commit, subject: `the ${asked} commit`, dirty: isDirty, forkOf: null });
  return buildReviewBundle({ base, head, baseSide: side("main", "aaaaaaaaaaaa", BASE_COMMIT, false), headSide: side("working", "working", headCommit, dirty), baseRules: ZoneRules.none(), rules: ZoneRules.none(), createdAt: "2026-11-01T09:00:00Z" });
}

const shown = (findings: CheckFinding[]) => findings.map((f) => `${f.severity} ${f.rule}: ${f.subject}: ${f.message}`);

describe("checkFindings", () => {
  test("recorded changes, checked with the defaults: a broken test and a forbidden call block, a slower test only warns", async () => {
    expect({
      // The Django feed fix, undone: the follower's feed test stops passing (xfail marks the known bug).
      breaksATest: shown(checkFindings(await bundleOf("django-feed-fix", { reversed: true }), DEFAULTS, { gate: false })),
      // The fix itself: with no rules, the inferred zones say the feed view now uses serializers
      // directly, which a hexagon forbids. Blocking it is the point: a person decides, not the agent.
      theFix: shown(checkFindings(await bundleOf("django-feed-fix"), DEFAULTS, { gate: false })),
      // The slug refactor: one test past both noise bands, from one recording a side.
      aRefactor: shown(checkFindings(await bundleOf("fastapi-slug-refactor"), DEFAULTS, { gate: false })),
    }).toMatchInlineSnapshot(`
      {
        "aRefactor": [
          "warn slower: test_user_can_create_article: 10.6 ms → 25.3 ms (past both 10 ms and 50%; one recording a side)",
        ],
        "breaksATest": [
          "block now-failing: test_follower_sees_followed_authors_in_their_feed: passed before, xfailed now",
          "warn categorizer-warnings: conduit.apps.articles.views.ArticleViewSet.retrieve: io-outside-allowed-zones: does I/O itself in a zone its style keeps free of it",
        ],
        "theFix": [
          "block new-violations: ArticlesFeedAPIView → TagRelatedField: a request handler using an outbound adapter directly: no core in between (inbound-adapter → outbound-adapter, 1 call)",
          "block new-violations: ArticlesFeedAPIView → ArticleSerializer: a request handler using an outbound adapter directly: no core in between (inbound-adapter → outbound-adapter, 4 calls)",
          "warn categorizer-warnings: conduit.apps.articles.views.ArticlesFeedAPIView.get_queryset: io-outside-allowed-zones: does I/O itself in a zone its style keeps free of it",
          "warn categorizer-warnings: conduit.apps.articles.views.ArticlesFeedAPIView.list: io-outside-allowed-zones: does I/O itself in a zone its style keeps free of it",
          "block more-external-calls: test_follower_sees_followed_authors_in_their_feed: 28 → 36 external calls (more than 0 more)",
        ],
      }
    `);
  });

  test("what a branch does to the architecture, the cost or the tree: each rule's default, then runshape.json's say", async () => {
    const bundle = await bundleOf("fastapi-slug-refactor", { dirty: true });
    // What an agent's branch can add that the recordings above don't: a model's placement and
    // region, and a workflow that now queries once more.
    bundle.architecture.rules.added.push({ match: "app.services.**", zone: "core", reason: "services", by: "llm" }, { match: "app.api.**", zone: "inbound-adapter", reason: "routes", by: "user" });
    bundle.architecture.regions.added.push({ path: "app/db", match: "app.db.**", in: "outbound-adapter", style: "layered", by: "llm", reason: "the database layer", zones: [] });
    const workflow = bundle.cost!.workflows.find((w) => w.sides === WorkflowSides.Both)!;
    workflow.externalCalls = { before: 3, after: 4 };

    const configured = readCheckRules(JSON.stringify({ check: { rules: { slower: "block", "llm-placements": "off", uncommitted: "off" }, allowedExternalCallIncrease: 1 } }));
    expect({
      defaults: shown(checkFindings(bundle, DEFAULTS, { gate: false })),
      // Before human review, uncommitted changes always block: the check has to be of the commit pushed.
      gate: shown(checkFindings(bundle, configured.rules, { gate: true })).filter((line) => line.includes("uncommitted")),
      configured: shown(checkFindings(bundle, configured.rules, { gate: false })),
      problems: configured.problems,
    }).toMatchInlineSnapshot(`
      {
        "configured": [
          "block slower: test_user_can_create_article: 10.6 ms → 25.3 ms (past both 10 ms and 50%; one recording a side)",
        ],
        "defaults": [
          "warn uncommitted: the working tree: has uncommitted changes: the check isn't of a commit anyone can review",
          "warn llm-placements: app.services.**: placed in core by a model ("by": "llm") in this branch: awaiting your approval in the diff",
          "warn llm-placements: app/db: a region (layered) a model drew ("by": "llm") in this branch: awaiting your approval in the diff",
          "block more-external-calls: test_user_can_create_article: 3 → 4 external calls (more than 0 more)",
          "warn slower: test_user_can_create_article: 10.6 ms → 25.3 ms (past both 10 ms and 50%; one recording a side)",
        ],
        "gate": [
          "block uncommitted: the working tree: has uncommitted changes: the check isn't of a commit anyone can review",
        ],
        "problems": [],
      }
    `);
  });
});

describe("readCheckRules", () => {
  test("every problem at once, and then the defaults whole: half a section isn't what anyone wrote", () => {
    const read = readCheckRules(`﻿${JSON.stringify({ zones: [], check: { rules: { slower: "block", "now-faling": "warn", "new-violations": "never" }, allowedExternalCallIncrease: -1, gate: true } })}`);
    expect({ problems: read.problems, slower: read.rules.severities.slower, noSection: readCheckRules("{}").rules, notJson: readCheckRules("{").problems }).toMatchInlineSnapshot(`
      {
        "noSection": {
          "allowedExternalCallIncrease": 0,
          "severities": {
            "categorizer-errors": "block",
            "categorizer-warnings": "warn",
            "llm-placements": "warn",
            "more-external-calls": "block",
            "new-violations": "block",
            "now-failing": "block",
            "slower": "warn",
            "uncommitted": "warn",
          },
        },
        "notJson": [
          "runshape.json isn't JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)",
        ],
        "problems": [
          "check.gate isn't a setting: rules, allowedExternalCallIncrease",
          "check.rules.now-faling isn't a rule: now-failing, new-violations, categorizer-errors, categorizer-warnings, llm-placements, more-external-calls, slower, uncommitted",
          "check.rules.new-violations is "never": block, warn or off",
          "check.allowedExternalCallIncrease must be a whole number, 0 or more",
        ],
        "slower": "warn",
      }
    `);
  });
});

class MemoryChecks implements KeptChecks {
  saved: unknown = null;
  ok: unknown = null;
  readonly shownLast = ".runshape/checks/last.json";
  async last() {
    return this.saved;
  }
  async saveLast(result: unknown) {
    this.saved = JSON.parse(JSON.stringify(result));
  }
  async bypass() {
    return this.ok;
  }
  async saveBypass(bypass: unknown) {
    this.ok = bypass;
  }
}

class KeepingLogger implements Logger {
  readonly lines: string[] = [];
  log(level: LogLevel, event: string, fields: LogFields = {}) {
    this.lines.push(`${level} ${event} ${Object.entries(fields).filter(([key]) => key !== "duration_ms" && key !== "stack").map(([key, value]) => `${key}=${value}`).join(" ")}`);
  }
  with(): Logger {
    return this;
  }
}

/** A workflow over one comparison: what `compare` returns (or throws), and each recording's runshape.json. */
function checking(compared: ReviewBundle | Error, rules: { base: string | null; head: string | null }, working = { commit: HEAD_COMMIT, dirty: false }) {
  const comparer: Comparer = {
    async compare() {
      if (compared instanceof Error) throw compared;
      return { review: { bundle: compared, name: "aaaaaaaaaaaa..working" }, base: { id: "aaaaaaaaaaaa" }, head: { id: "working" } };
    },
  };
  const recordings = { keptRules: async (id: string) => (id === "working" ? rules.head : rules.base) } as unknown as KeptRecordings;
  const repository = {
    mergedBranch: async () => "main",
    resolve: async () => ({ commit: working.commit }),
    workingTree: async () => ({ branch: "agent", ...working }),
  } as unknown as Repository;
  const checks = new MemoryChecks();
  const logger = new KeepingLogger();
  return { checks, logger, workflow: new Checking(comparer, recordings, checks, repository, logger, () => new Date("2026-11-01T10:00:00Z")) };
}

describe("Checking", () => {
  test("a review that can't be made blocks, and is kept and logged like any other result", async () => {
    const { checks, logger, workflow } = checking(new Error("recording the working tree (agent) failed: vitest exited 1"), { base: null, head: null });
    const result = await workflow.check("main", "working", { gate: true });
    expect({ text: checkText(result, checks.shownLast), saved: (checks.saved as CheckResult).passed, log: logger.lines }).toMatchInlineSnapshot(`
      {
        "log": [
          "error check.review_not_made error=recording the working tree (agent) failed: vitest exited 1",
          "warn check.done head=2222222222222222222222222222222222222222 review=null passed=false blocking=1 warnings=0 findings=review-not-made: main .. working",
        ],
        "saved": false,
        "text": [
          "check --gate: main (?) .. the working tree (2222222): 1 blocking, 0 warnings",
          "  BLOCK review-not-made: main .. working: recording the working tree (agent) failed: vitest exited 1",
          "rules: none: there was no review to check",
          "result: .runshape/checks/last.json",
          "Not ready for review. Fix what blocks, or tell the person exactly these findings;",
          "only with their OK: runshape check --bypass -- <who said it's fine, in their words>",
        ],
      }
    `);
  });

  test("the base's rules decide: a branch that loosens its own gate is still checked by main's, and told so", async () => {
    const strict = JSON.stringify({ check: { rules: { slower: "block" } } });
    const loose = JSON.stringify({ check: { rules: { slower: "off" } } });
    const { workflow } = checking(await bundleOf("fastapi-slug-refactor"), { base: strict, head: loose });
    const result = await workflow.check("main", "working", { gate: false });
    expect({ rulesFrom: result.rulesFrom, passed: result.passed, findings: shown(result.findings) }).toMatchInlineSnapshot(`
      {
        "findings": [
          "block slower: test_user_can_create_article: 10.6 ms → 25.3 ms (past both 10 ms and 50%; one recording a side)",
          "warn check-rules-changed: runshape.json: this branch changes the check's rules: they apply once it's merged; this check used the base's",
        ],
        "passed": false,
        "rulesFrom": "the base's runshape.json (111111111111)",
      }
    `);
  });

  test("an OK goes past exactly the findings the person was told, on exactly that commit", async () => {
    const breaks = await bundleOf("django-feed-fix", { reversed: true });
    const { checks, logger, workflow } = checking(breaks, { base: null, head: null });
    const refusedBeforeAnyCheck = await workflow.bypass("fine").catch((error: Error) => error.message);

    const failed = await workflow.check("main", "working", { gate: true });
    const recorded: CheckBypass = await workflow.bypass("  Jane: the xfail is the known feed bug, ticket 12  ");
    const passed = await workflow.check("main", "working", { gate: true });

    // The same OK, a commit later: checked afresh.
    const later = "3333333333333333333333333333333333333333";
    const elsewhere = checking(await bundleOf("django-feed-fix", { reversed: true, headCommit: later }), { base: null, head: null }, { commit: later, dirty: false });
    elsewhere.checks.ok = recorded;
    const anotherCommit = await elsewhere.workflow.check("main", "working", { gate: true });

    // The same commit, but a finding the person wasn't told about.
    const worse = await bundleOf("django-feed-fix", { reversed: true });
    worse.violations = [{ from: "ArticleViewSet", to: "Article", fromZone: "inbound-adapter", toZone: "outbound-adapter", calls: 2, violation: "a request handler using an outbound adapter directly" }];
    const unseen = checking(worse, { base: null, head: null });
    unseen.checks.ok = recorded;
    const aNewFinding = await unseen.workflow.check("main", "working", { gate: true });

    expect({
      refusedBeforeAnyCheck,
      failed: failed.passed,
      recorded: { head: recorded.head, ok: recorded.ok, findings: shown(recorded.findings) },
      passed: checkText(passed, checks.shownLast),
      anotherCommit: anotherCommit.passed,
      aNewFinding: aNewFinding.passed,
      log: logger.lines,
    }).toMatchInlineSnapshot(`
      {
        "aNewFinding": false,
        "anotherCommit": false,
        "failed": false,
        "log": [
          "warn check.done head=2222222222222222222222222222222222222222 review=aaaaaaaaaaaa..working passed=false blocking=1 warnings=1 findings=now-failing: test_follower_sees_followed_authors_in_their_feed",
          "warn check.bypass_recorded head=2222222222222222222222222222222222222222 findings=now-failing: test_follower_sees_followed_authors_in_their_feed",
          "warn check.bypassed head=2222222222222222222222222222222222222222 review=aaaaaaaaaaaa..working passed=true blocking=1 warnings=1 findings=now-failing: test_follower_sees_followed_authors_in_their_feed",
        ],
        "passed": [
          "check --gate: main (1111111) .. the working tree (2222222): 1 blocking, 1 warning",
          "  BLOCK now-failing: test_follower_sees_followed_authors_in_their_feed: passed before, xfailed now",
          "  warn  categorizer-warnings: conduit.apps.articles.views.ArticleViewSet.retrieve: io-outside-allowed-zones: does I/O itself in a zone its style keeps free of it",
          "rules: the defaults (the base has no runshape.json)",
          "result: .runshape/checks/last.json; review: .runshape/reviews/aaaaaaaaaaaa..working",
          "PASSED WITH A BYPASS: 1 blocking finding gone past with the OK given 2026-11-01T10:00:00.000Z: "Jane: the xfail is the known feed bug, ticket 12"",
          "For the PR body: Runshape check bypassed on 222222222222 (now-failing: test_follower_sees_followed_authors_in_their_feed). OK: "Jane: the xfail is the known feed bug, ticket 12"",
        ],
        "recorded": {
          "findings": [
            "block now-failing: test_follower_sees_followed_authors_in_their_feed: passed before, xfailed now",
          ],
          "head": "2222222222222222222222222222222222222222",
          "ok": "Jane: the xfail is the known feed bug, ticket 12",
        },
        "refusedBeforeAnyCheck": "there's no check to go past: run \`check\` first, and tell the person what it found",
      }
    `);
  });

  test("the exit code is the worst finding: 1 blocks, 2 only warns (0 under --gate, so the push goes), 0 for nothing", async () => {
    const warns = checking(await bundleOf("fastapi-slug-refactor"), { base: null, head: null }).workflow;
    const blocks = checking(await bundleOf("django-feed-fix", { reversed: true }), { base: null, head: null }).workflow;
    const quiet = checking(await bundleOf("fastapi-slug-refactor", { reversed: true }), { base: null, head: null }).workflow;
    expect({
      blocks: checkExitCode(await blocks.check("main", "working", { gate: false })),
      warns: checkExitCode(await warns.check("main", "working", { gate: false })),
      warnsUnderGate: checkExitCode(await warns.check("main", "working", { gate: true })),
      nothing: checkExitCode(await quiet.check("main", "working", { gate: false })),
    }).toEqual({ blocks: 1, warns: 2, warnsUnderGate: 0, nothing: 0 });
  });

  test("an OK is refused for a check that isn't of what's checked out, or that found nothing blocking", async () => {
    const dirty = checking(await bundleOf("django-feed-fix", { reversed: true }), { base: null, head: null }, { commit: HEAD_COMMIT, dirty: true });
    await dirty.workflow.check("main", "working", { gate: false });
    const clean = checking(await bundleOf("fastapi-slug-refactor"), { base: null, head: null });
    await clean.workflow.check("main", "working", { gate: false });
    expect({
      uncommitted: await dirty.workflow.bypass("fine").catch((error: Error) => error.message),
      nothingBlocks: await clean.workflow.bypass("fine").catch((error: Error) => error.message),
    }).toMatchInlineSnapshot(`
      {
        "nothingBlocks": "the last check found nothing blocking: there's nothing to go past",
        "uncommitted": "the last check (222222222222) isn't of what's checked out (222222222222, with uncommitted changes): commit, run \`check\` again, and tell the person what it found",
      }
    `);
  });
});
