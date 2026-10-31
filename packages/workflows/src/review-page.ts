// The PR page's content (page.json), from a saved review: what the UI draws, worked out here so
// the UI reads kernel types only.
import { ReviewCallout, ReviewHighlights, ReviewPage, ReviewPageCost, ReviewPageFunction, ReviewPageMs, ReviewPageSide, ReviewPageTest, ReviewPageTime } from "@runshape/kernel";
import {
  ChangedFunction,
  CostDiff,
  describeChange,
  groupThreads,
  Measure,
  REVIEW_HEADINGS,
  REVIEW_ORDER,
  reviewHeadline,
  reviewRows,
  ReviewCategory,
  routeCostChanges,
  ThreadKind,
  TimeVerdict,
  workflowCostChanged,
} from "@runshape/trace";

import { ReviewBundle, ReviewSide, reviewHighlights, routeQueryText } from "./review-bundle";

export function buildReviewPage(bundle: ReviewBundle): ReviewPage {
  const onlyInBase = new Set(bundle.review.items.filter((item) => item.category === ReviewCategory.Removed).map((item) => item.scenarioId));
  const test = (id: string, name: string) => ({ id, name, inHead: !onlyInBase.has(id) });
  const sections = REVIEW_ORDER.filter((category) => category !== ReviewCategory.Unchanged).flatMap((category) => {
    const items = bundle.review.items.filter((item) => item.category === category);
    if (items.length === 0) return [];
    const rows = reviewRows(items, bundle.threads).map((row) => ({
      tests: row.items.map((item) => test(item.scenarioId, item.name)),
      cause: row.cause.map(pageFunction),
      changes: [...new Set(row.items.map(describeChange))],
    }));
    return [{ heading: REVIEW_HEADINGS[category], rows }];
  });
  const threads = groupThreads(bundle.threads).map((group) => ({
    functions: group.functions.map(pageFunction),
    workflows: THREAD_KINDS.map((kind) => ({ kind, tests: group.threads.filter((thread) => thread.kind === kind).map((thread) => test(thread.scenarioId, thread.name)) })).filter(
      (workflows) => workflows.tests.length > 0,
    ),
    routes: group.routes,
  }));
  return {
    format: "runshape-review-page",
    version: 1,
    base: side(bundle.base),
    head: side(bundle.head),
    headline: reviewHeadline(bundle.review),
    // Worst first across both lists: a sort keeps each list's own order within a tone.
    callouts: [...callouts(reviewHighlights(bundle)), ...costCallouts(bundle.cost)].sort((a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone)),
    moved: bundle.review.moved,
    sections,
    threadsBasis: bundle.threads.basis,
    threads,
    ...(bundle.cost === undefined ? {} : { cost: pageCost(bundle.cost, test) }),
  };
}

function pageCost(cost: CostDiff, test: (id: string, name: string) => ReviewPageTest): ReviewPageCost {
  const changed = cost.workflows.filter(workflowCostChanged);
  return {
    caveats: cost.caveats,
    routes: routeCostChanges(changed).map((route) => ({ label: route.label, text: routeQueryText(route), queries: route.queries, tests: route.workflows.map((w) => test(w.scenarioId, w.name)) })),
    workflows: changed.map((w) => ({ test: test(w.scenarioId, w.name), time: pageTime(w.timeUs, w.time), calls: w.calls, queries: w.queries })),
    unchanged: cost.workflows.length - changed.length,
    functions: cost.functions.map((fn) => ({
      function: pageFunction(fn),
      calls: fn.calls,
      paths: fn.paths,
      queries: fn.queries,
      time: pageTime(fn.timeUs, fn.time),
      selfTime: pageMs(fn.selfTimeUs),
    })),
  };
}

function pageMs({ before, after }: Measure): ReviewPageMs {
  return { beforeMs: before === null ? null : before / 1000, afterMs: after === null ? null : after / 1000 };
}

function pageTime(timeUs: Measure, verdict: TimeVerdict): ReviewPageTime {
  return { ...pageMs(timeUs), verdict };
}

/**
 * More queries is a cost a green CI never shows: a warning. A time past the noise bands is
 * from one recording each side: worth knowing, not yet a finding.
 */
function costCallouts(cost: CostDiff | undefined): ReviewCallout[] {
  if (cost === undefined) return [];
  const more = (m: Measure) => m.before !== null && m.after !== null && m.after > m.before;
  const moreQueries = cost.workflows.filter((w) => more(w.queries)).length;
  const slower = cost.workflows.filter((w) => w.time === TimeVerdict.Slower).length;
  const out: ReviewCallout[] = [];
  if (moreQueries > 0) out.push({ text: `${moreQueries} ${moreQueries === 1 ? "workflow makes" : "workflows make"} more queries`, tone: "warn" });
  if (slower > 0) out.push({ text: `${slower} ${slower === 1 ? "workflow" : "workflows"} slower past the noise bands (one recording each side)`, tone: "info" });
  return out;
}

const TONE_ORDER: ReviewCallout["tone"][] = ["failed", "warn", "info"];

/** The order a thread's workflows are listed in: the ones to look at first. */
const THREAD_KINDS = [ThreadKind.Different, ThreadKind.New, ThreadKind.Gone, ThreadKind.Same];

function side({ asked, recording, commit, subject }: ReviewSide): ReviewPageSide {
  return { asked, recording, commit, subject };
}

function pageFunction(fn: Pick<ChangedFunction, "symbol" | "change">): ReviewPageFunction {
  return { name: fn.symbol.path, namespace: fn.symbol.namespace, change: fn.change };
}

/** What a reviewer should look at first, worst first; nothing when nothing changed. */
function callouts(highlights: ReviewHighlights): ReviewCallout[] {
  const all: [number, string, string, ReviewCallout["tone"]][] = [
    [highlights.nowFailing, "now failing", "now failing", "failed"],
    [highlights.silentChanges, "still passing, run differently", "still passing, run differently", "warn"],
    [highlights.decided, "architecture decision to approve", "architecture decisions to approve", "warn"],
    [highlights.needsDecision, "needs a zone decision", "need a zone decision", "warn"],
    [highlights.routesChanged, "route takes a new way", "routes take a new way", "info"],
    [highlights.newTests, "new test", "new tests", "info"],
  ];
  return all.filter(([count]) => count > 0).map(([count, one, many, tone]) => ({ text: `${count} ${count === 1 ? one : many}`, tone }));
}
