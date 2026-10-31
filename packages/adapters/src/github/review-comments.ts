// A finished review posted to its pull request, through the person's own `gh` login. Posting
// is outward and can't be taken back: the app shows `preview` and delivers only on the
// person's say-so (the CLI's --post). Names in the review come from the code under review, so
// they go out as plain text: no mentions, links or HTML of the PR author's choosing.
import { CommentDelivery, CommentPreview, CommentSink, CommentTarget, FinishedReview, plainMarkdown, ReviewVerdict } from "@runshape/kernel";

import { GH_TIMEOUT_MS, ghJson, runGh } from "./gh";

/** GitHub's own limit on a review's body. */
export const GITHUB_REVIEW_BODY_LIMIT = 65_536;

const VERDICT_FLAG: Record<ReviewVerdict, string> = {
  [ReviewVerdict.Comment]: "--comment",
  [ReviewVerdict.Approve]: "--approve",
  [ReviewVerdict.RequestChanges]: "--request-changes",
};

const VERDICT_HEADING: Record<ReviewVerdict, string> = {
  [ReviewVerdict.Comment]: "comments",
  [ReviewVerdict.Approve]: "approved",
  [ReviewVerdict.RequestChanges]: "changes requested",
};

export class GhPullRequestReview implements CommentSink {
  readonly name: string;

  constructor(
    private readonly root: string,
    private readonly number: number,
    private readonly command = "gh",
    private readonly timeoutMs = GH_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(number) || number < 1) throw new Error(`a pull request's number is a whole number from 1, not ${number}`);
    this.name = `GitHub pull request #${number}`;
  }

  preview(review: FinishedReview): CommentPreview {
    return { where: `pull request #${this.number}`, text: reviewBody(review) };
  }

  /**
   * Posts it as one review, after checking it's this PR's and of the PR as it is now: a review
   * of an older push, or of another PR, is refused rather than posted.
   */
  async deliver(review: FinishedReview): Promise<CommentDelivery> {
    const { where, text } = this.preview(review);
    const reviewedPr = review.change.pullRequest?.number ?? null;
    if (reviewedPr !== null && reviewedPr !== this.number) throw new Error(`this review is of pull request #${reviewedPr}, not #${this.number}: nothing posted`);
    if (text.length > GITHUB_REVIEW_BODY_LIMIT) throw new Error(`the review is ${text.length} characters; GitHub takes ${GITHUB_REVIEW_BODY_LIMIT}: nothing posted`);
    const pr = await ghJson<{ headRefOid: string }>(this.command, this.root, ["pr", "view", String(this.number), "--json", "headRefOid"], this.timeoutMs);
    if (pr.headRefOid !== review.change.head.commit) {
      throw new Error(`pull request #${this.number} is at ${pr.headRefOid.slice(0, 12)}, but this review is of ${review.change.head.commit.slice(0, 12)}: compare it again; nothing posted`);
    }
    // Arguments as they are, never through a shell: the body can hold anything.
    await runGh(this.command, this.root, ["pr", "review", String(this.number), VERDICT_FLAG[review.verdict], "--body", text], this.timeoutMs);
    return { where, comments: review.comments.length };
  }
}

/** The review as the PR shows it: what was reviewed, then each comment under what it's about. */
export function reviewBody(review: FinishedReview): string {
  const { head, base } = review.change;
  const lines = [
    `### Runshape review: ${VERDICT_HEADING[review.verdict]}`,
    "",
    `Reviewed by behaviour: ${plainMarkdown(head.subject)} (${head.commit.slice(0, 12)}) against ${base.commit.slice(0, 12)}.`,
  ];
  for (const comment of review.comments) lines.push("", `**${about(comment.target)}**`, "", comment.body);
  return `${lines.join("\n")}\n`;
}

function about(target: CommentTarget): string {
  switch (target.kind) {
    case "change":
      return "On the change";
    case "thread":
      return `On the thread through ${target.functions.map((fn) => plainMarkdown(`${fn.namespace}.${fn.name}`)).join(", ")}`;
    case "function":
      return `On ${plainMarkdown(target.function.name)} (${plainMarkdown(target.function.namespace)})`;
    case "test":
      return `On test ${plainMarkdown(target.name)}`;
  }
}
