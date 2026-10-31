// The PR page's content (page.json), from a saved review: what the UI draws, worked out here so
// the UI reads kernel types only.
import { ReviewCallout, ReviewHighlights, ReviewPage, ReviewPageFunction, ReviewPageSide } from "@runshape/kernel";
import { ChangedFunction, describeChange, groupThreads, REVIEW_HEADINGS, REVIEW_ORDER, reviewHeadline, reviewRows, ReviewCategory, ThreadKind } from "@runshape/trace";

import { ReviewBundle, ReviewSide, reviewHighlights } from "./review-bundle";

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
    callouts: callouts(reviewHighlights(bundle)),
    moved: bundle.review.moved,
    sections,
    threadsBasis: bundle.threads.basis,
    threads,
  };
}

/** The order a thread's workflows are listed in: the ones to look at first. */
const THREAD_KINDS = [ThreadKind.Different, ThreadKind.New, ThreadKind.Gone, ThreadKind.Same];

function side({ asked, recording, commit, subject }: ReviewSide): ReviewPageSide {
  return { asked, recording, commit, subject };
}

function pageFunction(fn: ChangedFunction): ReviewPageFunction {
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
