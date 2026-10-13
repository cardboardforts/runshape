import { Op } from "../align";
import { Outcome, Phase, Run } from "../model";
import { ZoneRules } from "../zones";
import { FINE_GROUPING, Grouping } from "./components";
import { diffExecution } from "./execution-diff";
import { Change, diffRuns } from "./run-diff";

/**
 * A pull request reviewed by its behaviour: every test run on the base and on the head,
 * sorted by what a reviewer should look at first. Red tests already get attention; the
 * signal this exists for is the test that is still green but now executes differently —
 * a real user journey whose route through the code changed without anyone being told.
 */
export enum ReviewCategory {
  NowFailing = "now-failing",
  SilentChange = "silent-change",
  NowPassing = "now-passing",
  Added = "added",
  Removed = "removed",
  Unchanged = "unchanged",
}

export const REVIEW_ORDER = [
  ReviewCategory.NowFailing,
  ReviewCategory.SilentChange,
  ReviewCategory.NowPassing,
  ReviewCategory.Added,
  ReviewCategory.Removed,
  ReviewCategory.Unchanged,
];

export interface ReviewItem {
  scenarioId: string;
  name: string;
  category: ReviewCategory;
  outcomeBefore: Outcome | null;
  outcomeAfter: Outcome | null;
  /** Functions this test calls now and never did before (not merely under a new caller). */
  newCalls: string[];
  /** Functions it no longer calls at all. */
  goneCalls: string[];
  /** Calls that still happen, under a different caller. */
  movedCalls: number;
  queriesAdded: string[];
  queriesRemoved: string[];
  /** Functions whose executed statements differ. */
  changedPaths: string[];
  /** Sort key within a category: how much moved. */
  weight: number;
  /** False when the executions were too different to align call by call. */
  aligned: boolean;
}

export interface ReviewSummary {
  base: { createdAt: string; recorder: string | null };
  head: { createdAt: string; recorder: string | null };
  caveats: string[];
  counts: Record<ReviewCategory, number>;
  items: ReviewItem[];
}

const IMPORT_TIME = "<module>";
const FAILING = new Set([Outcome.Failed, Outcome.Error, Outcome.UnexpectedPass]);

export function buildReview(
  base: Run,
  head: Run,
  options: { phases?: Phase[]; grouping?: Grouping; rules?: ZoneRules } = {},
): ReviewSummary {
  const phases = options.phases ?? [Phase.Call];
  const grouping = options.grouping ?? FINE_GROUPING;
  const diff = diffRuns(base, head, { phases, grouping, rules: options.rules });
  const items: ReviewItem[] = [];

  for (const scenario of diff.scenarios) {
    const before = base.scenario(scenario.id);
    const after = head.scenario(scenario.id);
    let newCalls: string[] = [];
    let goneCalls: string[] = [];
    let movedCalls = 0;
    let aligned = true;
    if (before && after) {
      const execution = diffExecution(before, after, phases);
      aligned = execution.complete;
      // Module bodies run at import time, when whichever test happens to import first pays
      // for it: not something this test chose to do.
      const meaningful = execution.calls.filter((c) => c.qualname !== IMPORT_TIME);
      newCalls = unique(meaningful.filter((c) => c.op === Op.Added && !c.reparented).map((c) => c.qualname));
      goneCalls = unique(meaningful.filter((c) => c.op === Op.Removed && !c.reparented).map((c) => c.qualname));
      movedCalls = execution.calls.filter((c) => c.op === Op.Added && c.reparented).length;
    }
    const category = categorize(scenario.change, scenario.outcomeBefore, scenario.outcomeAfter);
    items.push({
      scenarioId: scenario.id,
      name: scenario.name,
      category,
      outcomeBefore: scenario.outcomeBefore,
      outcomeAfter: scenario.outcomeAfter,
      newCalls,
      goneCalls,
      movedCalls,
      queriesAdded: scenario.statementsAdded,
      queriesRemoved: scenario.statementsRemoved,
      // A function that is new or gone already says its lines changed.
      changedPaths: scenario.functionsChanged.map((fn) => fn.qualname).filter((name) => !newCalls.includes(name) && !goneCalls.includes(name)),
      weight:
        newCalls.length * 3 + goneCalls.length * 3 + scenario.statementsAdded.length * 2 + scenario.statementsRemoved.length * 2 +
        scenario.functionsChanged.length + movedCalls,
      aligned,
    });
  }

  items.sort((a, b) => REVIEW_ORDER.indexOf(a.category) - REVIEW_ORDER.indexOf(b.category) || b.weight - a.weight || a.name.localeCompare(b.name));
  const counts = Object.fromEntries(REVIEW_ORDER.map((c) => [c, 0])) as Record<ReviewCategory, number>;
  for (const item of items) counts[item.category] += 1;
  return {
    base: { createdAt: base.createdAt, recorder: base.recorderVersion },
    head: { createdAt: head.createdAt, recorder: head.recorderVersion },
    caveats: diff.caveats,
    counts,
    items,
  };
}

function categorize(change: Change, before: Outcome | null, after: Outcome | null): ReviewCategory {
  if (change === Change.Added) return ReviewCategory.Added;
  if (change === Change.Removed) return ReviewCategory.Removed;
  const failedBefore = before !== null && FAILING.has(before);
  const failsNow = after !== null && FAILING.has(after);
  if (failsNow && !failedBefore) return ReviewCategory.NowFailing;
  if (failedBefore && !failsNow) return ReviewCategory.NowPassing;
  if (before !== after && after === Outcome.Passed) return ReviewCategory.NowPassing; // e.g. xfail fixed
  if (change === Change.Changed) return ReviewCategory.SilentChange;
  return ReviewCategory.Unchanged;
}

/** One line a reviewer can scan: what this test does differently now. */
export function describeChange(item: ReviewItem): string {
  const parts: string[] = [];
  if (!item.aligned) parts.push("executions too different to line up call by call");
  if (item.newCalls.length) parts.push(`now calls ${list(item.newCalls)}`);
  if (item.goneCalls.length) parts.push(`no longer calls ${list(item.goneCalls)}`);
  if (item.movedCalls) parts.push(`${item.movedCalls} call${item.movedCalls === 1 ? "" : "s"} moved under a new caller`);
  if (item.queriesAdded.length) parts.push(`+${item.queriesAdded.length} external call${item.queriesAdded.length === 1 ? "" : "s"}`);
  if (item.queriesRemoved.length) parts.push(`−${item.queriesRemoved.length} external call${item.queriesRemoved.length === 1 ? "" : "s"}`);
  if (item.changedPaths.length) parts.push(`different lines run in ${list(item.changedPaths)}`);
  if (item.outcomeBefore !== item.outcomeAfter) parts.unshift(`${item.outcomeBefore ?? "—"} → ${item.outcomeAfter ?? "—"}`);
  return parts.join("; ") || "no difference";
}

const HEADINGS: Record<ReviewCategory, string> = {
  [ReviewCategory.NowFailing]: "Now failing",
  [ReviewCategory.SilentChange]: "Still passing, but now run differently",
  [ReviewCategory.NowPassing]: "Now passing",
  [ReviewCategory.Added]: "New tests",
  [ReviewCategory.Removed]: "Removed tests",
  [ReviewCategory.Unchanged]: "Unchanged",
};

const MAX_LISTED = 5;

/** Markdown for a PR comment. Test names and function names only; no SQL text or source. */
export function reviewMarkdown(summary: ReviewSummary): string {
  const out: string[] = ["## Behaviour changes (Runshape)", ""];
  const total = summary.items.length;
  out.push(`${total} tests recorded on the base and on this branch.`, "");
  const silent = summary.counts[ReviewCategory.SilentChange];
  if (silent > 0) {
    out.push(`**${silent} test${silent === 1 ? " still passes" : "s still pass"} but now ${silent === 1 ? "runs" : "run"} differently** — the changes a green CI won't show you.`, "");
  }
  for (const category of REVIEW_ORDER) {
    if (category === ReviewCategory.Unchanged) continue;
    const items = summary.items.filter((item) => item.category === category);
    if (items.length === 0) continue;
    out.push(`### ${HEADINGS[category]} (${items.length})`, "", "| Test | What changed |", "|---|---|");
    for (const item of items) out.push(`| \`${escapeCell(item.name)}\` | ${escapeCell(describeChange(item))} |`);
    out.push("");
  }
  out.push(`${summary.counts[ReviewCategory.Unchanged]} tests behave exactly as before.`);
  for (const caveat of summary.caveats) out.push("", `> ${caveat}`);
  return `${out.join("\n")}\n`;
}

function list(names: string[]): string {
  const shown = names.slice(0, MAX_LISTED).map((name) => `\`${name}\``).join(", ");
  return names.length > MAX_LISTED ? `${shown} and ${names.length - MAX_LISTED} more` : shown;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
