// GitHub Issues as a ticket source, through the person's own `gh` login: read only.
import type { Ticket, TicketSource } from "@runshape/kernel";

import { GH_TIMEOUT_MS, GhError, ghJson } from "./gh";

/**
 * "#12" or "owner/repo#12", not inside a word, a path or an HTML entity ("page#4", "&#39;").
 * Issue numbers never start with 0, so "#000" and "#000000" aren't ones; a CSS colour after
 * "color:", "background:" and the like isn't either. An id is only ever passed to gh after it
 * matches ID whole, so a mention can't become a flag.
 */
const MENTION = /(?<![\w&/.#-])(?<!(?:colou?r|background|border|fill|stroke)[\w-]*:\s*)((?:[\w.-]+\/[\w.-]+)?#[1-9]\d*)\b/gi;
const ID = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/;
const FIELDS = "number,title,body,url,state";
/** gh's own words when there's no issue by that number: a mention isn't always a ticket. */
const NOT_AN_ISSUE = /Could not resolve to an issue or pull request with the number of/i;

export class GhIssues implements TicketSource {
  readonly name = "GitHub Issues";

  constructor(
    private readonly root: string,
    private readonly command = "gh",
    /** Other repositories ("owner/repo") whose issues may be read when only mentioned: the person's say-so, not a PR author's. */
    private readonly allowedRepositories: string[] = [],
    private readonly timeoutMs = GH_TIMEOUT_MS,
  ) {}

  mentions(text: string): string[] {
    return [...new Set([...text.matchAll(MENTION)].map((match) => match[1]!))];
  }

  /** "owner/repo#12" names another repository, unless the person allowed it; "#12" is this one's. */
  elsewhere(id: string): boolean {
    const repository = id.match(ID)?.[1];
    return repository !== undefined && !this.allowedRepositories.some((allowed) => allowed.toLowerCase() === repository.toLowerCase());
  }

  /** The issue; null when there's none by that number, or the number is a pull request's. */
  async ticket(id: string): Promise<Ticket | null> {
    const parsed = id.match(ID);
    if (parsed === null) return null;
    const [, repository, number] = parsed;
    const args = ["issue", "view", number!, "--json", FIELDS, ...(repository === undefined ? [] : ["--repo", repository])];
    try {
      const issue = await ghJson<{ title: string; body: string | null; url: string; state: string }>(this.command, this.root, args, this.timeoutMs);
      // gh answers a PR's number too: a PR isn't a ticket, it's the change itself (or another).
      if (/\/pull\/\d+$/.test(issue.url)) return null;
      return { id, title: issue.title, body: issue.body ?? "", url: issue.url, state: issue.state.toLowerCase() };
    } catch (error) {
      if (error instanceof GhError && NOT_AN_ISSUE.test(error.stderr)) return null;
      throw error;
    }
  }
}
