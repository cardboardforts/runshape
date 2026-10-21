// What the recordings workflow (recordings.ts) needs from outside, declared here so its
// adapters (shell-recorder, docker-recorder, pull-requests, the library's GitRepository) fit
// these, not the workflow.
import type { CommitMessage, CommitSummary, FileAtCommit, PullRequestSummary, Uncommitted } from "@runshape/library";

/** What to record: a commit (checked out on its own, the working tree untouched) or the working tree as it is. */
export type RecordTarget = { kind: "commit"; commit: string } | { kind: "working" };

/** Port: records one target's tests into a directory, leaving latest.json and its run there. */
export interface Recorder {
  /** Where it records ("host", "docker:<image>"): recordings made in different places differ for that alone. */
  readonly environment: string;
  record(target: RecordTarget, outDirectory: string): Promise<void>;
}

/** Port: the open pull requests asking for the person's review (gh in pull-requests.ts). */
export interface PullRequests {
  requestingMyReview(limit: number): Promise<PullRequestSummary[]>;
  /** Where they're listed from, to fetch them from: in a fork workflow that's not origin. */
  repository(): Promise<string>;
}

/** Port: what git says about the project, named for what the workflow asks (GitRepository in the library). */
export interface Repository {
  /** The remote everything is fetched from, and the setting that names the branch of merged code: for messages. */
  readonly remote: string;
  readonly mergedBranchSetting: string;
  /** The commit a branch, tag or hash names; GitError when git doesn't know it. */
  resolve(ref: string): Promise<CommitSummary>;
  workingTree(): Promise<{ branch: string | null; commit: string; dirty: boolean }>;
  /** Fetches the remote's branch, local branches untouched; the full ref of the remote's copy. */
  fetchBranch(branch: string): Promise<string>;
  /** Fetches a pull request's head and its base branch from the repository it's listed in; the refs they're in. */
  fetchPullRequest(repository: string, number: number, baseBranch: string): Promise<{ head: string; base: string }>;
  /** The branch of merged code, as the person or the remote says; null when neither does. */
  mergedBranch(): Promise<string | null>;
  branchContains(branch: string, commit: string): Promise<boolean>;
  /** The pull request a commit or branch was checked out from, as git knows it; null for neither. */
  pullRequestAt(commit: string, branch: string | null): Promise<string | null>;
  /** Where two commits' histories meet; null when they share none. */
  forkPoint(a: string, b: string): Promise<string | null>;
  commitsAhead(from: string, to: string): Promise<number>;
  /** The commits head has that the base hasn't, oldest first, as their authors wrote them. */
  commitsBetween(base: string, head: string): Promise<CommitMessage[]>;
  /** Every file in the working tree that isn't ignored: tracked (deleted ones too) and untracked. */
  files(): Promise<string[]>;
  uncommitted(): Promise<Uncommitted>;
  /** The object a path names in HEAD; null when HEAD hasn't got it. */
  objectAtHead(path: string): Promise<string | null>;
  fileAt(commit: string, path: string): Promise<FileAtCommit>;
}
