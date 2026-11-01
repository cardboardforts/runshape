import { CommentTarget, FinishedReview, ReviewComment, ReviewDraft, ReviewedChange, ReviewPage, ReviewVerdict } from "@runshape/kernel";

import { findReviewable, Reviewable, WHOLE_CHANGE } from "./reviewables";

/** GitHub refuses a review body past 65,536 characters; a comment this long is a document, not a comment. */
export const MAX_COMMENT_LENGTH = 10_000;

/** An edit to a draft, with every reason a part of it was refused (the rest still applies). */
export interface DraftEdit {
  draft: ReviewDraft;
  errors: string[];
}

export enum ReviewState {
  ToReview = "to-review",
  Checked = "checked",
  /** Checked, but the review now shows something else: a later comparison changed it. */
  ChangedSinceChecked = "changed-since-checked",
}

export interface ReviewProgress {
  item: Reviewable;
  state: ReviewState;
  comments: ReviewComment[];
}

/** An empty draft of a review of this page. */
export function startDraft(name: string, page: ReviewPage): ReviewDraft {
  return { format: "runshape-review-draft", version: 1, change: reviewedChange(name, page), checked: [], comments: [] };
}

/**
 * The draft against a review page made again (a new compare of the working tree replaces it):
 * which review it's of is the page's, and what was checked stays, to be told apart by
 * `progress`.
 */
export function draftFor(name: string, page: ReviewPage, saved: ReviewDraft | null): ReviewDraft {
  return saved === null ? startDraft(name, page) : { ...saved, change: reviewedChange(name, page) };
}

export function checkOff(draft: ReviewDraft, items: Reviewable[], named: string[]): DraftEdit {
  const errors: string[] = [];
  const checked = new Map(draft.checked.map((entry) => [entry.key, entry]));
  for (const name of named) {
    if (name === WHOLE_CHANGE) {
      errors.push("the change as a whole isn't checked off: send it with --approve");
      continue;
    }
    const item = findReviewable(items, name);
    if (item === null) errors.push(unknown(name));
    else checked.set(item.key, { key: item.key, fingerprint: item.fingerprint });
  }
  return { draft: { ...draft, checked: [...checked.values()] }, errors };
}

export function addComment(draft: ReviewDraft, items: Reviewable[], named: string, body: string, at: Date): DraftEdit {
  const errors: string[] = [];
  const text = body.trim();
  let target: { key: string; target: CommentTarget } | null = null;
  if (named === WHOLE_CHANGE) target = { key: WHOLE_CHANGE, target: { kind: "change" } };
  else {
    const item = findReviewable(items, named);
    if (item === null) errors.push(unknown(named));
    else target = { key: item.key, target: item.target };
  }
  if (text.length === 0) errors.push("a comment needs some text");
  if (text.length > MAX_COMMENT_LENGTH) errors.push(`a comment is at most ${MAX_COMMENT_LENGTH} characters; this one is ${text.length}`);
  if (errors.length > 0 || target === null) return { draft, errors };
  return { draft: { ...draft, comments: [...draft.comments, { ...target, body: text, at: at.toISOString() }] }, errors };
}

/** Each reviewable, whether it's checked (and still as it was), and the comments on it. */
export function progress(draft: ReviewDraft, items: Reviewable[]): ReviewProgress[] {
  const checked = new Map(draft.checked.map((entry) => [entry.key, entry.fingerprint]));
  return items.map((item) => {
    const was = checked.get(item.key);
    const state = was === undefined ? ReviewState.ToReview : was === item.fingerprint ? ReviewState.Checked : ReviewState.ChangedSinceChecked;
    return { item, state, comments: draft.comments.filter((comment) => comment.key === item.key) };
  });
}

/** Comments left on the change as a whole, or on something a later comparison no longer shows. */
export function unpinnedComments(draft: ReviewDraft, items: Reviewable[]): ReviewComment[] {
  const keys = new Set(items.map((item) => item.key));
  return draft.comments.filter((comment) => !keys.has(comment.key));
}

/**
 * The review to send. Approving needs nothing; commenting or asking for changes needs a
 * comment, or there's nothing to say.
 */
export function finishReview(draft: ReviewDraft, verdict: ReviewVerdict): { review: FinishedReview | null; errors: string[] } {
  if (verdict !== ReviewVerdict.Approve && draft.comments.length === 0) {
    return { review: null, errors: ["no comments to send: leave one with `review <name> comment <what> -- <text>`"] };
  }
  return { review: { change: draft.change, verdict, comments: draft.comments }, errors: [] };
}

function reviewedChange(name: string, page: ReviewPage): ReviewedChange {
  const pr = page.story?.pullRequest ?? null;
  return {
    review: name,
    base: { recording: page.base.recording, commit: page.base.commit },
    head: { asked: page.head.asked, recording: page.head.recording, commit: page.head.commit, subject: page.head.subject },
    pullRequest: pr === null ? null : { number: pr.number, url: pr.url },
  };
}

function unknown(name: string): string {
  return `nothing in this review is called ${name}: \`review <name>\` lists what is`;
}
