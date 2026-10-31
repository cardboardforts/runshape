// GitHub Issues as a ticket source, through the person's own `gh` login: read only.
import type { Ticket, TicketSource } from "@runshape/kernel";

import { GhError, ghJson } from "./gh";

/**
 * "#12" or "owner/repo#12", not inside a word, a path or an HTML entity ("page#4", "&#39;"). An
 * id is only ever passed to gh after it matches this whole, so a mention can't become a flag.
 */
const MENTION = /(?<![\w&/.#-])((?:[\w.-]+\/[\w.-]+)?#\d+)\b/g;
const ID = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/;
const FIELDS = "number,title,body,url,state";
/** What gh says when there's no issue by that number: a mention isn't always a ticket. */
const NOT_AN_ISSUE = /could not resolve to an issue|not found/i;

export class GhIssues implements TicketSource {
  readonly name = "GitHub Issues";

  constructor(
    private readonly root: string,
    private readonly command = "gh",
  ) {}

  mentions(text: string): string[] {
    return [...new Set([...text.matchAll(MENTION)].map((match) => match[1]!))];
  }

  /** The issue; null when there's none by that number, or the number is a pull request's. */
  async ticket(id: string): Promise<Ticket | null> {
    const parsed = id.match(ID);
    if (parsed === null) return null;
    const [, repository, number] = parsed;
    const args = ["issue", "view", number!, "--json", FIELDS, ...(repository === undefined ? [] : ["--repo", repository])];
    try {
      const issue = await ghJson<{ title: string; body: string | null; url: string; state: string }>(this.command, this.root, args);
      // gh answers a PR's number too: a PR isn't a ticket, it's the change itself (or another).
      if (/\/pull\/\d+$/.test(issue.url)) return null;
      return { id, title: issue.title, body: issue.body ?? "", url: issue.url, state: issue.state.toLowerCase() };
    } catch (error) {
      if (error instanceof GhError && NOT_AN_ISSUE.test(error.stderr)) return null;
      throw error;
    }
  }
}
