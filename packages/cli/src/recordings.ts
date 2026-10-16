// npm run runshape -- list | record <ref>... [--fetch] [--again] | compare <base> [<head>] [--fetch] | forget <id>
// Keeps .runshape/recordings: one recording per commit, plus the working tree's.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ArchitectureSnapshot, buildPlacements, loadLatestRun, Outcome, RULES_FILE, Run, ZoneRules, ZoneRulesError, ZoneSource } from "@runshape/core";
import {
  ARCHITECTURE_FILE,
  ArchitectureSummary,
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
        await recordings.exclusively(async () => {
          for (const name of names) await recordings.ensure(await recordings.plan(name, { fetch: true }));
        });
        return 0;
      case "compare": {
        if (names.length < 1 || names.length > 2) throw new UsageError(`compare <base> [<head>]\n${USAGE}`);
        const [baseName, headName = WORKING_TREE_ID] = names as [string, string?];
        await recordings.exclusively(async () => {
          // --fetch is for the base ("the latest main"): the head is usually yours.
          const base = await recordings.plan(baseName, { fetch: true });
          const head = await recordings.plan(headName, { fetch: false });
          if (base.id === head.id) throw new RecordingError(`${baseName} and ${headName} are the same recording: nothing to compare`);
          await recordings.ensure(base, { sameRecorder: true });
          await recordings.ensure(head, { sameRecorder: true });
          dependencies.print(`open ${DEMO_URL}?base=${base.id}&head=${head.id} (npm run dev -w packages/webview)`);
        });
        return 0;
      }
      case "forget":
        if (names.length !== 1) throw new UsageError(`forget <id>\n${USAGE}`);
        await recordings.exclusively(() => recordings.forget(names[0]!));
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

/** What a name will record as, worked out before anything is recorded. */
interface Plan {
  id: string;
  /** How the name reads in messages: "main (ca63db8816d7 Routes: …)". */
  label: string;
  target: RecordTarget;
  summary: CommitSummary;
  tree: { branch: string | null; dirty: boolean };
}

/** Taken while recording or forgetting, so two runs can't write over each other's recordings. */
const LOCK_FILE = ".lock";
/** The recorder's own source, hashed into each recording: its tests don't change what it records. */
const RECORDER_DIRECTORY = "recorder-ts";
const RECORDER_SOURCE_SKIPPED = new Set(["node_modules", "test"]);

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

  /** Runs `work` holding the library's lock, taking over a lock whose process is gone. */
  async exclusively(work: () => Promise<void>): Promise<void> {
    await mkdir(this.library.directory, { recursive: true });
    const lock = join(this.library.directory, LOCK_FILE);
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" });
    } catch {
      const holder = Number((await readFile(lock, "utf8").catch(() => "")).trim());
      if (Number.isInteger(holder) && holder > 0 && isRunning(holder)) {
        throw new RecordingError(`another recording is running (process ${holder}); if it isn't, delete ${lock}`);
      }
      await writeFile(lock, String(process.pid));
    }
    try {
      await this.clearInterrupted();
      await work();
    } finally {
      await rm(lock, { force: true });
    }
  }

  /** What `name` names: "working", or a branch, tag or commit (fetched from origin first with --fetch). */
  async plan(name: string, { fetch }: { fetch: boolean }): Promise<Plan> {
    if (name === WORKING_TREE_ID) {
      const working = await this.library.workingTree();
      const summary = await this.library.resolve("HEAD");
      const where = `${working.branch ?? "detached"}${working.dirty ? ", with uncommitted changes" : ""}`;
      return { id: WORKING_TREE_ID, label: `the working tree (${where})`, target: { kind: "working" }, summary, tree: { branch: working.branch, dirty: working.dirty } };
    }
    const ref = fetch && this.options.fetch ? await this.fetched(name) : name;
    const summary = await this.library.resolve(ref);
    const id = recordingIdFor(summary.commit);
    const shown = ref.replace(/^refs\/remotes\//, "");
    return { id, label: `${shown} (${id} ${summary.subject})`, target: { kind: "commit", commit: summary.commit }, summary, tree: { branch: null, dirty: false } };
  }

  /**
   * The planned recording, made now if there isn't one. A commit is recorded once; the working
   * tree every time, since it changes under you. With `sameRecorder` (compare), a commit
   * recorded by another version of the recorder is recorded again.
   */
  async ensure(plan: Plan, { sameRecorder = false } = {}): Promise<void> {
    const { print } = this.dependencies;
    const existing = (await this.library.recordings()).recordings.find((r) => r.id === plan.id);
    if (existing && plan.id !== WORKING_TREE_ID && !this.options.again) {
      if (!sameRecorder || existing.recorderSource === (await this.recorderSource())) {
        print(`${plan.label} is recorded already; record it again with --again`);
        return;
      }
      print(`${plan.label} was recorded by another version of ${RECORDER_DIRECTORY}: recording it again`);
    } else {
      print(`recording ${plan.label}…`);
    }
    await this.make(plan);
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

  /**
   * Fetches the branch from origin and names origin's copy in full: a local branch that
   * happens to be called "origin/main" would win the short name. Local branches stay as they are.
   */
  private async fetched(name: string): Promise<string> {
    const branch = name.startsWith(`${REMOTE}/`) ? name.slice(REMOTE.length + 1) : name;
    this.dependencies.print(`fetching ${branch} from ${REMOTE}…`);
    await this.git.run(["fetch", "--quiet", REMOTE, "--end-of-options", `refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`]);
    return `refs/remotes/${REMOTE}/${branch}`;
  }

  /** Half-written recordings an interrupted run left: nothing else writes while the lock is held. */
  private async clearInterrupted(): Promise<void> {
    for (const name of await readdir(this.library.directory)) {
      if (name.startsWith(INCOMING_PREFIX) || name.startsWith(REPLACED_PREFIX)) await rm(join(this.library.directory, name), { recursive: true, force: true });
    }
  }

  /** The recorder's source as it is now: what recorded a recording made now. */
  private async recorderSource(): Promise<string> {
    const hash = createHash("sha256");
    const directory = join(this.dependencies.root, RECORDER_DIRECTORY);
    const walk = async (relative: string): Promise<void> => {
      const entries = await readdir(join(directory, relative), { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (RECORDER_SOURCE_SKIPPED.has(entry.name)) continue;
        const path = join(relative, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) hash.update(path).update("\0").update(await readFile(join(directory, path))).update("\0");
      }
    };
    await walk("");
    return hash.digest("hex").slice(0, RECORDER_SOURCE_DIGITS);
  }

  /** Records into a directory of its own, and moves it into place only once it's complete. */
  private async make(plan: Plan): Promise<void> {
    const { id, target, summary, tree } = plan;
    const incoming = join(this.library.directory, `${INCOMING_PREFIX}${id}`);
    await mkdir(incoming, { recursive: true });
    try {
      const recorderSource = await this.recorderSource();
      const rules = await this.rulesAt(target);
      if (rules.problem !== null) this.dependencies.print(`${RULES_FILE} at ${plan.label} is invalid, so every zone is inferred: ${rules.problem}`);
      await this.dependencies.recorder.record(target, incoming);
      const run = await loadLatestRun({ readText: (path) => readFile(join(incoming, path), "utf8") });
      const architecture = await this.keepArchitecture(incoming, run, rules);
      const metadata: RecordingMetadata = {
        id,
        commit: summary.commit,
        subject: summary.subject,
        committedAt: summary.committedAt,
        branch: tree.branch,
        dirty: tree.dirty,
        recordedAt: this.dependencies.now().toISOString(),
        recorder: run.recorderVersion ?? "unknown",
        recorderSource,
        tests: { total: run.scenarios.length, failed: run.scenarios.filter((s) => FAILING.has(s.outcome)).length },
        architecture,
      };
      await writeFile(join(incoming, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
      await this.replace(id, incoming);
      this.dependencies.print(`recorded ${id}: ${metadata.tests.total} tests, ${metadata.tests.failed} failed`);
    } catch (error) {
      await rm(incoming, { recursive: true, force: true });
      throw new RecordingError(`recording ${plan.label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The target's own runshape.json: the commit's as committed, the working tree's as on disk. */
  private async rulesAt(target: RecordTarget): Promise<CommittedRules> {
    let text: string | null;
    if (target.kind === "working") {
      try {
        text = await readFile(join(this.dependencies.root, RULES_FILE), "utf8");
      } catch (error) {
        // Only a missing file means "no rules"; one that can't be read is a problem to report.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { text: null, rules: ZoneRules.none(), problem: `it can't be read: ${(error as Error).message}` };
        text = null;
      }
    } else {
      // "<mode> <type> <object>\t<path>": a directory, link or submodule there isn't rules to read.
      const entry = (await this.git.run(["ls-tree", target.commit, "--", RULES_FILE])).trim();
      const [mode, type] = entry.split(/\s+/);
      if (entry !== "" && !REGULAR_FILE_MODES.has(mode!)) return { text: null, rules: ZoneRules.none(), problem: `it is a ${mode === "120000" ? "symbolic link" : type} in the commit, not a file` };
      text = entry === "" ? null : await this.git.run(["show", `${target.commit}:${RULES_FILE}`]);
    }
    if (text === null) return { text: null, rules: ZoneRules.none(), problem: null };
    try {
      // An editor's byte-order mark isn't JSON; VS Code's reader (the extension's) drops it too.
      return { text, rules: ZoneRules.parse(text.replace(/^\uFEFF/, "")), problem: null };
    } catch (error) {
      if (!(error instanceof ZoneRulesError)) throw error;
      return { text, rules: ZoneRules.none(), problem: error.problems.join("; ") };
    }
  }

  /** Writes the rules as they were and where they put each class, for a person to read; returns the summary. */
  private async keepArchitecture(directory: string, run: Run, committed: CommittedRules): Promise<ArchitectureSummary> {
    const snapshot: ArchitectureSnapshot = buildPlacements(run, committed.rules);
    if (committed.text !== null) await writeFile(join(directory, RULES_FILE), committed.text);
    await writeFile(join(directory, ARCHITECTURE_FILE), `${JSON.stringify({ ...snapshot, problem: committed.problem }, null, 2)}\n`);
    const declared = snapshot.placements.filter((p) => p.source === ZoneSource.Rule).length;
    return { style: snapshot.style, rules: snapshot.rules.length, declared, inferred: snapshot.placements.length - declared, problem: committed.problem };
  }

  /** The old recording is set aside, not deleted, until the new one is in place. */
  private async replace(id: string, incoming: string): Promise<void> {
    const final = join(this.library.directory, id);
    const replaced = join(this.library.directory, `${REPLACED_PREFIX}${id}`);
    const hadOne = await rename(final, replaced).then(() => true, () => false);
    try {
      await rename(incoming, final);
    } catch (error) {
      if (hadOne) await rename(replaced, final);
      throw error;
    }
    if (hadOne) await rm(replaced, { recursive: true, force: true });
  }
}

/** A target's runshape.json: its text as committed (null when there's none), and the rules read from it. */
interface CommittedRules {
  text: string | null;
  rules: ZoneRules;
  /** Why the text couldn't be used; the rules are then none, and every zone inferred. */
  problem: string | null;
}

/** git's modes for a plain file and an executable one: anything else at runshape.json isn't rules. */
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

/** A recording being replaced, kept until its replacement is in place. */
const REPLACED_PREFIX = ".replaced-";
/** Enough of the recorder's source hash to tell two versions apart. */
const RECORDER_SOURCE_DIGITS = 16;

/** Whether a process exists: signal 0 checks without sending anything. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it's someone else's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
      lines.push(`  ${recording.id.padEnd(12)}  ${names.join(", ") || "-"}  ${recording.subject}  ${recording.tests.total} tests${failed}  ${zonesOf(recording.architecture)}  recorded ${when(recording.recordedAt)}`);
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

/** "hexagonal: 2 rules place 5, 4 inferred"; recordings made before zones were kept have none. */
export function zonesOf(architecture: ArchitectureSummary | undefined): string {
  if (architecture === undefined) return "zones not kept";
  if (architecture.problem !== null) return `${RULES_FILE} invalid, ${architecture.inferred} inferred`;
  if (architecture.rules === 0) return `${architecture.style}: no rules, ${architecture.inferred} inferred`;
  return `${architecture.style}: ${architecture.rules} rule${architecture.rules === 1 ? "" : "s"} place ${architecture.declared}, ${architecture.inferred} inferred`;
}

const MAX_SUBJECT = 50;

function truncate(subject: string): string {
  return subject.length > MAX_SUBJECT ? `${subject.slice(0, MAX_SUBJECT - 1)}…` : subject;
}

/** "2026-10-14 12:00", in UTC: recordings are compared by this, not by a local clock. */
function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}
