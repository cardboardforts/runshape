// npm run runshape -- list | record <ref>... [--fetch] [--again] | compare <base> [<head>] [--fetch] | forget <id>
// Keeps .runshape/recordings: one recording per commit, plus the working tree's.
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadLatestRun, Outcome } from "@runshape/core";
import {
  CommitSummary,
  GitCli,
  GitError,
  INCOMING_PREFIX,
  LibraryOverview,
  METADATA_FILE,
  RecordingLibrary,
  RecordingMetadata,
  recordingIdFor,
  WORKING_TREE_ID,
} from "@runshape/library";

/** What to record: a commit (checked out on its own, the working tree untouched) or the working tree as it is. */
export type RecordTarget = { kind: "commit"; commit: string } | { kind: "working" };

/** Port: records one target's tests into a directory, leaving latest.json and its run there. */
export interface Recorder {
  record(target: RecordTarget, outDirectory: string): Promise<void>;
}

export interface RecordingsDependencies {
  /** The project's root: its git repository, and where .runshape/recordings lives. */
  root: string;
  recorder: Recorder;
  print: (line: string) => void;
  now: () => Date;
}

/** Where the demo's dev server serves the recordings page (npm run dev -w packages/webview). */
export const DEMO_URL = "http://localhost:5173/demo/index.html";
const FAILING = new Set<string>([Outcome.Failed, Outcome.Error, Outcome.UnexpectedPass]);
const REMOTE = "origin";

class UsageError extends Error {}

export async function runRecordings(argv: string[], dependencies: RecordingsDependencies): Promise<number> {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const [command = "list", ...names] = argv.filter((arg) => !arg.startsWith("--"));
  const unknownFlags = [...flags].filter((flag) => !KNOWN_FLAGS.has(flag));
  const recordings = new Recordings(dependencies, { fetch: flags.has("--fetch"), again: flags.has("--again") });
  try {
    if (unknownFlags.length > 0) throw new UsageError(`unknown option ${unknownFlags.join(", ")}\n${USAGE}`);
    switch (command) {
      case "list":
        await recordings.list();
        return 0;
      case "record":
        if (names.length === 0) throw new UsageError(`record what? ${USAGE}`);
        for (const name of names) await recordings.ensure(name);
        return 0;
      case "compare": {
        if (names.length < 1 || names.length > 2) throw new UsageError(`compare <base> [<head>]\n${USAGE}`);
        const base = await recordings.ensure(names[0]!);
        const head = await recordings.ensure(names[1] ?? WORKING_TREE_ID);
        dependencies.print(`open ${DEMO_URL}?base=${base}&head=${head} (npm run dev -w packages/webview)`);
        return 0;
      }
      case "forget":
        if (names.length !== 1) throw new UsageError(`forget <id>\n${USAGE}`);
        await recordings.forget(names[0]!);
        return 0;
      default:
        throw new UsageError(`unknown command ${command}\n${USAGE}`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof GitError || error instanceof RecordingError) {
      dependencies.print(`runshape: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

const KNOWN_FLAGS = new Set(["--fetch", "--again"]);
const USAGE = "usage: npm run runshape -- list | record <ref|working>... [--fetch] [--again] | compare <base> [<head>] [--fetch] | forget <id>";

class RecordingError extends Error {}

class Recordings {
  private readonly library: RecordingLibrary;
  private readonly git: GitCli;

  constructor(
    private readonly dependencies: RecordingsDependencies,
    private readonly options: { fetch: boolean; again: boolean },
  ) {
    this.git = new GitCli(dependencies.root);
    this.library = new RecordingLibrary(join(dependencies.root, ".runshape", "recordings"), this.git);
  }

  /**
   * The recording of `name`, made now if there isn't one. A commit is recorded once; the working
   * tree every time it's asked for, since it changes under you.
   */
  async ensure(name: string): Promise<string> {
    const { print } = this.dependencies;
    if (name === WORKING_TREE_ID) {
      const working = await this.library.workingTree();
      const summary = await this.library.resolve("HEAD");
      print(`recording the working tree (${working.branch ?? "detached"}${working.dirty ? ", with uncommitted changes" : ""})…`);
      await this.make(WORKING_TREE_ID, { kind: "working" }, summary, { branch: working.branch, dirty: working.dirty }, "the working tree");
      return WORKING_TREE_ID;
    }
    const ref = this.options.fetch ? await this.fetched(name) : name;
    const summary = await this.library.resolve(ref);
    const id = recordingIdFor(summary.commit);
    const label = `${ref} (${id} ${summary.subject})`;
    const recorded = (await this.library.recordings()).recordings.some((r) => r.id === id);
    if (recorded && !this.options.again) {
      print(`${label} is recorded already; record it again with --again`);
      return id;
    }
    print(`recording ${label}…`);
    await this.make(id, { kind: "commit", commit: summary.commit }, summary, { branch: null, dirty: false }, ref);
    return id;
  }

  async list(): Promise<void> {
    const overview = await this.library.overview();
    for (const line of listing(overview)) this.dependencies.print(line);
  }

  async forget(id: string): Promise<void> {
    const recording = (await this.library.recordings()).recordings.find((r) => r.id === id);
    if (recording === undefined) throw new RecordingError(`no recording ${id}`);
    await rm(join(this.library.directory, recording.id), { recursive: true, force: true });
    this.dependencies.print(`forgot ${recording.id} (${recording.subject})`);
  }

  /** Fetches the branch from origin and names origin's copy: local branches stay as they are. */
  private async fetched(name: string): Promise<string> {
    const branch = name.startsWith(`${REMOTE}/`) ? name.slice(REMOTE.length + 1) : name;
    this.dependencies.print(`fetching ${branch} from ${REMOTE}…`);
    await this.git.run(["fetch", "--quiet", REMOTE, "--end-of-options", branch]);
    return `${REMOTE}/${branch}`;
  }

  /** Records into a directory of its own, and moves it into place only once it's complete. */
  private async make(id: string, target: RecordTarget, summary: CommitSummary, tree: { branch: string | null; dirty: boolean }, what: string): Promise<void> {
    const incoming = join(this.library.directory, `${INCOMING_PREFIX}${id}`);
    await rm(incoming, { recursive: true, force: true });
    await mkdir(incoming, { recursive: true });
    try {
      await this.dependencies.recorder.record(target, incoming);
      const run = await loadLatestRun({ readText: (path) => readFile(join(incoming, path), "utf8") });
      const metadata: RecordingMetadata = {
        id,
        commit: summary.commit,
        subject: summary.subject,
        committedAt: summary.committedAt,
        branch: tree.branch,
        dirty: tree.dirty,
        recordedAt: this.dependencies.now().toISOString(),
        recorder: run.recorderVersion ?? "unknown",
        tests: { total: run.scenarios.length, failed: run.scenarios.filter((s) => FAILING.has(s.outcome)).length },
      };
      await writeFile(join(incoming, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
      await rm(join(this.library.directory, id), { recursive: true, force: true });
      await rename(incoming, join(this.library.directory, id));
      this.dependencies.print(`recorded ${id}: ${metadata.tests.total} tests, ${metadata.tests.failed} failed`);
    } catch (error) {
      await rm(incoming, { recursive: true, force: true });
      throw new RecordingError(`recording ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The list command's text: the working tree, what's recorded, what could be. */
function listing(overview: LibraryOverview): string[] {
  const { working, recordings, refs } = overview;
  const workingRecording = recordings.find((r) => r.id === WORKING_TREE_ID);
  const lines = [
    `Working tree: ${working.branch ?? "detached"} at ${working.commit.slice(0, 7)}, ${working.dirty ? "with uncommitted changes" : "no uncommitted changes"} (${
      workingRecording ? `recorded ${when(workingRecording.recordedAt)}` : "not recorded: npm run runshape -- record working"
    })`,
    "",
  ];
  if (recordings.length === 0) {
    lines.push("Nothing recorded yet.");
  } else {
    lines.push(`Recorded (${recordings.length}):`);
    for (const recording of recordings) {
      const names = recording.id === WORKING_TREE_ID ? [`working tree (${recording.branch ?? "detached"})`] : refs.filter((ref) => ref.recordingId === recording.id).map((ref) => ref.name);
      const failed = recording.tests.failed > 0 ? `, ${recording.tests.failed} failed` : "";
      lines.push(`  ${recording.id.padEnd(12)}  ${names.join(", ") || "-"}  ${recording.subject}  ${recording.tests.total} tests${failed}  recorded ${when(recording.recordedAt)}`);
    }
  }
  const unrecorded = refs.filter((ref) => ref.recordingId === null);
  if (unrecorded.length > 0) {
    lines.push("", "Not recorded:");
    const names = unrecorded.map((ref) => `${ref.name}${ref.current ? " (checked out)" : ""}`);
    const nameWidth = Math.max(...names.map((name) => name.length));
    const subjectWidth = Math.max(...unrecorded.map((ref) => Math.min(ref.subject.length, MAX_SUBJECT)));
    unrecorded.forEach((ref, i) => {
      lines.push(`  ${names[i]!.padEnd(nameWidth)}  ${truncate(ref.subject).padEnd(subjectWidth)}      npm run runshape -- record ${ref.name}`);
    });
  }
  for (const problem of overview.problems) lines.push(`  (skipped ${problem})`);
  lines.push("", `Compare any two: npm run runshape -- compare <base> [<head>], or browse ${DEMO_URL}`);
  return lines;
}

const MAX_SUBJECT = 50;

function truncate(subject: string): string {
  return subject.length > MAX_SUBJECT ? `${subject.slice(0, MAX_SUBJECT - 1)}…` : subject;
}

/** "2026-10-14 12:00", in UTC: recordings are compared by this, not by a local clock. */
function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}
