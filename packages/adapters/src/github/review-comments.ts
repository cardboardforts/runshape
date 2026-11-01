// A finished review posted to its pull request, through the person's own `gh` login. Posting
// is outward and can't be taken back: the app shows `preview` and delivers only on the
// person's say-so (the CLI's --post). Names in the review come from the code under review, so
// they go out as plain text: no mentions, links or HTML of the PR author's choosing.
import { CommentDelivery, CommentPreview, CommentSink, CommentTarget, FinishedReview, plainMarkdown, ReviewVerdict } from "@runshape/kernel";

import { GH_TIMEOUT_MS, GhError, ghJson, runGh } from "./gh";

/** GitHub's own limit on a review's body. */
export const GITHUB_REVIEW_BODY_LIMIT = 65_536;
/** Posting gets longer than reading: a slow GitHub shouldn't make a review look failed when it went through. */
export const GH_POST_TIMEOUT_MS = 60_000;

/** The REST API's word for each verdict. */
const VERDICT_EVENT: Record<ReviewVerdict, string> = {
  [ReviewVerdict.Comment]: "COMMENT",
  [ReviewVerdict.Approve]: "APPROVE",
  [ReviewVerdict.RequestChanges]: "REQUEST_CHANGES",
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
    private readonly postTimeoutMs = GH_POST_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(number) || number < 1) throw new Error(`a pull request's number is a whole number from 1, not ${number}`);
    this.name = `GitHub pull request #${number}`;
  }

  /** Where it would go (the PR's own URL, asked of gh) and exactly what it would post. */
  async preview(review: FinishedReview): Promise<CommentPreview> {
    const pr = await this.pullRequest(review);
    return { where: pr.url, text: reviewBody(review) };
  }

  /**
   * Posts it as one review of the commit that was reviewed, to the repository in the PR's URL
   * (not whatever this checkout's default is). A review of another PR, or of a PR that has
   * moved on, is refused before anything is posted; GitHub pins the review to `commit_id`, so
   * a push between that check and the post can't make it a review of unreviewed code.
   */
  async deliver(review: FinishedReview): Promise<CommentDelivery> {
    const pr = await this.pullRequest(review);
    const text = reviewBody(review);
    if (text.length > GITHUB_REVIEW_BODY_LIMIT) throw new Error(`the review is ${text.length} characters; GitHub takes ${GITHUB_REVIEW_BODY_LIMIT}: nothing posted`);
    if (pr.headRefOid !== review.change.head.commit) {
      throw new Error(`pull request #${this.number} is at ${pr.headRefOid.slice(0, 12)}, but this review is of ${review.change.head.commit.slice(0, 12)}: compare it again; nothing posted`);
    }
    // The body through stdin, as JSON: never an argument, whatever it holds.
    const payload = JSON.stringify({ commit_id: review.change.head.commit, body: text, event: VERDICT_EVENT[review.verdict] });
    try {
      await runGh(this.command, this.root, ["api", "--method", "POST", `repos/${pr.repository}/pulls/${this.number}/reviews`, "--input", "-"], this.postTimeoutMs, payload);
    } catch (error) {
      if (error instanceof GhError && error.timedOut) {
        throw new Error(`no answer from GitHub in ${this.postTimeoutMs / 1000} s: the review may have been posted. Look at ${pr.url} before sending it again`);
      }
      throw error;
    }
    return { where: pr.url, comments: review.comments.length };
  }

  /** The PR: by the URL the review recorded when it has one (which must be this PR), else as gh finds it here. */
  private async pullRequest(review: FinishedReview): Promise<{ url: string; repository: string; headRefOid: string }> {
    const reviewed = review.change.pullRequest;
    if (reviewed !== null && reviewed.number !== this.number) throw new Error(`this review is of pull request #${reviewed.number}, not #${this.number}: nothing posted`);
    const asked = reviewed?.url ?? String(this.number);
    const pr = await ghJson<{ url: string; headRefOid: string }>(this.command, this.root, ["pr", "view", asked, "--json", "url,headRefOid"], this.timeoutMs);
    const parsed = pr.url.match(PULL_REQUEST_URL);
    if (parsed === null || Number(parsed[2]) !== this.number) throw new Error(`gh found ${pr.url} for pull request #${this.number}: nothing posted`);
    return { url: pr.url, repository: parsed[1]!, headRefOid: pr.headRefOid };
  }
}

/** "https://github.com/owner/repo/pull/7": the repository and number a review is posted to. */
const PULL_REQUEST_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;

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
