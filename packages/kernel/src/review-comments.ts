// A review in progress: what the reviewer checked off and the comments they left, pinned to
// what they're about, and the port those comments leave through (a PR on GitHub, a local
// agent's revision request). The review module builds these; the sinks are adapters.
import type { ReviewPage } from "./review-page";

/**
 * What a comment is about. A thread (changed functions with the same workflows through them)
 * is the region a reviewer follows; the change is the review as a whole.
 */
export type CommentTarget =
  | { kind: "change" }
  | { kind: "thread"; functions: CommentFunction[] }
  | { kind: "function"; function: CommentFunction }
  | { kind: "test"; id: string; name: string };

export interface CommentFunction {
  name: string;
  namespace: string;
}

export interface ReviewComment {
  /** The reviewable's key it was left on ("function:app.services.articles:get_slug"). */
  key: string;
  target: CommentTarget;
  /** The reviewer's own words. */
  body: string;
  /** ISO 8601, UTC. */
  at: string;
}

export enum ReviewVerdict {
  /** Comments only: neither approving nor blocking. */
  Comment = "comment",
  Approve = "approve",
  RequestChanges = "request-changes",
}

/** Which comparison the review is of, and the pull request it's for when there is one. */
export interface ReviewedChange {
  /** The review's folder (".runshape/reviews/<name>"): base and head recording ids. */
  review: string;
  base: { recording: string; commit: string };
  head: { asked: string; recording: string; commit: string; subject: string };
  pullRequest: { number: number; url: string | null } | null;
}

/** Something a reviewer checked off, with what it looked like when they did. */
export interface CheckedOff {
  key: string;
  fingerprint: string;
}

/** review-draft.json, beside the review it's of. */
export interface ReviewDraft {
  format: "runshape-review-draft";
  version: 1;
  change: ReviewedChange;
  checked: CheckedOff[];
  comments: ReviewComment[];
  /**
   * The last preview shown for a sink that posts outward: where, and a digest of exactly what it
   * would send. Posting sends only that; anything else needs a new preview first.
   */
  previewed?: { where: string; digest: string } | null;
}

/** A finished review, on its way out through a sink. */
export interface FinishedReview {
  change: ReviewedChange;
  verdict: ReviewVerdict;
  comments: ReviewComment[];
}

/** What a sink would send, and where, exactly: shown to the person before anything leaves. */
export interface CommentPreview {
  /** "github.com/acme/shop/pull/7", ".runshape/revisions/<name>.json". */
  where: string;
  text: string;
}

export interface CommentDelivery {
  where: string;
  comments: number;
}

/**
 * Port: where a finished review's comments go. `preview` sends nothing; `deliver` sends what
 * `preview` showed. A sink that posts outward is only delivered to after the person has seen
 * the preview and said so: the app asks, the sink never decides.
 */
export interface CommentSink {
  /** "GitHub pull request #7", "revision request for a local agent". */
  readonly name: string;
  /** May ask the system where it would go (the PR's own URL), but sends nothing. */
  preview(review: FinishedReview): Promise<CommentPreview>;
  deliver(review: FinishedReview): Promise<CommentDelivery>;
}

/** Port: the reviews kept beside the recordings, as the review module reads and writes them. */
export interface KeptReviewDrafts {
  /** The PR page (page.json); null when there's no such review. Throws when it's there but isn't one it can read. */
  page(name: string): Promise<ReviewPage | null>;
  /** The draft; null before anything was checked or commented. Throws when it's there but isn't a version 1 draft. */
  draft(name: string): Promise<ReviewDraft | null>;
  saveDraft(name: string, draft: ReviewDraft): Promise<void>;
}
