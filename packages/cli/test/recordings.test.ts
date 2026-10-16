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

import { Recorder, RecordTarget, runRecordings } from "../src/recordings";
import { commitIn, gitIn, repository } from "@runshape/library/test/repository";

const FIXTURE = join(import.meta.dirname, "..", "..", "trace", "test", "fixtures", "go-shop");
const NOW = new Date("2026-10-14T12:00:00Z");
/** Above any pid the OS hands out (macOS and Linux cap well below it). */
const DEAD_PID = 99_999_999;

class FixtureRecorder implements Recorder {
  readonly recorded: string[] = [];
  constructor(private readonly fails = false) {}

  async record(target: RecordTarget, outDirectory: string): Promise<void> {
    this.recorded.push(target.kind === "working" ? "working" : target.commit.slice(0, 7));
    if (this.fails) throw new Error("vitest crashed");
    cpSync(FIXTURE, outDirectory, { recursive: true });
  }
}

async function run(root: string, argv: string[], recorder = new FixtureRecorder()) {
  const lines: string[] = [];
  const code = await runRecordings(argv, { root, recorder, print: (line) => lines.push(line), now: () => NOW });
  return { code, lines, recorder };
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

  test("the working tree's runshape.json is the file on disk, edits not committed yet included", async () => {
    const { root } = repository();
    writeFileSync(join(root, "runshape.json"), GO_SHOP_RULES);

    await run(root, ["record", "working"]);

    expect(metadataOf(root, "working").architecture).toEqual({ style: "hexagonal", rules: 2, declared: 5, inferred: 4, problem: null });
  });

  test("an invalid runshape.json is kept and reported, the code recorded anyway with every zone inferred", async () => {
    const { root } = repository();
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

  test("forget deletes a recording; an id that isn't one is an error", async () => {
    const { root, commits } = repository();
    const id = commits.second!.slice(0, 12);
    await run(root, ["record", "main"]);

    const forgot = await run(root, ["forget", id]);
    const unknown = await run(root, ["forget", "../.."]);

    expect({ forgot: forgot.lines, unknown: unknown.lines, code: unknown.code, left: readdirSync(join(root, ".runshape", "recordings")) }).toEqual({
      forgot: [`forgot ${id} (Second)`],
      unknown: ["runshape: no recording ../.."],
      code: 1,
      left: [],
    });
  });
});
