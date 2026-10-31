/**
 * GitHub through the person's own `gh`: the pull requests asking for their review, one PR's
 * story (title, body, the issues it closes), and issues as tickets. Read only. What's asked of
 * gh and how its answer is read, against a stand-in script.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { GhIssues } from "../src/github/issues";
import { GhPullRequests } from "../src/github/pull-requests";

const made: string[] = [];
afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A stand-in gh: records each call's arguments, one per line, and answers with what `answer` (shell) prints. */
function fakeGh(answer: string): { directory: string; command: string; asked: () => string[][] } {
  const directory = mkdtempSync(join(tmpdir(), "runshape-gh-"));
  made.push(directory);
  const seen = join(directory, "seen.txt");
  const command = join(directory, "gh");
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${seen}"\necho >> "${seen}"\n${answer}\n`);
  chmodSync(command, 0o755);
  const asked = () => readFileSync(seen, "utf8").trim().split("\n\n").map((call) => call.split("\n"));
  return { directory, command, asked };
}

test("asks gh for the open PRs requesting my review, as JSON, and reads each author's login", async () => {
  const listed = [{ number: 7, title: "Teach orders to refuse", url: "u", author: { login: "teammate" }, baseRefName: "main", headRefName: "pr-7", headRefOid: "abc", isCrossRepository: true, updatedAt: "t" }];
  const gh = fakeGh(`echo '${JSON.stringify(listed)}'`);

  const prs = await new GhPullRequests(gh.directory, gh.command).requestingMyReview(5);

  expect({ asked: gh.asked(), prs }).toEqual({
    asked: [["pr", "list", "--search", "review-requested:@me", "--state", "open", "--limit", "5", "--json", "number,title,url,author,baseRefName,headRefName,headRefOid,isCrossRepository,updatedAt"]],
    prs: [{ ...listed[0], author: "teammate" }],
  });
});

test("a PR's story: its title and body, and the issues it closes, named as its own text would mention them", async () => {
  const viewed = {
    number: 7,
    title: "Teach orders to refuse",
    body: null, // an empty description comes back as null
    url: "https://github.com/acme/shop/pull/7",
    closingIssuesReferences: [
      { number: 12, url: "https://github.com/acme/shop/issues/12" },
      { number: 3, url: "https://github.com/acme/billing/issues/3" },
    ],
  };
  const gh = fakeGh(`echo '${JSON.stringify(viewed)}'`);

  const story = await new GhPullRequests(gh.directory, gh.command).story(7);

  expect({ asked: gh.asked(), story }).toEqual({
    asked: [["pr", "view", "7", "--json", "number,title,body,url,closingIssuesReferences"]],
    story: { number: 7, title: "Teach orders to refuse", body: "", url: "https://github.com/acme/shop/pull/7", linkedIssues: ["#12", "acme/billing#3"] },
  });
});

describe("GhIssues: GitHub Issues as tickets", () => {
  test("mentions: #12 and owner/repo#12, each once; not a URL's fragment, a word's, or an HTML entity", () => {
    const issues = new GhIssues("/nowhere");

    expect(issues.mentions("Fixes #12, see acme/billing#3 and #12 again.\nNot page#4, /docs#5, &#39; or ##6; (#7) is.")).toEqual(["#12", "acme/billing#3", "#7"]);
    // Colours in a PR about styling: no issue number starts with 0, and one after "color:" is a colour.
    expect(issues.mentions("Set color: #333, background-color:#123456 and fill: #999; was #000 or #000000. Closes #45.")).toEqual(["#45"]);
  });

  test("another repository's issue is elsewhere unless the person allowed that repository", () => {
    const issues = new GhIssues("/nowhere", "gh", ["Acme/Billing"]);

    expect(["#12", "acme/billing#3", "victim-org/private#1"].map((id) => `${id}: ${issues.elsewhere(id)}`)).toEqual(["#12: false", "acme/billing#3: false", "victim-org/private#1: true"]);
  });

  test("a gh that doesn't answer is stopped after the timeout, and says so", async () => {
    const gh = fakeGh("sleep 5");
    const started = Date.now();

    const failed = await new GhIssues(gh.directory, gh.command, [], 200).ticket("#12").then(
      () => "answered",
      (error: Error) => error.message,
    );

    expect({ failed, quick: Date.now() - started < 3000 }).toEqual({ failed: "gh issue view: no answer in 200 ms", quick: true });
  });

  test("reads an issue (in another repository with --repo); a PR's number or gh's no-issue-by-that-number is no ticket; anything else, a bare Not Found too, is an error", async () => {
    const gh = fakeGh(
      [
        'case "$3" in',
        `  12) echo '${JSON.stringify({ number: 12, title: "Orders over the limit go through", body: "Customers can overspend.", url: "https://github.com/acme/shop/issues/12", state: "OPEN" })}' ;;`,
        `  3) echo '${JSON.stringify({ number: 3, title: "Invoice totals", body: null, url: "https://github.com/acme/billing/issues/3", state: "CLOSED" })}' ;;`,
        `  7) echo '${JSON.stringify({ number: 7, title: "The PR", body: "", url: "https://github.com/acme/shop/pull/7", state: "OPEN" })}' ;;`,
        '  404) echo "GraphQL: Could not resolve to an issue or pull request with the number of 404." >&2; exit 1 ;;',
        '  *) echo "HTTP 404: Not Found (https://api.github.com/graphql)" >&2; exit 1 ;;',
        "esac",
      ].join("\n"),
    );
    const issues = new GhIssues(gh.directory, gh.command);

    const read = [];
    for (const id of ["#12", "acme/billing#3", "#7", "#404", "--repo=evil#1"]) read.push(await issues.ticket(id));
    const failed = await issues.ticket("#500").then(
      () => "read",
      (error: Error) => error.message,
    );

    expect({ read, failed, asked: gh.asked().map((call) => call.join(" ")) }).toEqual({
      read: [
        { id: "#12", title: "Orders over the limit go through", body: "Customers can overspend.", url: "https://github.com/acme/shop/issues/12", state: "open" },
        { id: "acme/billing#3", title: "Invoice totals", body: "", url: "https://github.com/acme/billing/issues/3", state: "closed" },
        null,
        null,
        // Not an id at all: never handed to gh.
        null,
      ],
      failed: "gh issue view: HTTP 404: Not Found (https://api.github.com/graphql)",
      asked: [
        "issue view 12 --json number,title,body,url,state",
        "issue view 3 --json number,title,body,url,state --repo acme/billing",
        "issue view 7 --json number,title,body,url,state",
        "issue view 404 --json number,title,body,url,state",
        "issue view 500 --json number,title,body,url,state",
      ],
    });
  });
});
