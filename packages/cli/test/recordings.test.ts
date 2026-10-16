/**
 * `npm run runshape -- <command>`: record commits once each, see what's recorded and what
 * could be, and get a link that compares any two.
 *
 *   list                        what's recorded, and which branch tips aren't yet
 *   record <ref>... [--fetch]   record commits ("working" is the working tree); --fetch first
 *                               fetches the branch from origin and records origin's tip
 *   compare <base> [<head>]     record whatever of the two isn't yet (head: the working
 *                               tree), and print the demo link that compares them
 *   forget <id>                 delete a recording
 *
 * A real git repository per test; the recorder is the one thing faked: it writes a real
 * fixture recording (go-shop's, five tests) instead of running vitest for a minute.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { LanguageModel } from "@runshape/core";
import { PullRequestSummary, Recorder, RecordTarget, runRecordings } from "../src/recordings";
import { commitIn, gitIn, repository } from "@runshape/library/test/repository";

const FIXTURE = join(import.meta.dirname, "..", "..", "trace", "test", "fixtures", "go-shop");
const NOW = new Date("2026-10-14T12:00:00Z");
/** Above any pid the OS hands out (macOS and Linux cap well below it). */
const DEAD_PID = 99_999_999;

class FixtureRecorder implements Recorder {
  readonly recorded: string[] = [];
  constructor(
    private readonly fails = false,
    readonly environment = "host",
  ) {}

  async record(target: RecordTarget, outDirectory: string): Promise<void> {
    this.recorded.push(target.kind === "working" ? "working" : target.commit.slice(0, 7));
    if (this.fails) throw new Error("vitest crashed");
    cpSync(FIXTURE, outDirectory, { recursive: true });
  }
}

/** A language model that answers every prompt the same way, and remembers what it was asked. */
class FakeModel implements LanguageModel {
  readonly name: string = "fake-model";
  readonly available = true;
  readonly prompts: string[] = [];
  constructor(private readonly answer: string | Error = JSON.stringify({ summary: "Second, explained.", reasons: [], unexplained: [], questions: [] })) {}
  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

async function run(
  root: string,
  argv: string[],
  recorder = new FixtureRecorder(),
  model = new FakeModel(),
  sandbox = new FixtureRecorder(false, "docker:runshape-recorder:test"),
  requested: PullRequestSummary[] = [],
) {
  const lines: string[] = [];
  const chosen: string[] = [];
  const models = async (choice: string) => {
    chosen.push(choice);
    return model;
  };
  const pullRequests = { requestingMyReview: async () => requested, repository: async () => "origin" };
  const code = await runRecordings(argv, { root, recorder, sandbox: () => sandbox, print: (line) => lines.push(line), now: () => NOW, models, pullRequests });
  return { code, lines, recorder, model, chosen, sandbox };
}

const metadataOf = (root: string, id: string) => JSON.parse(readFileSync(join(root, ".runshape", "recordings", id, "recording.json"), "utf8"));

describe("runshape record", () => {
  test("records a commit once, under its hash, with what it recorded; again, it's already there", async () => {
    const { root, commits } = repository();
    const id = commits.second!.slice(0, 12);

    const first = await run(root, ["record", "main"]);
    const again = await run(root, ["record", "main"]);

    expect({ first: first.lines, again: again.lines, recorderCalls: [first.recorder.recorded, again.recorder.recorded] }).toEqual({
      first: [`recording main (${id} Second)…`, `recorded ${id}: 5 tests, 0 failed`],
      again: [`main (${id} Second) is recorded already; record it again with --again`],
      recorderCalls: [[commits.second!.slice(0, 7)], []],
    });
    expect(metadataOf(root, id)).toEqual({
      id,
      commit: commits.second,
      subject: "Second",
      committedAt: "2026-10-01T10:00:00Z",
      branch: null,
      dirty: false,
      recordedAt: NOW.toISOString(),
      recorder: "recorder-go 0.1.0",
      recorderSource: expect.stringMatching(/^[0-9a-f]{16}$/),
      environment: "host",
      tests: { total: 5, failed: 0 },
      // No runshape.json at that commit: every zone inferred, in the default style.
      architecture: { style: "hexagonal", rules: 0, declared: 0, inferred: 9, problem: null },
    });
    // A recording directory is itself a traces directory: runshape-review-md and the extension read it.
    expect(readFileSync(join(root, ".runshape", "recordings", id, "latest.json"), "utf8")).toBe('{"run":"run"}');
  });

  test("the working tree records as 'working', with its branch and whether it has uncommitted changes, replaced each time", async () => {
    const { root, commits } = repository();
    writeFileSync(join(root, "file.txt"), "not committed yet");

    const { lines } = await run(root, ["record", "working"]);
    const twice = await run(root, ["record", "working"]);

    expect({ lines, again: twice.lines.at(-1), recorderCalls: twice.recorder.recorded }).toEqual({
      lines: ["recording the working tree (feature, with uncommitted changes)…", "recorded working: 5 tests, 0 failed"],
      again: "recorded working: 5 tests, 0 failed",
      recorderCalls: ["working"],
    });
    expect(metadataOf(root, "working")).toMatchObject({ id: "working", commit: commits.third, branch: "feature", dirty: true });
  });

  test("--fetch records the remote's newest tip, without touching local branches", async () => {
    const { root, commits } = repository();
    const origin = join(mkdtempSync(join(tmpdir(), "runshape-origin-")), "origin");
    gitIn(root)("clone", "--quiet", "--branch", "main", root, origin);
    const upstream = commitIn(origin, "Merged upstream");
    gitIn(root)("remote", "add", "origin", origin);

    const { lines } = await run(root, ["record", "main", "--fetch"]);

    expect(lines).toEqual([
      "fetching main from origin…",
      `recording origin/main (${upstream.slice(0, 12)} Merged upstream)…`,
      `recorded ${upstream.slice(0, 12)}: 5 tests, 0 failed`,
    ]);
    expect(gitIn(root)("rev-parse", "main")).toBe(commits.second);
  });

  test("--fetch records what it fetched, even beside a local branch named like the remote one", async () => {
    const { root, commits } = repository();
    const origin = join(mkdtempSync(join(tmpdir(), "runshape-origin-")), "origin");
    gitIn(root)("clone", "--quiet", "--branch", "main", root, origin);
    const upstream = commitIn(origin, "Merged upstream");
    gitIn(root)("remote", "add", "origin", origin);
    gitIn(root)("branch", "origin/main", commits.first!); // an easy accident: git checkout -b origin/main

    const { lines } = await run(root, ["record", "main", "--fetch"]);

    expect(lines.at(-1)).toBe(`recorded ${upstream.slice(0, 12)}: 5 tests, 0 failed`);
  });

  test("a recording that fails leaves nothing behind, and says why", async () => {
    const { root, commits } = repository();

    const { code, lines } = await run(root, ["record", "main"], new FixtureRecorder(true));

    expect({ code, last: lines.at(-1), left: existsSync(join(root, ".runshape", "recordings")) ? readdirSync(join(root, ".runshape", "recordings")) : [] }).toEqual({
      code: 1,
      last: `runshape: recording main (${commits.second!.slice(0, 12)} Second) failed: vitest crashed`,
      left: [],
    });
  });

  test("a ref git doesn't know is refused before anything runs", async () => {
    const { root } = repository();

    const { code, lines, recorder } = await run(root, ["record", "nope"]);

    expect({ code, lines, recorded: recorder.recorded }).toEqual({ code: 1, lines: ["runshape: git doesn't know nope"], recorded: [] });
  });
});

/** Rules for the fixture recording's names (go-shop): two of its packages declared. */
const GO_SHOP_RULES = `${JSON.stringify(
  {
    version: 2,
    style: "hexagonal",
    zones: [
      { match: "example\\.com.shop.internal.orders.**", zone: "core", reason: "the order rules", by: "user" },
      { match: "example\\.com.shop.internal.storage.**", zone: "outbound-adapter", reason: "stores orders", by: "llm" },
    ],
  },
  null,
  2,
)}\n`;

function commitFile(root: string, file: string, text: string, subject: string): string {
  writeFileSync(join(root, file), text);
  gitIn(root)("add", file);
  gitIn(root)("commit", "--quiet", "-m", subject);
  return gitIn(root)("rev-parse", "HEAD");
}

const recordingFile = (root: string, id: string, file: string) => readFileSync(join(root, ".runshape", "recordings", id, file), "utf8");

describe("each recording keeps its commit's architecture", () => {
  // The user's decision (2026-10-16): zones are committed with the code and approved with it,
  // so each commit is drawn with its own runshape.json, and what it placed where is kept for
  // a person to read.
  test("a commit's runshape.json is kept as it was, with every class's place and who decided it", async () => {
    const { root } = repository();
    gitIn(root)("checkout", "--quiet", "main"); // commits on main are yours: recorded here
    const commit = commitFile(root, "runshape.json", GO_SHOP_RULES, "Declare the shop's zones");
    const id = commit.slice(0, 12);

    await run(root, ["record", "HEAD"]);

    const architecture = JSON.parse(recordingFile(root, id, "architecture.json"));
    expect({
      rulesFile: recordingFile(root, id, "runshape.json"),
      summary: metadataOf(root, id).architecture,
      placed: architecture.placements.map((p: { component: string; zone: string; decidedBy: string | null }) => `${p.component}: ${p.zone} (${p.decidedBy ?? "inferred"})`),
    }).toEqual({
      rulesFile: GO_SHOP_RULES,
      summary: { style: "hexagonal", rules: 2, declared: 5, inferred: 4, problem: null },
      placed: [
        "example\\.com.shop.internal.app: core (inferred)",
        "example\\.com.shop.internal.orders: core (user)",
        "example\\.com.shop.internal.orders.Order: core (user)",
        "example\\.com.shop.internal.orders.Service: core (user)",
        "example\\.com.shop.internal.storage: outbound-adapter (llm)",
        "example\\.com.shop.internal.storage.MemoryRepository: outbound-adapter (llm)",
        "example\\.com.shop.internal.web: core (inferred)",
        "example\\.com.shop.internal.web.Handler: inbound-adapter (inferred)",
        "example\\.com.shop.internal.web.statusRecorder: core (inferred)",
      ],
    });
  });

  test("a commit is drawn with its own runshape.json, whatever is on disk now", async () => {
    // Declared, then deleted: the older commit still had its rules, the newer has none; and
    // the working tree's file (uncommitted here) belongs to neither commit.
    const { root } = repository();
    gitIn(root)("checkout", "--quiet", "main");
    const declared = commitFile(root, "runshape.json", GO_SHOP_RULES, "Declare the shop's zones").slice(0, 12);
    gitIn(root)("rm", "--quiet", "runshape.json");
    gitIn(root)("commit", "--quiet", "-m", "Drop the zones");
    const dropped = gitIn(root)("rev-parse", "HEAD").slice(0, 12);
    writeFileSync(join(root, "runshape.json"), "{ broken on disk");

    await run(root, ["record", declared, dropped]);

    expect([metadataOf(root, declared).architecture, metadataOf(root, dropped).architecture]).toEqual([
      { style: "hexagonal", rules: 2, declared: 5, inferred: 4, problem: null },
      { style: "hexagonal", rules: 0, declared: 0, inferred: 9, problem: null },
    ]);
  });

  test("a runshape.json that isn't a plain file in the commit (a directory, say) is reported, not read", async () => {
    const { root } = repository();
    gitIn(root)("checkout", "--quiet", "main");
    mkdirSync(join(root, "runshape.json"));
    const commit = commitFile(root, "runshape.json/inside.txt", "a", "A directory where the zones would be").slice(0, 12);

    const { lines } = await run(root, ["record", "HEAD"]);

    expect({ said: lines[1], kept: existsSync(join(root, ".runshape", "recordings", commit, "runshape.json")) }).toEqual({
      said: `runshape.json at HEAD (${commit} A directory where the zones would be) is invalid, so every zone is inferred: it is a tree in the commit, not a file`,
      kept: false,
    });
  });

  test("the working tree's runshape.json is the file on disk, edits not committed yet included (a byte-order mark too)", async () => {
    const { root } = repository();
    writeFileSync(join(root, "runshape.json"), `\uFEFF${GO_SHOP_RULES}`);

    await run(root, ["record", "working"]);

    expect(metadataOf(root, "working").architecture).toEqual({ style: "hexagonal", rules: 2, declared: 5, inferred: 4, problem: null });
  });

  test("an invalid runshape.json is kept and reported, the code recorded anyway with every zone inferred", async () => {
    const { root } = repository();
    gitIn(root)("checkout", "--quiet", "main");
    const commit = commitFile(root, "runshape.json", '{"version": 2, "zones": [{"match": "x"}]}', "Break the zones");
    const id = commit.slice(0, 12);

    const { lines } = await run(root, ["record", "HEAD"]);

    expect({ said: lines[1], summary: metadataOf(root, id).architecture, kept: existsSync(join(root, ".runshape", "recordings", id, "runshape.json")) }).toEqual({
      said: `runshape.json at HEAD (${id} Break the zones) is invalid, so every zone is inferred: zones[0].zone must be one of inbound-adapter, core, outbound-adapter (the hexagonal zones); zones[0].reason must say why`,
      summary: {
        style: "hexagonal",
        rules: 0,
        declared: 0,
        inferred: 9,
        problem: "zones[0].zone must be one of inbound-adapter, core, outbound-adapter (the hexagonal zones); zones[0].reason must say why",
      },
      kept: true,
    });
  });
});

describe("runshape compare", () => {
  test("main moved on since the branch left it: the base is where it left, not main's newest commit", async () => {
    // Otherwise every change merged to main since would read as this branch undoing it.
    const { root, commits } = repository();
    gitIn(root)("checkout", "--quiet", "main");
    const moved = commitIn(root, "Someone else's change, merged to main");
    gitIn(root)("checkout", "--quiet", "feature");

    const fromFork = await run(root, ["compare", "main"]);
    const fromTip = await run(root, ["compare", "main", "--tip"]);

    expect({ fork: fromFork.lines.slice(0, 2), forkLink: fromFork.lines.at(-1), tipLink: fromTip.lines.at(-1) }).toEqual({
      fork: [
        `main is 1 commit past where this branch left it: comparing with ${commits.second!.slice(0, 12)} (Second), where it left; --tip compares with main itself`,
        `recording main's fork point (${commits.second!.slice(0, 12)} Second)…`,
      ],
      forkLink: `open http://localhost:5173/demo/index.html?base=${commits.second!.slice(0, 12)}&head=working (npm run dev -w packages/webview)`,
      tipLink: `open http://localhost:5173/demo/index.html?base=${moved.slice(0, 12)}&head=working (npm run dev -w packages/webview)`,
    });
  });

  test("a comparison is saved as a review: JSON for tools, Markdown to read or post", async () => {
    const { root, commits } = repository();
    const base = commits.second!.slice(0, 12);

    const { lines } = await run(root, ["compare", "main"]);

    const directory = join(root, ".runshape", "reviews", `${base}..working`);
    const bundle = JSON.parse(readFileSync(join(directory, "review.json"), "utf8"));
    expect({
      said: lines.at(-2),
      bundle: `${bundle.format} v${bundle.version}: ${bundle.base.asked} ${bundle.base.recording} -> ${bundle.head.asked} ${bundle.head.recording}, rules known ${bundle.baseRulesKnown}`,
      markdown: readFileSync(join(directory, "review.md"), "utf8").split("\n")[0],
    }).toEqual({
      said: `review: ${join(".runshape", "reviews", `${base}..working`, "review.md")}`,
      bundle: `runshape-review v1: main ${base} -> working working, rules known true`,
      markdown: "## Behaviour changes (Runshape)",
    });
  });

  test("a head recorded before zones were kept: the bundle says the base's rules aren't known", async () => {
    const { root, commits } = repository();
    const head = commits.second!.slice(0, 12);
    await run(root, ["record", "main"]);
    const file = join(root, ".runshape", "recordings", head, "recording.json");
    const { architecture: _dropped, ...older } = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify(older));

    await run(root, ["compare", "main~1", "main"]);

    const bundle = JSON.parse(readFileSync(join(root, ".runshape", "reviews", `${commits.first!.slice(0, 12)}..${head}`, "review.json"), "utf8"));
    expect(bundle.baseRulesKnown).toBe(false);
  });

  test("no fork point to measure from (unrelated history, or a shallow clone) is refused, not quietly the tip (second-model review)", async () => {
    // CI checks out one commit by default: falling back to main's tip there would bring back
    // exactly what the fork point is for.
    const { root } = repository();
    gitIn(root)("checkout", "--quiet", "--orphan", "elsewhere");
    commitIn(root, "Unrelated history");

    const { code, lines, recorder } = await run(root, ["compare", "main"]);

    expect({ code, lines, recorded: recorder.recorded }).toEqual({
      code: 1,
      lines: [
        "runshape: can't find where this branch left main: they share no history here (in a shallow clone, fetch it: git fetch --unshallow, or fetch-depth: 0 in CI); --tip compares with main's newest commit",
      ],
      recorded: [],
    });
  });

  test("a branch already merged into the base says so, rather than 'the same recording'", async () => {
    const { root } = repository();
    gitIn(root)("checkout", "--quiet", "main");
    gitIn(root)("merge", "--quiet", "--ff-only", "feature");
    commitIn(root, "After the merge");

    const { code, lines } = await run(root, ["compare", "main", "feature"]);

    expect({ code, lines }).toEqual({ code: 1, lines: ["runshape: feature is already in main: nothing of its own to compare (--tip compares it with main's newest commit)"] });
  });

  test("the bundle says where the base came from and whether the working tree had uncommitted changes", async () => {
    const { root, commits } = repository();
    gitIn(root)("checkout", "--quiet", "main");
    const tip = commitIn(root, "Main moved on");
    gitIn(root)("checkout", "--quiet", "feature");
    writeFileSync(join(root, "file.txt"), "not committed");

    await run(root, ["compare", "main"]);

    const bundle = JSON.parse(readFileSync(join(root, ".runshape", "reviews", `${commits.second!.slice(0, 12)}..working`, "review.json"), "utf8"));
    expect({ forkOf: bundle.base.forkOf, dirty: bundle.head.dirty }).toEqual({ forkOf: { tip, commitsSince: 1 }, dirty: true });
  });

  test("a kept recording whose runshape.json no longer reads is compared without its rules, with a warning, not a crash", async () => {
    const { root, commits } = repository();
    const base = commits.second!.slice(0, 12);
    await run(root, ["record", "main"]);
    writeFileSync(join(root, ".runshape", "recordings", base, "runshape.json"), "{ not json");

    const { code, lines } = await run(root, ["compare", "main"]);

    expect({ code, warned: lines.find((line) => line.includes("can't be read")) }).toEqual({
      code: 0,
      warned: `runshape.json kept with recording ${base} can't be read, so it's compared without rules: runshape.json is invalid:\n  - not valid JSON: Expected property name or '}' in JSON at position 2 (line 1 column 3)`,
    });
  });

  test("comparing a recording with itself is refused before anything is recorded", async () => {
    const { root } = repository();

    const same = [await run(root, ["compare", "working", "working"]), await run(root, ["compare", "main", "main"])];

    expect(same.map(({ code, lines, recorder }) => ({ code, lines, recorded: recorder.recorded }))).toEqual([
      { code: 1, lines: ["runshape: working and working are the same recording: nothing to compare"], recorded: [] },
      { code: 1, lines: ["runshape: main and main are the same recording: nothing to compare"], recorded: [] },
    ]);
  });

  test("a base recorded by another version of the recorder is recorded again, so only the code differs", async () => {
    // A cached base and a fresh head recorded by different recorders would show the
    // recorder's change as the branch's.
    const { root, commits } = repository();
    await run(root, ["record", "main"]);
    mkdirSync(join(root, "recorder-ts"));
    writeFileSync(join(root, "recorder-ts", "runtime.ts"), "changed");

    const { lines, recorder } = await run(root, ["compare", "main"]);

    expect({ recorded: recorder.recorded, first: lines[0] }).toEqual({
      recorded: [commits.second!.slice(0, 7), "working"],
      first: `main (${commits.second!.slice(0, 12)} Second) was recorded by another version of recorder-ts: recording it again`,
    });
  });


  test("records what's missing, then links the two: by default against the working tree", async () => {
    const { root, commits } = repository();
    const main = commits.second!.slice(0, 12);
    await run(root, ["record", "main"]);

    const { lines, recorder } = await run(root, ["compare", "main"]);

    expect({ recorded: recorder.recorded, link: lines.at(-1) }).toEqual({
      recorded: ["working"],
      link: `open http://localhost:5173/demo/index.html?base=${main}&head=working (npm run dev -w packages/webview)`,
    });
  });
});

describe("--sandbox: commits recorded in a container", () => {
  // Someone else's code, or an agent's, recorded unattended: docker-recorder.ts says what the
  // container gets. Here, which recordings go there and what that means for comparing.
  test("a commit recorded in the sandbox is a recording of its own, beside one made here: neither replaces the other", async () => {
    // One id per commit made each run flip it between the two places, re-recording it each time.
    const { root, commits } = repository();
    const id = commits.second!.slice(0, 12);

    const sandboxed = await run(root, ["record", "main", "--sandbox"]);
    const here = await run(root, ["record", "main"]);
    const again = await run(root, ["record", "main", "--sandbox"]);

    expect({
      sandbox: sandboxed.sandbox.recorded,
      host: here.recorder.recorded,
      againRecorded: again.sandbox.recorded,
      environments: [metadataOf(root, `${id}-sandbox`).environment, metadataOf(root, id).environment],
    }).toEqual({ sandbox: [commits.second!.slice(0, 7)], host: [commits.second!.slice(0, 7)], againRecorded: [], environments: ["docker:runshape-recorder:test", "host"] });
  });

  test("a pull request's head is compared in the sandbox even when --sandbox isn't said (second-model review)", async () => {
    // After the night's run, comparing a PR's ref by hand mustn't run its code on this machine.
    const { root, commits } = repository();
    gitIn(root)("update-ref", "refs/runshape/pr/7", commits.third!);

    const { recorder, sandbox, lines } = await run(root, ["compare", "main", "refs/runshape/pr/7"]);

    expect({ host: recorder.recorded, sandbox: sandbox.recorded, said: lines[0] }).toEqual({
      host: [],
      sandbox: [commits.second!.slice(0, 7), commits.third!.slice(0, 7)],
      said: "refs/runshape/pr/7 isn't on main (it may be someone else's code): recording in the sandbox",
    });
  });

  test("a commit not on main is sandboxed however it's named or used: recorded alone, as a base, by its hash, as a fetched branch (reviews 2 and 3)", async () => {
    // Yours means merged: your default branch holds it (main, here or on origin). Branches,
    // tags, other remotes and PR bases can all be someone else's, so they don't count.
    const { root, commits } = repository();
    gitIn(root)("checkout", "--quiet", "--detach", commits.third!);
    const theirs = commitIn(root, "A teammate's change, only in their PR");
    gitIn(root)("checkout", "--quiet", "feature");
    gitIn(root)("update-ref", "refs/runshape/pr/7", theirs);
    // A teammate's branch, fetched: on the remote, but not its default branch.
    gitIn(root)("update-ref", "refs/remotes/origin/their-branch", theirs);

    const results = {
      record: await run(root, ["record", "refs/runshape/pr/7"]),
      asBase: await run(root, ["compare", "refs/runshape/pr/7", "main", "--tip"]),
      byHash: await run(root, ["compare", "main", theirs]),
      theirBranch: await run(root, ["compare", "main", "origin/their-branch"]),
      againstWorking: await run(root, ["compare", theirs]),
    };

    expect({
      host: Object.values(results).flatMap((r) => r.recorder.recorded).filter((c) => c === theirs.slice(0, 7)),
      // The first records it in the sandbox; the others reuse that recording, in the sandbox too.
      sandboxed: Object.entries(results).filter(([, r]) => r.lines.some((line) => line.endsWith(": recording in the sandbox"))).map(([name]) => name),
      againstWorking: [results.againstWorking.code, results.againstWorking.lines.at(-1)],
    }).toEqual({
      host: [],
      sandboxed: ["record", "asBase", "byHash", "theirBranch"],
      // Its fork point with the working tree (feature, not merged) isn't on main either.
      againstWorking: [1, `runshape: ${theirs}'s fork point isn't on main (it may be someone else's code): it's recorded in the sandbox, so compare it with a commit, not the working tree`],
    });
  });

  test("the third review's ways round it: a fetch's new commit, a teammate's remote and its HEAD, a planted tag, a stacked PR's base, a checked-out PR", async () => {
    const { root, commits } = repository();
    const origin = join(mkdtempSync(join(tmpdir(), "runshape-origin-")), "origin");
    gitIn(root)("clone", "--quiet", "--branch", "feature", root, origin);
    const pushed = commitIn(origin, "Pushed to origin/feature by a teammate");
    gitIn(root)("remote", "add", "origin", origin);
    const alice = join(mkdtempSync(join(tmpdir(), "runshape-alice-")), "alice");
    gitIn(root)("clone", "--quiet", "--branch", "feature", root, alice);
    gitIn(alice)("checkout", "--quiet", "-b", "wip");
    commitIn(alice, "Alice's work in progress");
    gitIn(root)("remote", "add", "alice", alice);
    gitIn(root)("fetch", "--quiet", "alice"); // git 2.48+: makes refs/remotes/alice/HEAD, pointing where alice says
    gitIn(root)("symbolic-ref", "refs/remotes/alice/HEAD", "refs/remotes/alice/wip");
    gitIn(root)("tag", "v9", commits.third!);
    gitIn(root)("update-ref", "refs/runshape/base/attacker-a", commits.third!);

    const host = async (argv: string[]) => (await run(root, argv)).recorder.recorded;
    const recordedHere = {
      fetchedFeature: await host(["record", "feature", "--fetch"]),
      aliceHead: await host(["compare", "main", "alice/wip"]),
      tag: await host(["compare", "main", "v9"]),
      stackedBase: await host(["compare", "main", "refs/runshape/base/attacker-a"]),
    };
    gitIn(root)("update-ref", "refs/runshape/pr/9", commits.third!);
    gitIn(root)("checkout", "--quiet", "--detach", "refs/runshape/pr/9");
    const checkedOut = await run(root, ["compare", "main"]);
    // As gh pr checkout leaves a fork's PR: a branch whose upstream is GitHub's PR ref.
    gitIn(root)("checkout", "--quiet", "-b", "pr-12-branch", commits.third!);
    gitIn(root)("config", "branch.pr-12-branch.merge", "refs/pull/12/head");
    const ghCheckout = await run(root, ["compare", "main"]);

    expect({
      recordedHere,
      pushedAnywhere: pushed.length > 0,
      checkedOut: [checkedOut.code, checkedOut.recorder.recorded, checkedOut.lines.at(-1)],
      ghCheckout: [ghCheckout.code, ghCheckout.recorder.recorded],
    }).toEqual({
      recordedHere: { fetchedFeature: [], aliceHead: [], tag: [], stackedBase: [] },
      pushedAnywhere: true,
      checkedOut: [1, [], "runshape: the working tree is a pull request you checked out (refs/runshape/pr/9): its tests would run here; compare its commit instead, which is recorded in the sandbox"],
      ghCheckout: [1, []],
    });
  });

  test("a fork point recorded in the sandbox is a sandbox recording too: a later compare here isn't refused", async () => {
    const { root, commits } = repository();
    gitIn(root)("checkout", "--quiet", "main");
    commitIn(root, "Main moved on");
    gitIn(root)("checkout", "--quiet", "feature");

    await run(root, ["compare", "main", "feature", "--sandbox"]);
    const here = await run(root, ["compare", "main", "feature"]);

    expect({ sandboxIds: existsSync(join(root, ".runshape", "recordings", `${commits.second!.slice(0, 12)}-sandbox`)), hereCode: here.code }).toEqual({ sandboxIds: true, hereCode: 0 });
  });

  test("a recording made in the sandbox before sandboxed ones had their own id is kept as one, and yours is recorded here", async () => {
    // Its commit is yours (your branch holds it), so recording it here is safe; the sandbox's
    // recording stays, as the sandbox's.
    const { root, commits } = repository();
    const id = commits.second!.slice(0, 12);
    await run(root, ["record", "main"]);
    const file = join(root, ".runshape", "recordings", id, "recording.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), environment: "docker:runshape-recorder:old" }));

    const { code, recorder, lines } = await run(root, ["compare", "main~1", "main"]);

    expect({ code, host: recorder.recorded, said: lines.find((line) => line.includes("recorded in the sandbox before")), environments: [metadataOf(root, id).environment, metadataOf(root, `${id}-sandbox`).environment] }).toEqual({
      code: 0,
      host: [commits.first!.slice(0, 7), commits.second!.slice(0, 7)],
      said: `main (${id} Second) was recorded in the sandbox before; that's kept as ${id}-sandbox, and it's recorded here too`,
      environments: ["host", "docker:runshape-recorder:old"],
    });
  });

  test("--sandbox compares and records commits: the working tree is yours, recorded on this machine", async () => {
    const { root } = repository();

    const results = [await run(root, ["compare", "main", "--sandbox"]), await run(root, ["record", "working", "--sandbox"])];

    expect(results.map(({ code, lines }) => [code, lines[0]])).toEqual([
      [1, "runshape: --sandbox compares commits: name the head (the working tree is yours, recorded on this machine without it)"],
      [1, "runshape: --sandbox records commits: the working tree is yours, recorded on this machine without it"],
    ]);
  });
});

describe("runshape review-requests: every open PR that asks for your review", () => {
  // Case 1: a lead's morning. Each PR's head (GitHub's refs/pull/<n>/head) is compared with
  // where it left its base, recorded in the sandbox: it's someone else's code.
  function withPullRequests() {
    const { root, commits } = repository();
    const origin = join(mkdtempSync(join(tmpdir(), "runshape-origin-")), "origin");
    gitIn(root)("clone", "--quiet", "--branch", "main", root, origin);
    gitIn(origin)("checkout", "--quiet", "-b", "pr-work");
    const prHead = commitIn(origin, "A teammate's change");
    gitIn(origin)("update-ref", "refs/pull/7/head", prHead);
    gitIn(root)("remote", "add", "origin", origin);
    const pr = (number: number, headRefOid: string, title: string): PullRequestSummary => ({
      number,
      title,
      url: `https://github.com/example/shop/pull/${number}`,
      author: "teammate",
      baseRefName: "main",
      headRefName: `pr-${number}`,
      headRefOid,
      isCrossRepository: false,
      updatedAt: "2026-10-16T02:00:00Z",
    });
    return { root, commits, prHead, pr };
  }

  test("each PR recorded in the sandbox and reviewed against where it left its base; one that fails doesn't stop the rest", async () => {
    const { root, commits, prHead, pr } = withPullRequests();
    const requested = [pr(7, prHead, "Teach orders to refuse"), pr(8, "0".repeat(40), "A PR whose head is gone")];

    const { code, lines, recorder, sandbox } = await run(root, ["review-requests"], new FixtureRecorder(), new FakeModel(), new FixtureRecorder(false, "docker:runshape-recorder:test"), requested);

    const index = JSON.parse(readFileSync(join(root, ".runshape", "reviews", "requested.json"), "utf8"));
    expect({
      code,
      host: recorder.recorded,
      sandbox: sandbox.recorded,
      // The failure's line goes on with git's reason ("couldn't find remote ref refs/pull/8/head").
      summary: lines.filter((line) => line.startsWith("#")).map((line) => line.split(": ").slice(0, 3).join(": ")),
      index: index.pullRequests.map((entry: { number: number; head: string; review: string | null; problem: string | null }) => ({
        number: entry.number,
        head: entry.head.slice(0, 7),
        review: entry.review,
        problem: entry.problem?.split(":")[0] ?? null,
      })),
    }).toEqual({
      code: 1,
      host: [],
      sandbox: [commits.second!.slice(0, 7), prHead.slice(0, 7)],
      summary: [`#7 Teach orders to refuse: reviewed`, `#8 A PR whose head is gone: failed: fetching it failed`],
      index: [
        { number: 7, head: prHead.slice(0, 7), review: `${commits.second!.slice(0, 12)}-sandbox..${prHead.slice(0, 12)}-sandbox`, problem: null },
        { number: 8, head: "0000000", review: null, problem: "fetching it failed" },
      ],
    });
    const bundle = JSON.parse(readFileSync(join(root, ".runshape", "reviews", `${commits.second!.slice(0, 12)}-sandbox..${prHead.slice(0, 12)}-sandbox`, "review.json"), "utf8"));
    expect(bundle.head.asked).toBe("#7 Teach orders to refuse");
  });

  test("with --explain each review is explained too; with no PRs asking, it says so", async () => {
    const { root, prHead, pr } = withPullRequests();

    const explained = await run(root, ["review-requests", "--explain"], new FixtureRecorder(), new FakeModel(), new FixtureRecorder(false, "docker:runshape-recorder:test"), [pr(7, prHead, "Teach orders to refuse")]);
    const none = await run(root, ["review-requests"]);

    expect({ explained: explained.lines.filter((line) => line.startsWith("#")), asked: explained.model.prompts.length, none: none.lines }).toEqual({
      explained: ["#7 Teach orders to refuse: reviewed and explained"],
      asked: 1,
      none: ["No open pull requests are asking for your review."],
    });
  });
});

describe("runshape compare --explain", () => {
  // Explaining sends the review (names only) and the commit messages to a language model:
  // claude -p, the Anthropic API, or (in VS Code) the editor's. Never without being asked.
  test("explains the comparison from its commits, beside the review, and doesn't ask again for the same inputs", async () => {
    const { root, commits } = repository();
    gitIn(root)("checkout", "--quiet", "main");
    commitIn(root, "Main moved on");
    gitIn(root)("checkout", "--quiet", "feature");
    // feature isn't merged: compared in the sandbox, under the sandbox's ids.
    const reviewName = `${commits.second!.slice(0, 12)}-sandbox..${commits.third!.slice(0, 12)}-sandbox`;
    const directory = join(root, ".runshape", "reviews", reviewName);

    const first = await run(root, ["compare", "main", "feature", "--explain=claude"]);
    const again = await run(root, ["compare", "main", "feature", "--explain=claude"]);
    const unasked = await run(root, ["compare", "main", "feature"]);

    expect({
      said: first.lines.at(-1),
      chosen: first.chosen,
      askedAbout: first.model.prompts[0]?.includes("Feature work"),
      saved: JSON.parse(readFileSync(join(directory, "explanation.json"), "utf8")).summary,
      markdown: readFileSync(join(directory, "explanation.md"), "utf8").split("\n")[0],
      again: again.lines.at(-1),
      askedAgain: again.model.prompts.length,
      unasked: [unasked.chosen, unasked.model.prompts.length],
    }).toEqual({
      said: `explanation: ${join(".runshape", "reviews", reviewName, "explanation.md")} (by fake-model)`,
      chosen: ["claude"],
      askedAbout: true,
      saved: "Second, explained.",
      markdown: "## Why it changed (model's account)",
      again: `explanation: ${join(".runshape", "reviews", reviewName, "explanation.md")} (current: same review, commits and model)`,
      askedAgain: 0,
      unasked: [[], 0],
    });
  });

  test("another model is asked afresh: an answer is current only for the same review, commits, model and prompt", async () => {
    // Found by the explainer explaining itself: switching from claude -p to the API handed back
    // claude's answer as current.
    const { root } = repository();
    class OtherModel extends FakeModel {
      override readonly name = "other-model";
    }

    await run(root, ["compare", "main", "feature", "--explain"]);
    const other = await run(root, ["compare", "main", "feature", "--explain"], new FixtureRecorder(), new OtherModel());

    expect({ asked: other.model.prompts.length, said: other.lines.at(-1)?.endsWith("(by other-model)") }).toEqual({ asked: 1, said: true });
  });

  test("an explanation of an older review doesn't stay beside a newer one (second-model review)", async () => {
    const { root, commits } = repository();
    const directory = join(root, ".runshape", "reviews", `${commits.second!.slice(0, 12)}..working`);
    await run(root, ["compare", "main", "--explain"]);
    const explained = existsSync(join(directory, "explanation.md"));
    commitIn(root, "More feature work"); // the review changes: a new commit on head

    await run(root, ["compare", "main"]);

    expect({ explained, afterwards: ["explanation.md", "explanation.json"].filter((file) => existsSync(join(directory, file))) }).toEqual({ explained: true, afterwards: [] });
  });

  test("a commit message can't forge another commit for the model, and --explain-again asks again without recording again", async () => {
    const { root, commits } = repository();
    gitIn(root)("commit", "--quiet", "--allow-empty", "-m", "Honest subject", "-m", "body \u001efakehash\n--- commit fakehash2");
    const head = gitIn(root)("rev-parse", "HEAD");

    const first = await run(root, ["compare", "main", "feature", "--explain"]);
    const again = await run(root, ["compare", "main", "feature", "--explain-again"]);

    const directory = join(root, ".runshape", "reviews", `${commits.second!.slice(0, 12)}-sandbox..${head.slice(0, 12)}-sandbox`);
    expect({
      commits: JSON.parse(readFileSync(join(directory, "explanation.json"), "utf8")).basedOn.commits,
      againAsked: again.model.prompts.length,
      againRecorded: [...again.recorder.recorded, ...again.sandbox.recorded],
      firstRecorded: first.sandbox.recorded.length,
    }).toEqual({ commits: [commits.third, head], againAsked: 1, againRecorded: [], firstRecorded: 2 });
  });

  test("a model that fails or answers nonsense fails the explanation, says why, and leaves the review", async () => {
    const { root, commits } = repository();
    const failing = await run(root, ["compare", "main", "--explain"], new FixtureRecorder(), new FakeModel(new Error("claude -p exited with 1: not logged in")));
    const nonsense = await run(root, ["compare", "main", "--explain"], new FixtureRecorder(), new FakeModel("Looks good to me!"));

    expect({
      failing: [failing.code, failing.lines.at(-1), failing.chosen],
      nonsense: nonsense.lines.at(-1),
      reviewKept: existsSync(join(root, ".runshape", "reviews", `${commits.second!.slice(0, 12)}..working`, "review.md")),
    }).toEqual({
      failing: [1, "runshape: explaining failed (the review is saved): claude -p exited with 1: not logged in", ["auto"]],
      nonsense: "runshape: explaining failed (the review is saved): the model's answer can't be used: the answer holds no JSON object",
      reviewKept: true,
    });
  });

  test("--explain takes claude or api, and only on compare", async () => {
    const { root } = repository();

    const results = [await run(root, ["compare", "main", "--explain=gpt"]), await run(root, ["record", "main", "--explain"])];

    expect(results.map(({ code, lines }) => [code, lines[0]])).toEqual([
      [1, "runshape: --explain takes claude or api (or nothing: claude -p if it runs, else the API)"],
      [1, "runshape: --explain only applies to compare and review-requests"],
    ]);
  });
});

describe("runshape list", () => {
  test("what's recorded, and what could be, with the command for each", async () => {
    const { root, commits } = repository();
    await run(root, ["record", "main"]);

    const { lines } = await run(root, ["list"]);

    expect(lines.join("\n")).toBe(
      [
        "Working tree: feature at " + commits.third!.slice(0, 7) + ", no uncommitted changes (not recorded: npm run runshape -- record working)",
        "",
        "Recorded (1):",
        `  ${commits.second!.slice(0, 12)}  main  Second  5 tests  hexagonal: no rules, 9 inferred  recorded 2026-10-14 12:00`,
        "",
        "Not recorded:",
        "  feature (checked out)  Feature work      npm run runshape -- record feature",
        "  origin/main            First             npm run runshape -- record origin/main",
        "",
        "Compare any two: npm run runshape -- compare <base> [<head>], or browse http://localhost:5173/demo/index.html",
      ].join("\n"),
    );
  });

  test("one recording at a time: a second run waits for no one, it refuses; a lock left by a run that died is taken over", async () => {
    const { root } = repository();
    const lock = join(root, ".runshape", "recordings", ".lock");
    mkdirSync(join(root, ".runshape", "recordings"), { recursive: true });
    writeFileSync(lock, String(process.pid)); // this very process: alive
    const refused = await run(root, ["record", "main"]);
    writeFileSync(lock, String(DEAD_PID));
    // An interrupted run's half-written recording, hidden, ~100 MB: cleared by the next run.
    mkdirSync(join(root, ".runshape", "recordings", ".incoming-0123456789ab"));
    const recovered = await run(root, ["record", "main"]);

    expect({
      refused: refused.lines,
      recovered: recovered.lines.at(-1)?.startsWith("recorded "),
      left: readdirSync(join(root, ".runshape", "recordings")).filter((name) => name.startsWith(".")),
    }).toEqual({
      refused: [`runshape: another recording is running (process ${process.pid}); if it isn't, delete ${lock}`],
      recovered: true,
      left: [],
    });
  });

  test("a recording made before zones were kept says so", async () => {
    const { root, commits } = repository();
    const id = commits.second!.slice(0, 12);
    await run(root, ["record", "main"]);
    const file = join(root, ".runshape", "recordings", id, "recording.json");
    const { architecture: _dropped, ...older } = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify(older));

    const { lines } = await run(root, ["list"]);

    expect(lines[3]).toBe(`  ${id}  main  Second  5 tests  zones not kept  recorded 2026-10-14 12:00`);
  });

  test("--tip is compare's: anywhere else it's an error, not ignored", async () => {
    const { root } = repository();

    const { code, lines } = await run(root, ["record", "main", "--tip"]);

    expect({ code, first: lines[0] }).toEqual({ code: 1, first: "runshape: --tip only applies to compare" });
  });

  test("forget deletes a recording; an id that isn't one is an error", async () => {
    const { root, commits } = repository();
    const id = commits.second!.slice(0, 12);
    await run(root, ["compare", "main"]);

    const forgot = await run(root, ["forget", id]);
    const unknown = await run(root, ["forget", "../.."]);

    expect({ forgot: forgot.lines, unknown: unknown.lines, code: unknown.code, left: readdirSync(join(root, ".runshape", "recordings")), reviews: readdirSync(join(root, ".runshape", "reviews")) }).toEqual({
      forgot: [`forgot ${id} (Second) and 1 review of it`],
      unknown: ["runshape: no recording ../.."],
      code: 1,
      left: ["working"],
      reviews: [],
    });
  });
});
