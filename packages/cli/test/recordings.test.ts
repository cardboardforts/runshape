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
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { Recorder, RecordTarget, runRecordings } from "../src/recordings";
import { commitIn, gitIn, repository } from "@runshape/library/test/repository";

const FIXTURE = join(import.meta.dirname, "..", "..", "trace", "test", "fixtures", "go-shop");
const NOW = new Date("2026-10-14T12:00:00Z");

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
      tests: { total: 5, failed: 0 },
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

  test("a recording that fails leaves nothing behind, and says why", async () => {
    const { root } = repository();

    const { code, lines } = await run(root, ["record", "main"], new FixtureRecorder(true));

    expect({ code, last: lines.at(-1), left: existsSync(join(root, ".runshape", "recordings")) ? readdirSync(join(root, ".runshape", "recordings")) : [] }).toEqual({
      code: 1,
      last: "runshape: recording main failed: vitest crashed",
      left: [],
    });
  });

  test("a ref git doesn't know is refused before anything runs", async () => {
    const { root } = repository();

    const { code, lines, recorder } = await run(root, ["record", "nope"]);

    expect({ code, lines, recorded: recorder.recorded }).toEqual({ code: 1, lines: ["runshape: git doesn't know nope"], recorded: [] });
  });
});

describe("runshape compare", () => {
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
        `  ${commits.second!.slice(0, 12)}  main  Second  5 tests  recorded 2026-10-14 12:00`,
        "",
        "Not recorded:",
        "  feature (checked out)  Feature work      npm run runshape -- record feature",
        "  origin/main            First             npm run runshape -- record origin/main",
        "",
        "Compare any two: npm run runshape -- compare <base> [<head>], or browse http://localhost:5173/demo/index.html",
      ].join("\n"),
    );
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
