// The pull requests asking for the person's review, through their own `gh` login: read only.
import { execFile } from "node:child_process";

import type { PullRequests, PullRequestSummary } from "@runshape/kernel";

const FIELDS = "number,title,url,author,baseRefName,headRefName,headRefOid,isCrossRepository,updatedAt";

export class GhPullRequests implements PullRequests {
  /** The repository gh lists from (its default for this checkout), as a URL git can fetch. */
  repository(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.command, ["repo", "view", "--json", "url", "--jq", ".url"], { cwd: this.root, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) reject(new Error(`gh repo view: ${stderr.trim() || error.message}`));
        else resolve(`${stdout.trim()}.git`);
      });
    });
  }

  constructor(
    private readonly root: string,
    private readonly command = "gh",
  ) {}

  requestingMyReview(limit: number): Promise<PullRequestSummary[]> {
    const args = ["pr", "list", "--search", "review-requested:@me", "--state", "open", "--limit", String(limit), "--json", FIELDS];
    return new Promise((resolve, reject) => {
      execFile(this.command, args, { cwd: this.root, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) return reject(new Error(`gh pr list: ${stderr.trim() || error.message}`));
        try {
          const listed = JSON.parse(stdout) as (Omit<PullRequestSummary, "author"> & { author: { login: string } | null })[];
          resolve(listed.map((pr) => ({ ...pr, author: pr.author?.login ?? "unknown" })));
        } catch (parseError) {
          reject(new Error(`gh pr list answered something other than JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
        }
      });
    });
  }
}
