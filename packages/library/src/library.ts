import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Git, GitError } from "./git";

/** What recording.json says about one recording, written when it was made. */
export interface RecordingMetadata {
  /** The directory name: the commit's first 12 hex digits, or "working". */
  id: string;
  commit: string;
  subject: string;
  committedAt: string;
  /** For the working tree: the branch it was on (null when detached). */
  branch: string | null;
  /** The working tree had changes no commit holds. */
  dirty: boolean;
  recordedAt: string;
  recorder: string;
  /** A hash of the recorder's source when it recorded: recordings by different recorders differ for that alone. */
  recorderSource: string;
  /** Where it was recorded: "host", or "docker:<image>" (`--sandbox`); absent means host. */
  environment?: string;
  tests: { total: number; failed: number };
  /** The commit's runshape.json applied to this recording (placements in architecture.json); absent from recordings made before it was kept. */
  architecture?: ArchitectureSummary;
}

export interface ArchitectureSummary {
  style: string;
  rules: number;
  /** Classes and modules a rule placed, and those placed by their recorded behaviour. */
  declared: number;
  inferred: number;
  /** Why runshape.json couldn't be used, when it couldn't: then everything is inferred. */
  problem: string | null;
}

/** Where each recording keeps its commit's placements, and the runshape.json they came from. */
export const ARCHITECTURE_FILE = "architecture.json";

/** A branch tip, and the recording of exactly that commit if there is one. */
export interface RefSummary {
  name: string;
  kind: "branch" | "remote";
  commit: string;
  subject: string;
  committedAt: string;
  current: boolean;
  recordingId: string | null;
}

export interface LibraryOverview {
  working: { branch: string | null; commit: string; dirty: boolean };
  /** Newest first. */
  recordings: RecordingMetadata[];
  refs: RefSummary[];
  /** Directories that look like recordings but couldn't be read. */
  problems: string[];
}

export interface CommitSummary {
  commit: string;
  subject: string;
  committedAt: string;
}

export const WORKING_TREE_ID = "working";
export const METADATA_FILE = "recording.json";
/** As many hex digits as a recording's directory name keeps. */
const RECORDING_ID_LENGTH = 12;
/** A directory still being written; renamed into place when its recording is complete. */
export const INCOMING_PREFIX = ".incoming-";

/** A recording's folder name: a commit's first hex digits, or the working tree's. */
export const RECORDING_ID = new RegExp(`^([0-9a-f]{${RECORDING_ID_LENGTH}}|${WORKING_TREE_ID})$`);

export function recordingIdFor(commit: string): string {
  return commit.slice(0, RECORDING_ID_LENGTH);
}

/** A project's recordings (.runshape/recordings) and the git refs they could be compared against. */
export class RecordingLibrary {
  constructor(
    readonly directory: string,
    private readonly git: Git,
  ) {}

  async overview(): Promise<LibraryOverview> {
    const [{ recordings, problems }, refs, working] = await Promise.all([this.recordings(), this.refLines(), this.workingTree()]);
    const committed = new Map(recordings.filter((r) => r.id !== WORKING_TREE_ID).map((r) => [r.commit, r.id]));
    return {
      working,
      recordings,
      refs: refs.map((ref) => ({ ...ref, current: ref.kind === "branch" && ref.name === working.branch, recordingId: committed.get(ref.commit) ?? null })),
      problems,
    };
  }

  /** The commit a branch, tag or hash names. */
  async resolve(ref: string): Promise<CommitSummary> {
    let output: string;
    try {
      // --end-of-options: a ref spelled like an option is still a ref.
      output = await this.git.run(["log", "-1", `--format=%H%x00%s%x00%cI`, "--end-of-options", `${ref}^{commit}`, "--"]);
    } catch (error) {
      if (error instanceof GitError) throw new GitError(`git doesn't know ${ref}`);
      throw error;
    }
    const [commit, subject, committedAt] = output.trim().split("\0");
    return { commit: commit!, subject: subject!, committedAt: utc(committedAt!) };
  }

  async recordings(): Promise<{ recordings: RecordingMetadata[]; problems: string[] }> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return { recordings: [], problems: [] }; // nothing recorded yet
    }
    const recordings: RecordingMetadata[] = [];
    const problems: string[] = [];
    for (const name of names) {
      // Hidden ones are still being written (INCOMING_PREFIX); other names aren't recordings.
      if (!RECORDING_ID.test(name)) continue;
      let text: string;
      try {
        text = await readFile(join(this.directory, name, METADATA_FILE), "utf8");
      } catch {
        continue; // not a recording: a stray directory or file
      }
      let metadata: RecordingMetadata;
      try {
        metadata = JSON.parse(text) as RecordingMetadata;
      } catch (error) {
        problems.push(`${name}: ${METADATA_FILE} can't be read (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      // The folder is the id: anything that acts on a recording (forget, a link) uses it.
      if (metadata.id !== name) {
        problems.push(`${name}: ${METADATA_FILE} says it is ${JSON.stringify(metadata.id)}`);
        continue;
      }
      recordings.push(metadata);
    }
    recordings.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    return { recordings, problems };
  }

  async workingTree(): Promise<LibraryOverview["working"]> {
    const [branch, commit, status] = await Promise.all([
      this.git.run(["symbolic-ref", "--quiet", "--short", "HEAD"]).then((name) => name.trim(), () => null),
      this.git.run(["rev-parse", "HEAD"]),
      // Untracked files count: a new test file not added yet still runs.
      this.git.run(["status", "--porcelain"]),
    ]);
    return { branch, commit: commit.trim(), dirty: status.trim() !== "" };
  }

  private async refLines(): Promise<Omit<RefSummary, "current" | "recordingId">[]> {
    const output = await this.git.run(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(subject)%00%(committerdate:iso-strict)", "refs/heads", "refs/remotes"]);
    const refs: Omit<RefSummary, "current" | "recordingId">[] = [];
    for (const line of output.split("\n")) {
      if (line === "") continue;
      const [refname, commit, subject, committedAt] = line.split("\0");
      // origin/HEAD only points at another remote branch: listing it says nothing new.
      if (refname!.endsWith("/HEAD")) continue;
      const kind = refname!.startsWith("refs/heads/") ? "branch" : "remote";
      refs.push({ name: refname!.replace(/^refs\/(heads|remotes)\//, ""), kind, commit: commit!, subject: subject!, committedAt: utc(committedAt!) });
    }
    return refs;
  }
}

/** git prints dates in the committer's zone; recordings compare them as UTC text. */
function utc(date: string): string {
  return new Date(date).toISOString().replace(".000Z", "Z");
}
