import { Change, ComparedGraphs, FINE_GROUPING, Grouping, Op, Outcome, Phase, REVIEW_ORDER, ReviewCategory, ReviewItem, ReviewSummary, Run, SymbolKind } from "@runshape/kernel";
import { diffExecution } from "./execution-diff";
import { detectMoves, Moves } from "./moves";
import { diffRuns } from "./run-diff";
import { causesByScenario, ChangedFunction, Threads } from "./threads";

const FAILING = new Set([Outcome.Failed, Outcome.Error, Outcome.UnexpectedPass]);

export function buildReview(base: Run, head: Run, graphs: ComparedGraphs, options: { phases?: Phase[]; grouping?: Grouping; moves?: Moves } = {}): ReviewSummary {
  const phases = options.phases ?? [Phase.Call];
  const grouping = options.grouping ?? FINE_GROUPING;
  const moves = options.moves ?? detectMoves(base, head);
  const diff = diffRuns(base, head, graphs, { phases, grouping, moves });
  const items: ReviewItem[] = [];

  for (const scenario of diff.scenarios) {
    const before = base.scenario(moves.baseScenarioId(scenario.id));
    const after = head.scenario(scenario.id);
    let newCalls: string[] = [];
    let goneCalls: string[] = [];
    let movedCalls = 0;
    let aligned = true;
    if (before && after) {
      const execution = diffExecution(before, after, phases, moves);
      aligned = execution.complete;
      // Module bodies run at import time, when whichever test happens to import first pays
      // for it: not something this test chose to do.
      const meaningful = execution.calls.filter((c) => c.symbol.kind !== SymbolKind.Initializer);
      newCalls = unique(meaningful.filter((c) => c.op === Op.Added && !c.reparented).map((c) => c.symbol.path));
      goneCalls = unique(meaningful.filter((c) => c.op === Op.Removed && !c.reparented).map((c) => c.symbol.path));
      movedCalls = execution.calls.filter((c) => c.op === Op.Added && c.reparented).length;
    }
    const category = reviewCategoryOf(scenario.change, scenario.outcomeBefore, scenario.outcomeAfter);
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
      // A new test has no base to differ from: every line it ran is new, so none is news.
      changedPaths: before === undefined ? [] : scenario.functionsChanged.map((fn) => fn.symbol.path).filter((name) => !newCalls.includes(name) && !goneCalls.includes(name)),
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
    moved: diff.moved,
  };
}

export function reviewCategoryOf(change: Change, before: Outcome | null, after: Outcome | null): ReviewCategory {
  if (change === Change.Removed) return ReviewCategory.Removed;
  // An expected failure is still broken code; marking it xfail on this branch hides a break.
  const broken = (outcome: Outcome | null) => outcome !== null && (FAILING.has(outcome) || outcome === Outcome.ExpectedFailure);
  // A new test that fails turns the branch's CI red: that's a failure to look at first. A new
  // test marked xfail is a known bug written down on purpose: just a new test.
  const failsNow = after !== null && FAILING.has(after);
  if (change === Change.Added) return failsNow ? ReviewCategory.NowFailing : ReviewCategory.Added;
  if (broken(after) && !broken(before)) return ReviewCategory.NowFailing;
  if (after === Outcome.Skipped) return before === Outcome.Skipped ? ReviewCategory.Unchanged : ReviewCategory.NowSkipped;
  if (after === Outcome.Passed && before !== Outcome.Passed) return ReviewCategory.NowPassing;
  if (broken(before) && broken(after)) return change === Change.Unchanged && before === after ? ReviewCategory.Unchanged : ReviewCategory.StillFailing;
  return change === Change.Changed ? ReviewCategory.SilentChange : ReviewCategory.Unchanged;
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

export const REVIEW_HEADINGS: Record<ReviewCategory, string> = {
  [ReviewCategory.NowFailing]: "Now failing",
  [ReviewCategory.SilentChange]: "Still passing, but now run differently",
  [ReviewCategory.NowPassing]: "Now passing",
  [ReviewCategory.NowSkipped]: "No longer run (skipped)",
  [ReviewCategory.StillFailing]: "Still failing",
  [ReviewCategory.Added]: "New tests",
  [ReviewCategory.Removed]: "Removed tests",
  [ReviewCategory.Unchanged]: "Unchanged",
};

const MAX_LISTED = 5;

/** A row of the review: one test, or several whose change has one cause. */
export interface ReviewRow {
  items: ReviewItem[];
  /** The changed functions they run differently, newly or no longer: empty when not known. */
  cause: ChangedFunction[];
}

/**
 * Review items as rows to read: with the threads, tests whose change has one cause (they run
 * through the same changed functions) are one row. A refactor that sends every test through
 * one new store reads as one row of 66 tests, not 66 rows saying the same thing.
 */
export function reviewRows(items: ReviewItem[], threads?: Threads): ReviewRow[] {
  if (threads === undefined) return items.map((item) => ({ items: [item], cause: [] }));
  const causes = causesByScenario(threads);
  const rows = new Map<string, ReviewRow>();
  for (const item of items) {
    const cause = causes.get(item.scenarioId) ?? [];
    // A change no changed function accounts for (a test that moved, say) stands alone.
    const key = cause.length === 0 ? `alone:${item.scenarioId}` : cause.map((fn) => fn.symbol.key).sort().join("\n");
    const row = rows.get(key);
    if (row === undefined) rows.set(key, { items: [item], cause });
    else row.items.push(item);
  }
  return [...rows.values()];
}

/** More names than this in one row is a list to open in review.json. */
const SHOWN_IN_ROW = 3;

function rowCells(row: ReviewRow): [string, string] {
  const [first] = row.items;
  if (row.items.length === 1) return [codeSpan(escapeCell(first!.name)), escapeCell(describeChange(first!))];
  const names = row.items.slice(0, SHOWN_IN_ROW).map((item) => codeSpan(escapeCell(item.name)));
  const more = row.items.length > SHOWN_IN_ROW ? ` and ${row.items.length - SHOWN_IN_ROW} more` : "";
  const cause = row.cause.slice(0, SHOWN_IN_ROW + 1).map((fn) => `${codeSpan(escapeCell(fn.symbol.path))} (${fn.change})`);
  const moreCause = row.cause.length > SHOWN_IN_ROW + 1 ? ` and ${row.cause.length - SHOWN_IN_ROW - 1} more` : "";
  // One cause can still change tests in different ways: each way is said, not just the first's.
  const changes = [...new Set(row.items.map((item) => describeChange(item)))];
  const shown = changes.slice(0, SHOWN_IN_ROW).map(escapeCell).join("; ");
  const moreChanges = changes.length > SHOWN_IN_ROW ? `; and ${changes.length - SHOWN_IN_ROW} other ways` : "";
  const ways = changes.length === 1 ? `each: ${shown}` : `${changes.length} ways: ${shown}${moreChanges}`;
  return [`${row.items.length} tests: ${names.join(", ")}${more}`, `through changed code: ${cause.join(", ")}${moreCause}; ${ways}`];
}

/** "8 tests ran on both the base and this branch; 1 new on this branch." */
export function reviewHeadline(summary: ReviewSummary): string {
  // Three counts that add up, so "N on both" isn't read as the total (a model read it so).
  const onBothSides = summary.items.filter((item) => item.category !== ReviewCategory.Removed && item.outcomeBefore !== null).length;
  const added = summary.items.filter((item) => item.category !== ReviewCategory.Removed && item.outcomeBefore === null).length;
  const removed = summary.counts[ReviewCategory.Removed];
  const extra = [added > 0 ? `${added} new on this branch` : "", removed > 0 ? `${removed} only on the base` : ""].filter(Boolean);
  return `${tests(onBothSides)} ran on both the base and this branch${extra.length ? `; ${extra.join(", ")}` : ""}.`;
}

/** The review as Markdown; with the threads, tests with one cause are one row. */
export function reviewMarkdown(summary: ReviewSummary, threads?: Threads): string {
  const out: string[] = ["## Behaviour changes (Runshape)", ""];
  out.push(reviewHeadline(summary), "");
  const silent = summary.counts[ReviewCategory.SilentChange];
  if (silent > 0) {
    out.push(`**${silent} test${silent === 1 ? " still passes" : "s still pass"} but now ${silent === 1 ? "runs" : "run"} differently** — the changes a green CI won't show you.`, "");
  }
  if (summary.moved.length > 0) {
    out.push(`### Moved, not changed (${summary.moved.length})`, "", ...summary.moved.map((line) => `- ${codeSpan(line)}`), "");
  }
  for (const category of REVIEW_ORDER) {
    if (category === ReviewCategory.Unchanged) continue;
    const items = summary.items.filter((item) => item.category === category);
    if (items.length === 0) continue;
    out.push(`### ${REVIEW_HEADINGS[category]} (${items.length})`, "", "| Test | What changed |", "|---|---|");
    for (const row of reviewRows(items, threads)) out.push(`| ${rowCells(row).join(" | ")} |`);
    out.push("");
  }
  out.push(`${summary.counts[ReviewCategory.Unchanged]} tests behave exactly as before.`);
  for (const caveat of summary.caveats) out.push("", `> ${caveat}`);
  return `${out.join("\n")}\n`;
}

function tests(n: number): string {
  return `${n} test${n === 1 ? "" : "s"}`;
}

function list(names: string[]): string {
  const shown = names.slice(0, MAX_LISTED).map(codeSpan).join(", ");
  return names.length > MAX_LISTED ? `${shown} and ${names.length - MAX_LISTED} more` : shown;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** A name containing a backtick needs a longer fence, or it ends the span early. */
function codeSpan(text: string): string {
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
