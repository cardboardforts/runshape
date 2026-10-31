// What the change is for, as the people asking for it said: the pull request, the tickets it
// and its commits mention, and the docs and comments it changed. See story.test.ts.
import type { ChangedLines, CommitMessage, PullRequestStory, TicketSource } from "@runshape/kernel";
import type { StoryContext } from "@runshape/explainer";

/** Where the story's words came from: a doc file's lines, or a source file's comment lines. */
export enum NoteKind {
  Doc = "doc",
  Comments = "comments",
}

/**
 * The story as the review bundle keeps it: titles, links and counts. Bodies, ticket text and the
 * changed lines go to the explainer only: a bundle may be stored centrally, and a ticket from a
 * private tracker shouldn't end up in a PR comment.
 */
export interface ReviewStory {
  pullRequest: { number: number; title: string; url: string | null } | null;
  tickets: { id: string; source: string; title: string; url: string | null; state: string }[];
  /** Mentioned, but not read: no such ticket, the source failed, or past the limit. */
  unread: { id: string; source: string; reason: string }[];
  /** The docs and the source files whose comments changed, with how many lines each way. */
  notes: { path: string; kind: NoteKind; added: number; removed: number }[];
}

/** What the story is gathered from: everything here is the change's authors' (or a ticket writer's) text. */
export interface StorySources {
  commits: CommitMessage[];
  /** The pull request; null for a comparison of branches or commits. */
  pullRequest: PullRequestStory | null;
  /** Set when the pull request couldn't be read: its number and why. */
  pullRequestProblem?: { number: number; reason: string };
  changed: ChangedLines[];
}

export interface GatheredStory {
  /** For the bundle (review.json, review.md, the PR page). */
  story: ReviewStory;
  /** For the explainer, which reads the text itself. */
  context: StoryContext;
}

/** More tickets than this is a change that mentions everything: the first ones are read, the rest listed. */
export const MAX_TICKETS = 8;
/** A PR body or ticket past this is cut for the model: the start says what it's for; pasted logs follow. */
export const MAX_STORY_TEXT = 4000;
/** Docs and commented files past these are counted in the bundle but not sent: a big docs rewrite would crowd out the review. */
export const MAX_NOTE_FILES = 20;
export const MAX_NOTE_LINES = 40;
const MAX_NOTE_LINE = 300;
/** A reason past this is a tool's stderr in full: the start says what failed. */
export const MAX_REASON = 200;
export const NOT_LINKED = "another repository's issue, not linked by the PR";

function shortReason(reason: string): string {
  return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON)}…` : reason;
}

/**
 * Reads the story: the PR's linked issues and every ticket its text and the commit messages
 * mention, from each source, in order. A ticket that can't be read is listed with why, never
 * fatal: the review stands without it.
 */
export async function gatherStory(sources: StorySources, ticketSources: TicketSource[]): Promise<GatheredStory> {
  const { pullRequest } = sources;
  const text = [
    ...(pullRequest === null ? [] : [pullRequest.linkedIssues.join(" "), pullRequest.title, pullRequest.body]),
    ...sources.commits.map((commit) => `${commit.subject}\n${commit.body}`),
  ].join("\n");
  const story: ReviewStory = {
    pullRequest: pullRequest === null ? null : { number: pullRequest.number, title: pullRequest.title, url: webLink(pullRequest.url) },
    tickets: [],
    unread: [],
    notes: [],
  };
  if (sources.pullRequestProblem !== undefined) story.unread.push({ id: `#${sources.pullRequestProblem.number}`, source: "the pull request", reason: shortReason(sources.pullRequestProblem.reason) });
  const context: StoryContext = {
    pullRequest: pullRequest === null ? null : { number: pullRequest.number, title: pullRequest.title, body: cut(pullRequest.body) },
    tickets: [],
    notes: [],
  };
  // The PR mentioning its own number isn't a ticket.
  const own = pullRequest === null ? null : `#${pullRequest.number}`;
  const linked = new Set(pullRequest?.linkedIssues ?? []);
  let tried = 0;
  for (const source of ticketSources) {
    // Each once, whatever the source returns: the linked issue is usually in the body too.
    for (const id of new Set(source.mentions(text).filter((mentioned) => mentioned !== own))) {
      // Linked by GitHub itself, it's the PR's; only mentioned, it's anyone's say-so.
      if (source.elsewhere(id) && !linked.has(id)) {
        story.unread.push({ id, source: source.name, reason: NOT_LINKED });
        continue;
      }
      if (tried >= MAX_TICKETS) {
        story.unread.push({ id, source: source.name, reason: `more than ${MAX_TICKETS} tickets mentioned: not read` });
        continue;
      }
      tried += 1;
      try {
        const ticket = await source.ticket(id);
        if (ticket === null) {
          story.unread.push({ id, source: source.name, reason: `${source.name} has no such ticket` });
          continue;
        }
        story.tickets.push({ id, source: source.name, title: ticket.title, url: ticket.url === null ? null : webLink(ticket.url), state: ticket.state });
        context.tickets.push({ id, source: source.name, title: ticket.title, state: ticket.state, body: cut(ticket.body) });
      } catch (error) {
        story.unread.push({ id, source: source.name, reason: shortReason(error instanceof Error ? error.message : String(error)) });
      }
    }
  }
  const notes = storyNotes(sources.changed);
  story.notes = notes.map(({ path, kind, added, removed }) => ({ path, kind, added: added.length, removed: removed.length }));
  // Removed lines are counted, never sent: a deleted line is where a leaked key goes when
  // someone cleans it up, and the model is a third party.
  context.notes = notes.slice(0, MAX_NOTE_FILES).map(({ path, kind, added, removed }) => ({ path, kind, added: capped(added), removedCount: removed.length }));
  return { story, context };
}

/** A story with nothing in it: no pull request, no ticket, no doc or comment changed. */
export function storyIsEmpty(story: ReviewStory): boolean {
  return story.pullRequest === null && story.tickets.length === 0 && story.unread.length === 0 && story.notes.length === 0;
}

/** Prose files: every changed line in them is the authors saying something. */
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc)$/i;
/**
 * A line that's a comment in the languages recorded and their neighbours: //, /*, a block's *
 * (then a space: `*ptr = x;` is code), #, and docstring quotes. Not C's preprocessor
 * (#include), a shebang, or Rust's #[attribute].
 */
const COMMENT_LINE = /^(\/\/|\/\*|\*(\s|\/|$)|#(?!(include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma)\b|!|\[)|"""|''')/;
/** What's left of a comment line once its markers go: a line of only markers says nothing. */
const COMMENT_MARKERS = /^(\/\/+|\/\*+|\*+\/?|#+|"""|''')|(\*\/|"""|''')$/g;

interface Note {
  path: string;
  kind: NoteKind;
  added: string[];
  removed: string[];
}

/** The docs and comments a change touched, docs first: what the authors wrote in words, not code. */
export function storyNotes(changed: ChangedLines[]): Note[] {
  const docs: Note[] = [];
  const comments: Note[] = [];
  for (const file of changed) {
    if (DOC_FILE.test(file.path)) {
      const said = (lines: string[]) => lines.filter((line) => line.trim() !== "");
      const note = { path: file.path, kind: NoteKind.Doc, added: said(file.added), removed: said(file.removed) };
      if (note.added.length + note.removed.length > 0) docs.push(note);
      continue;
    }
    const commented = (lines: string[]) => lines.map((line) => line.trim()).filter((line) => COMMENT_LINE.test(line) && line.replace(COMMENT_MARKERS, "").trim() !== "");
    const note = { path: file.path, kind: NoteKind.Comments, added: commented(file.added), removed: commented(file.removed) };
    if (note.added.length + note.removed.length > 0) comments.push(note);
  }
  const byPath = (a: Note, b: Note) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return [...docs.sort(byPath), ...comments.sort(byPath)];
}

function capped(lines: string[]): string[] {
  const kept = lines.slice(0, MAX_NOTE_LINES).map((line) => (line.length > MAX_NOTE_LINE ? `${line.slice(0, MAX_NOTE_LINE)}…` : line));
  return lines.length > MAX_NOTE_LINES ? [...kept, `[${lines.length - MAX_NOTE_LINES} more lines not shown]`] : kept;
}

function cut(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_STORY_TEXT ? `${trimmed.slice(0, MAX_STORY_TEXT)}\n[cut: ${trimmed.length - MAX_STORY_TEXT} more characters]` : trimmed;
}

/** A link a page may draw: https only, so a ticket system's (or a fake one's) "javascript:" never becomes one. */
function webLink(url: string): string | null {
  return /^https:\/\/[^\s<>"'()]+$/.test(url) ? url : null;
}
