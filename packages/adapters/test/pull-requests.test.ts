/**
 * The pull requests asking for the person's review, through their own `gh`: what's asked of it
 * (read only: a list, as JSON) and how its answer is read, against a stand-in script.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { GhPullRequests } from "../src/github/pull-requests";

test("asks gh for the open PRs requesting my review, as JSON, and reads each author's login", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runshape-gh-"));
  const seen = join(directory, "seen.txt");
  const listed = [{ number: 7, title: "Teach orders to refuse", url: "u", author: { login: "teammate" }, baseRefName: "main", headRefName: "pr-7", headRefOid: "abc", isCrossRepository: true, updatedAt: "t" }];
  const command = join(directory, "gh");
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$@" > "${seen}"\necho '${JSON.stringify(listed)}'\n`);
  chmodSync(command, 0o755);

  const prs = await new GhPullRequests(directory, command).requestingMyReview(5);

  expect({ asked: readFileSync(seen, "utf8").trim().split("\n"), prs }).toEqual({
    asked: ["pr", "list", "--search", "review-requested:@me", "--state", "open", "--limit", "5", "--json", "number,title,url,author,baseRefName,headRefName,headRefOid,isCrossRepository,updatedAt"],
    prs: [{ ...listed[0], author: "teammate" }],
  });
});
