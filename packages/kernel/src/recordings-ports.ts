// What the recordings workflow needs from outside core, in its own words: git, the recorders,
// GitHub's pull requests, the project's working tree, hashing, and the library's stores. The
// adapters (the library, the CLI) implement these; core never imports them.
import type { TraceFiles } from "./trace/data/trace-directory";

import type { ChangedLines, CommitMessage, CommitSummary, LibraryOverview, PullRequestStory, PullRequestSummary, RecordingMetadata, RequestedReviews, Ticket } from "./recordings-model";
import type { ReviewPage } from "./review-page";

/** A path as a commit has it: nothing, a plain file's text, or something else (a folder, a link). */
export type FileAtCommit = { kind: "none" } | { kind: "file"; text: string } | { kind: "other"; what: string };

/** What the working tree's fingerprint is made of: HEAD, its change, and the untracked files (Markdown left out of both). */
export interface Uncommitted {
  head: string;
  diff: string;
  untracked: string[];
}

/** How many hex digits of a hash name a version of a recorder or a working tree. */
export const VERSION_DIGITS = 16;

/** What to record: a commit (checked out on its own, the working tree untouched) or the working tree as it is. */
export type RecordTarget = { kind: "commit"; commit: string } | { kind: "working" };

/** Port: records one target's tests into a directory, leaving latest.json and its run there. */
export interface Recorder {
  /** Where it records ("host", "docker:<image>"): recordings made in different places differ for that alone. */
  readonly environment: string;
  record(target: RecordTarget, outDirectory: string): Promise<void>;
  /** A hash of what records: the recorder's source here, what the image is built from in the sandbox. */
  source(): Promise<string>;
}

/** Port: the open pull requests asking for the person's review (gh in pull-requests.ts). */
export interface PullRequests {
  requestingMyReview(limit: number): Promise<PullRequestSummary[]>;
  /** Where they're listed from, to fetch them from: in a fork workflow that's not origin. */
  repository(): Promise<string>;
  /** One pull request's title, description and linked issues: what its author says it's for. */
  story(number: number): Promise<PullRequestStory>;
}

/**
 * Port: a ticket system the change's story is read from (GitHub Issues through gh; Jira when
 * someone needs it). Each source knows its own ids; the workflow asks every source about the
 * PR's and the commits' text, and reads what they find.
 */
export interface TicketSource {
  /** "GitHub Issues": said beside what it couldn't read. */
  readonly name: string;
  /** The ids of this source's tickets a text mentions, in its own syntax ("#12"; "PROJ-7"). */
  mentions(text: string): string[];
  /** The ticket; null when the source has none by that id (a pull request's number, say). */
  ticket(id: string): Promise<Ticket | null>;
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
  /** Each text file's changed lines from base to head (null: the working tree; untracked files aren't in it). */
  changedLines(base: string, head: string | null): Promise<ChangedLines[]>;
  /** Every file in the working tree that isn't ignored: tracked (deleted ones too) and untracked. */
  files(): Promise<string[]>;
  uncommitted(): Promise<Uncommitted>;
  /** The object a path names in HEAD; null when HEAD hasn't got it. */
  objectAtHead(path: string): Promise<string | null>;
  fileAt(commit: string, path: string): Promise<FileAtCommit>;
}

/** A folder's README.md as a folder guide would update it. */
export type Readme =
  | { kind: "no-folder" }
  /** The folder resolves outside the project, or the README isn't a plain file: never written. */
  | { kind: "not-plain" }
  | { kind: "unreadable"; reason: string }
  /** null: there's none yet. */
  | { kind: "readme"; text: string | null };

/** Port: the project's own working tree, by path relative to its root (ProjectFiles in the CLI). */
export interface ProjectFiles {
  /** Whether the path is a plain file, links not followed. */
  isPlainFile(path: string): Promise<boolean>;
  readme(folder: string): Promise<Readme>;
  writeReadme(folder: string, text: string): Promise<void>;
  /** A file's text; null when there's none; an error when it's there but can't be read. */
  readTextIfPresent(path: string): Promise<string | null>;
  /** A file's bytes; null when it can't be read. */
  readBytes(path: string): Promise<Uint8Array | null>;
}

/** A hash being built: each update adds to it, in order. */
export interface Digest {
  update(chunk: string | Uint8Array): Digest;
  hex(): string;
}

/** Port: SHA-256, without the platform's crypto in the workflow. */
export interface Hashing {
  sha256(text: string): string;
  digest(): Digest;
}

/** A recording being written: complete only once committed. */
export interface IncomingRecording {
  /** Where the recorder writes it. */
  readonly directory: string;
  readonly files: TraceFiles;
  /** The commit's runshape.json as it was, and where its rules put each class. */
  keepArchitecture(rulesText: string | null, architecture: unknown): Promise<void>;
  commit(metadata: RecordingMetadata): Promise<void>;
  /** Clears what it wrote; the next run clears anything left. */
  discard(): Promise<void>;
}

/** Port: the recordings a project keeps (the library's RecordingStore). */
export interface KeptRecordings {
  recording(id: string): Promise<RecordingMetadata | undefined>;
  /** Where a recording is: for a check that must look at it before it's touched. */
  pathOf(id: string): string;
  /** A recording's traces, for trace's TraceDirectory. */
  filesOf(id: string): TraceFiles;
  /** The runshape.json kept with a recording; null when its commit had none. */
  keptRules(id: string): Promise<string | null>;
  /** Runs `work` holding the recordings' lock (LibraryBusy when a live run has it), clearing what an interrupted run left first. */
  exclusively<T>(work: () => Promise<T>, couldNotClear: (name: string, error: Error) => void): Promise<T>;
  begin(id: string): Promise<IncomingRecording>;
  forget(id: string): Promise<void>;
  /** Moves a recording to another id, saying so in its metadata; if that id is taken, this one just goes. */
  move(id: string, to: string): Promise<void>;
}

/** Port: the reviews kept beside the recordings (the library's ReviewStore). */
export interface KeptReviews {
  /** The bundle (review.json), its Markdown (review.md), and the PR page's content (page.json). */
  saveReview(name: string, bundle: unknown, markdown: string, page: ReviewPage): Promise<void>;
  /** The PR page again, alone: once the review is explained, it carries the model's account. */
  savePage(name: string, page: ReviewPage): Promise<void>;
  /** The saved explanation; null when there's none or it can't be read. */
  explanation(name: string): Promise<unknown>;
  saveExplanation(name: string, explanation: unknown, markdown: string): Promise<void>;
  dropExplanation(name: string): Promise<void>;
  saveRequested(index: RequestedReviews, complete: boolean): Promise<void>;
  /** Removes every review that compares this recording; says how many. */
  forgetRecording(id: string): Promise<number>;
  /** Where a review's Markdown, or its explanation's, is, as a person finds it from the project's root. */
  shownReview(name: string): string;
  shownExplanation(name: string): string;
}

/** Port: a project's recordings, their reviews, and the git refs they could be compared against (the library). */
export interface Library {
  readonly store: KeptRecordings;
  readonly reviews: KeptReviews;
  overview(): Promise<LibraryOverview>;
}
