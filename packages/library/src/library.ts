import { join } from "node:path";

import { NodeFiles } from "@runshape/infra";

import { Git, GitError } from "./git";
import { RecordingStore, SANDBOX_SUFFIX, WORKING_TREE_ID } from "./recording-store";
import { ReviewStore } from "./review-store";

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
  /** The working tree's fingerprint when it was recorded (HEAD and every change): unchanged means the same code. */
  tree?: string;
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

/** An open pull request, as GitHub lists it. */
export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  author: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  /** From a fork: its branch isn't on origin, but GitHub's refs/pull/<n>/head is. */
  isCrossRepository: boolean;
  updatedAt: string;
}

/** What a morning's list shows of a review before it's opened. */
export interface ReviewHighlights {
  nowFailing: number;
  silentChanges: number;
  newTests: number;
  /** Rules added, removed or changed, and placements they made or unmade. */
  decided: number;
  needsDecision: number;
  routesChanged: number;
}

/** A pull request in requested.json: what it is, and what came of reviewing it. */
export interface RequestedReview extends PullRequestSummary {
  /** The commit reviewed: the fetched head, which may be newer than the listed one. */
  head: string;
  /** Its review's folder under .runshape/reviews ("<base>..<head>"); null when it couldn't be reviewed. */
  review: string | null;
  explained: boolean;
  problem: string | null;
  summary: ReviewHighlights | null;
}

/** .runshape/reviews/requested.json, as `review-requests` writes it. */
export interface RequestedReviews {
  format: "runshape-requested-reviews";
  version: 1;
  createdAt: string;
  pullRequests: RequestedReview[];
}

export interface LibraryOverview {
  working: { branch: string | null; commit: string; dirty: boolean };
  /** Newest first. */
  recordings: RecordingMetadata[];
  refs: RefSummary[];
  /** Directories that look like recordings but couldn't be read. */
  problems: string[];
  /** The last `review-requests` run's list; null before one has run. */
  requested: RequestedReviews | null;
}

export interface CommitSummary {
  commit: string;
  subject: string;
  committedAt: string;
}

/** A project's library as runshape keeps it: .runshape/recordings, and the reviews beside them. */
export function projectLibrary(root: string, git: Git): RecordingLibrary {
  const runshape = join(root, ".runshape");
  return new RecordingLibrary(new RecordingStore(new NodeFiles(join(runshape, "recordings"))), git, new ReviewStore(new NodeFiles(join(runshape, "reviews"))));
}

/** A project's recordings (.runshape/recordings) and the git refs they could be compared against. */
export class RecordingLibrary {
  constructor(
    readonly store: RecordingStore,
    private readonly git: Git,
    readonly reviews: ReviewStore,
  ) {}

  async overview(): Promise<LibraryOverview> {
    const [{ recordings, problems }, refs, working, requested] = await Promise.all([this.store.list(), this.refLines(), this.workingTree(), this.reviews.requested()]);
    // A commit recorded both here and in the sandbox: its branches point at the one made here.
    const committed = new Map<string, string>();
    for (const r of recordings) {
      if (r.id === WORKING_TREE_ID) continue;
      if (!committed.has(r.commit) || !r.id.endsWith(SANDBOX_SUFFIX)) committed.set(r.commit, r.id);
    }
    return {
      working,
      recordings,
      refs: refs.map((ref) => ({ ...ref, current: ref.kind === "branch" && ref.name === working.branch, recordingId: committed.get(ref.commit) ?? null })),
      problems,
      requested,
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
