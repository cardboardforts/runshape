// What the recordings workflow (recordings.ts) needs from outside, declared here so its
// adapters (shell-recorder, docker-recorder, pull-requests) depend on these, not on the workflow.
import type { PullRequestSummary } from "@runshape/library";

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
