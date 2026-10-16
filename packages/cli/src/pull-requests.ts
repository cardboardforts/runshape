// The pull requests asking for the person's review, through their own `gh` login: read only.
import { execFile } from "node:child_process";

import type { PullRequests, PullRequestSummary } from "./recordings";

const FIELDS = "number,title,url,author,baseRefName,headRefName,headRefOid,isCrossRepository,updatedAt";

export class GhPullRequests implements PullRequests {
  constructor(
    private readonly root: string,
    private readonly command = "gh",
  ) {}

  requestingMyReview(limit: number): Promise<PullRequestSummary[]> {
    const args = ["pr", "list", "--search", "review-requested:@me", "--state", "open", "--limit", String(limit), "--json", FIELDS];
    return new Promise((resolve, reject) => {
      execFile(this.command, args, { cwd: this.root, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) return reject(new Error(`gh pr list: ${stderr.trim() || error.message}`));
        const listed = JSON.parse(stdout) as (Omit<PullRequestSummary, "author"> & { author: { login: string } | null })[];
        resolve(listed.map((pr) => ({ ...pr, author: pr.author?.login ?? "unknown" })));
      });
    });
  }
}
