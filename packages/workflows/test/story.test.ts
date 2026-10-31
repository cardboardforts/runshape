/**
 * The story: what a change is for, as the people asking for it said. A reviewer shouldn't have
 * to dig through the PR, its tickets and the docs to learn what's being improved or prevented,
 * so the workflow gathers them: the PR's title and body (through gh), the issues it closes, every
 * ticket its text and its commit messages mention, and the docs and comments the change edited.
 *
 * Ticket systems are ports (TicketSource): GitHub Issues through gh is the one built. A Jira
 * source would be another adapter with its own id syntax; the fake one here shows the port
 * takes it without the workflow knowing which is which. Everything read is untrusted text:
 * the bundle keeps titles, links and counts only, and the text goes to the explainer, framed
 * as data.
 */
import { describe, expect, test } from "vitest";

import type { ChangedLines, Ticket, TicketSource } from "@runshape/kernel";
import { gatherStory, MAX_STORY_TEXT, MAX_TICKETS, storyNotes } from "../src/story";

/** A ticket source answering from a list; "#"-ids like GitHub's, or KEY-n like Jira's. */
class FakeTickets implements TicketSource {
  readonly asked: string[] = [];
  constructor(
    readonly name: string,
    private readonly pattern: RegExp,
    private readonly tickets: Record<string, Omit<Ticket, "id"> | Error>,
  ) {}
  mentions(text: string): string[] {
    return [...new Set(text.match(this.pattern) ?? [])];
  }
  async ticket(id: string): Promise<Ticket | null> {
    this.asked.push(id);
    const found = this.tickets[id];
    if (found instanceof Error) throw found;
    return found === undefined ? null : { id, ...found };
  }
}

const github = () =>
  new FakeTickets("GitHub Issues", /(?<![\w&/])#\d+/g, {
    "#12": { title: "Orders over the limit go through", body: "Customers can overspend their credit limit.", url: "https://github.com/acme/shop/issues/12", state: "open" },
    "#30": new Error("gh issue view: HTTP 401: Bad credentials"),
  });
const jira = () => new FakeTickets("Jira", /\bSHOP-\d+\b/g, { "SHOP-7": { title: "Credit limits", body: "Epic: refuse orders past a customer's limit.", url: "javascript:alert(1)", state: "In Progress" } });

describe("gatherStory", () => {
  test("a PR's story: its linked issue and what its text and commits mention, from each source; the bundle keeps titles and links, the explainer gets the text", async () => {
    const [issues, tracker] = [github(), jira()];

    const { story, context } = await gatherStory(
      {
        pullRequest: { number: 7, title: "Teach orders to refuse", body: "Part of SHOP-7. Also see #30.\n\nThis PR (#7) refuses orders past the limit.", url: "https://github.com/acme/shop/pull/7", linkedIssues: ["#12"] },
        commits: [{ commit: "c1", subject: "Refuse over-limit orders", body: "Merge pull request #99" }],
        changed: [],
      },
      [issues, tracker],
    );

    expect({ story, asked: [issues.asked, tracker.asked], context }).toEqual({
      story: {
        pullRequest: { number: 7, title: "Teach orders to refuse", url: "https://github.com/acme/shop/pull/7" },
        tickets: [
          { id: "#12", source: "GitHub Issues", title: "Orders over the limit go through", url: "https://github.com/acme/shop/issues/12", state: "open" },
          // Not https: kept as text, never a link a page would draw.
          { id: "SHOP-7", source: "Jira", title: "Credit limits", url: null, state: "In Progress" },
        ],
        unread: [
          { id: "#30", source: "GitHub Issues", reason: "gh issue view: HTTP 401: Bad credentials" },
          { id: "#99", source: "GitHub Issues", reason: "GitHub Issues has no such ticket" },
        ],
        notes: [],
      },
      // The PR's own number isn't a ticket; the linked issue is read first.
      asked: [["#12", "#30", "#99"], ["SHOP-7"]],
      context: {
        pullRequest: { number: 7, title: "Teach orders to refuse", body: "Part of SHOP-7. Also see #30.\n\nThis PR (#7) refuses orders past the limit." },
        tickets: [
          { id: "#12", source: "GitHub Issues", title: "Orders over the limit go through", state: "open", body: "Customers can overspend their credit limit." },
          { id: "SHOP-7", source: "Jira", title: "Credit limits", state: "In Progress", body: "Epic: refuse orders past a customer's limit." },
        ],
        notes: [],
      },
    });
  });

  test("limits: past MAX_TICKETS mentions are listed, not read; a long body is cut for the model; a PR that couldn't be read is said", async () => {
    const issues = github();
    const many = Array.from({ length: MAX_TICKETS + 2 }, (_, i) => `#${100 + i}`).join(" ");

    const { story, context } = await gatherStory(
      { pullRequest: null, pullRequestProblem: { number: 7, reason: "gh pr view: not logged in" }, commits: [{ commit: "c1", subject: "Lots", body: many }], changed: [] },
      [issues],
    );
    const long = await gatherStory({ pullRequest: { number: 1, title: "t", body: "x".repeat(MAX_STORY_TEXT + 5), url: "https://github.com/a/b/pull/1", linkedIssues: [] }, commits: [], changed: [] }, []);

    expect({
      asked: issues.asked.length,
      unread: story.unread.map((u) => `${u.id}: ${u.reason}`).slice(0, 1).concat(story.unread.slice(-2).map((u) => `${u.id}: ${u.reason}`)),
      readOrTried: story.unread.length,
      context: context.pullRequest,
      cut: long.context.pullRequest!.body.slice(MAX_STORY_TEXT),
    }).toEqual({
      asked: MAX_TICKETS,
      unread: ["#7: gh pr view: not logged in", `#108: more than ${MAX_TICKETS} tickets mentioned: not read`, `#109: more than ${MAX_TICKETS} tickets mentioned: not read`],
      readOrTried: MAX_TICKETS + 3,
      context: null,
      cut: "\n[cut: 5 more characters]",
    });
  });

  test("no sources and no PR: an empty story, with the changed docs and comments still in it", async () => {
    const { story, context } = await gatherStory({ pullRequest: null, commits: [], changed: [{ path: "README.md", added: ["Orders past the limit are refused."], removed: [] }] }, []);

    expect({ story, notes: context.notes }).toEqual({
      story: { pullRequest: null, tickets: [], unread: [], notes: [{ path: "README.md", kind: "doc", added: 1, removed: 0 }] },
      notes: [{ path: "README.md", kind: "doc", added: ["Orders past the limit are refused."], removed: [] }],
    });
  });
});

describe("storyNotes", () => {
  test("docs: every said line; source: only comment lines, in the languages recorded; code, preprocessor lines and bare markers aren't the authors' words", () => {
    const changed: ChangedLines[] = [
      { path: "src/orders.ts", added: ["  // Refuse past the limit: the bank charges us for overdrafts.", "  if (total > limit) throw new OrderRefused();", "  /**", "   * Why it's thrown here, not in the route.", "   */"], removed: ["  // TODO: limits"] },
      { path: "app/orders.py", added: ['    """Refuses orders past the customer\'s limit."""', "    # noqa", "    x = 1  # not a comment line: it starts with code"], removed: [] },
      { path: "native/check.c", added: ["#include <stdio.h>", "#define LIMIT 10", "// The C side checks too."], removed: [] },
      { path: "lib.rs", added: ["#[derive(Debug)]", "#!/usr/bin/env"], removed: [] },
      { path: "docs/orders.md", added: ["", "Orders past the limit are refused (#12)."], removed: ["Orders always go through."] },
      { path: "package-lock.json", added: ['"version": "2"'], removed: [] },
    ];

    expect(storyNotes(changed)).toEqual([
      { path: "docs/orders.md", kind: "doc", added: ["Orders past the limit are refused (#12)."], removed: ["Orders always go through."] },
      { path: "app/orders.py", kind: "comments", added: ['"""Refuses orders past the customer\'s limit."""', "# noqa"], removed: [] },
      { path: "native/check.c", kind: "comments", added: ["// The C side checks too."], removed: [] },
      { path: "src/orders.ts", kind: "comments", added: ["// Refuse past the limit: the bank charges us for overdrafts.", "* Why it's thrown here, not in the route."], removed: ["// TODO: limits"] },
    ]);
  });
});
