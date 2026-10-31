// The pull requests asking for the person's review, through their own `gh` login: read only.
import type { PullRequests, PullRequestStory, PullRequestSummary } from "@runshape/kernel";

import { ghJson, runGh } from "./gh";

const FIELDS = "number,title,url,author,baseRefName,headRefName,headRefOid,isCrossRepository,updatedAt";
const STORY_FIELDS = "number,title,body,url,closingIssuesReferences";

export class GhPullRequests implements PullRequests {
  constructor(
    private readonly root: string,
    private readonly command = "gh",
  ) {}

  /** The repository gh lists from (its default for this checkout), as a URL git can fetch. */
  async repository(): Promise<string> {
    return `${(await runGh(this.command, this.root, ["repo", "view", "--json", "url", "--jq", ".url"])).trim()}.git`;
  }

  async requestingMyReview(limit: number): Promise<PullRequestSummary[]> {
    const args = ["pr", "list", "--search", "review-requested:@me", "--state", "open", "--limit", String(limit), "--json", FIELDS];
    const listed = await ghJson<(Omit<PullRequestSummary, "author"> & { author: { login: string } | null })[]>(this.command, this.root, args);
    return listed.map((pr) => ({ ...pr, author: pr.author?.login ?? "unknown" }));
  }

  /**
   * Its title, body and the issues GitHub says it closes. An issue in the PR's own repository is
   * "#12", as its text would mention it; one elsewhere is "owner/repo#12".
   */
  async story(number: number): Promise<PullRequestStory> {
    const pr = await ghJson<{ number: number; title: string; body: string | null; url: string; closingIssuesReferences: { number: number; url: string }[] | null }>(this.command, this.root, [
      "pr",
      "view",
      String(number),
      "--json",
      STORY_FIELDS,
    ]);
    const repository = repositoryOf(pr.url);
    const linkedIssues = (pr.closingIssuesReferences ?? []).map((issue) => {
      const elsewhere = repositoryOf(issue.url);
      return elsewhere === null || elsewhere === repository ? `#${issue.number}` : `${elsewhere}#${issue.number}`;
    });
    return { number: pr.number, title: pr.title, body: pr.body ?? "", url: pr.url, linkedIssues };
  }
}

/** "owner/repo" from a github.com issue or PR page; null for anything else. */
function repositoryOf(url: string): string | null {
  return url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/\d+$/)?.[1] ?? null;
}
