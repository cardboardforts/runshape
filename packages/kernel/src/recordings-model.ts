// The recordings a project keeps, as the recordings workflow speaks of them: what each one is,
// the reviews made of two, and the pull requests asking for one. The library keeps them on disk
// (packages/adapters/src/library); these are its words for them, and the workflow's.

/** The working tree's recording: the one recorded every time, since it changes under you. */
export const WORKING_TREE_ID = "working";
/** As many hex digits of its commit as a recording's id keeps. */
export const RECORDING_ID_LENGTH = 12;
/** Marks a commit's recording made in the sandbox: one of its own, beside one made on this machine. */
export const SANDBOX_SUFFIX = "-sandbox";

export function recordingIdFor(commit: string, sandboxed = false): string {
  return `${commit.slice(0, RECORDING_ID_LENGTH)}${sandboxed ? SANDBOX_SUFFIX : ""}`;
}

/** A review's name: the recordings it compares, base first. */
export function reviewName(baseId: string, headId: string): string {
  return `${baseId}..${headId}`;
}

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
  /** The listed PR this one builds on (its base is that one's branch); absent in lists written before stacks were kept. */
  stackedOn?: number | null;
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

/** A commit's message, as its author wrote it: read from git, explained by a model. */
export interface CommitMessage {
  commit: string;
  subject: string;
  body: string;
}

/**
 * A pull request as its author described it: what it's for, in their words. Untrusted text,
 * like a commit message: shown and explained as data, never followed.
 */
export interface PullRequestStory {
  number: number;
  title: string;
  body: string;
  url: string;
  /** The issues GitHub says it closes, as ticket ids ("#12", "owner/repo#12"). */
  linkedIssues: string[];
}

/** A ticket the change mentions, as its ticket system has it: untrusted text, like the PR's. */
export interface Ticket {
  /** As the change mentions it: "#12", "owner/repo#12", "PROJ-7". */
  id: string;
  title: string;
  body: string;
  /** Where a person reads it; null when the source has no page for it. */
  url: string | null;
  /** "open", "closed", "In Progress": the source's own word. */
  state: string;
}

/** One file's lines that changed between two sides, as the diff has them (no context lines). */
export interface ChangedLines {
  path: string;
  added: string[];
  removed: string[];
}

/** git couldn't answer: a ref it doesn't know, a command that failed. Said to the person as it is. */
export class GitError extends Error {}

/** Another run holds the recordings' lock, and its process is still running. */
export class LibraryBusy extends Error {
  constructor(
    readonly holder: number,
    readonly lockFile: string,
  ) {
    super(`process ${holder} holds ${lockFile}`);
  }
}
