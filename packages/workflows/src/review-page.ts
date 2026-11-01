// The PR page's content (page.json), from a saved review: what the UI draws, worked out here so
// the UI reads kernel types only.
import { claimText } from "@runshape/architecture";
import { REVIEW_ORDER, ReviewCallout, ReviewCategory, ReviewHighlights, ReviewPage, ReviewPageCategories, ReviewPageCost, ReviewPageFunction, ReviewPageMs, ReviewPageSide, ReviewPageStory, ReviewPageTest, ReviewPageTime } from "@runshape/kernel";
import { ChangedFunction, CostDiff, describeChange, groupThreads, Measure, REVIEW_HEADINGS, reviewHeadline, reviewRows, routeCostChanges, ThreadKind, TimeVerdict, moreExternalCalls, workflowCostChanged, WorkflowSides } from "@runshape/trace";
import type { Explanation } from "@runshape/explainer";

import { BundleCategories, ReviewBundle, ReviewSide, reviewHighlights, routeExternalCallText } from "./review-bundle";
import { ReviewStory } from "./story";

/** With `explanation` (current for this review), the story carries the model's account of what the change is for. */
export function buildReviewPage(bundle: ReviewBundle, explanation: Explanation | null = null): ReviewPage {
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
    // Worst first across the lists: a sort keeps each list's own order within a tone.
    callouts: [...callouts(reviewHighlights(bundle)), ...findingCallouts(bundle), ...costCallouts(bundle.cost), ...storyCallouts(explanation)].sort((a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone)),
    moved: bundle.review.moved,
    sections,
    threadsBasis: bundle.threads.basis,
    threads,
    ...(bundle.cost === undefined ? {} : { cost: pageCost(bundle.cost, test) }),
    ...(bundle.categories === undefined ? {} : { categories: pageCategories(bundle.categories) }),
    ...(bundle.story === undefined ? {} : { story: pageStory(bundle.story, explanation) }),
  };
}

function pageStory(story: ReviewStory, explanation: Explanation | null): ReviewPageStory {
  // Explanations saved before the story was read have neither field: no account to draw.
  const account = explanation === null || explanation.purpose === undefined ? null : { model: explanation.model, purpose: explanation.purpose, notInStory: explanation.notInStory ?? [] };
  return { ...story, account };
}

/**
 * Behaviour the PR and tickets don't mention is the model's reading, not a measurement: worth
 * a look, labelled whose it is, never a warning on its own.
 */
function storyCallouts(explanation: Explanation | null): ReviewCallout[] {
  const n = explanation?.notInStory?.length ?? 0;
  return n === 0 ? [] : [{ text: `${n} ${n === 1 ? "change" : "changes"} the PR and tickets don't mention (${explanation!.model}'s account)`, tone: "info" }];
}

function pageCost(cost: CostDiff, test: (id: string, name: string) => ReviewPageTest): ReviewPageCost {
  const changed = cost.workflows.filter(workflowCostChanged);
  const added = cost.workflows.filter((w) => w.sides === WorkflowSides.New);
  const gone = cost.workflows.filter((w) => w.sides === WorkflowSides.Gone);
  return {
    caveats: cost.caveats,
    routes: routeCostChanges(changed).map((route) => ({
      label: route.label,
      text: routeExternalCallText(route),
      externalCalls: route.externalCalls,
      tests: route.workflows.map((w) => test(w.scenarioId, w.name)),
    })),
    workflows: changed.map((w) => ({ test: test(w.scenarioId, w.name), time: pageTime(w.timeUs, w.time), calls: w.calls, externalCalls: w.externalCalls })),
    newWorkflows: added.map((w) => ({ test: test(w.scenarioId, w.name), calls: w.calls.after!, externalCalls: w.externalCalls.after! })),
    goneWorkflows: gone.map((w) => test(w.scenarioId, w.name)),
    unchanged: cost.workflows.length - changed.length - added.length - gone.length,
    functions: cost.functions.map((fn) => ({
      function: pageFunction(fn),
      calls: fn.calls,
      paths: fn.paths,
      externalCalls: fn.externalCalls,
      timePerCall: pageTime(fn.timePerCallUs, fn.time),
      selfTimePerCall: pageMs(fn.selfTimePerCallUs),
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
 * More external calls is a cost a green CI never shows: a warning, new workflows included (a
 * new test through a new N+1 has no base to compare). A time past the noise bands is from one
 * recording each side: worth knowing, not yet a finding.
 */
function costCallouts(cost: CostDiff | undefined): ReviewCallout[] {
  if (cost === undefined) return [];
  const more = moreExternalCalls(cost.workflows);
  const slower = cost.workflows.filter((w) => w.time === TimeVerdict.Slower).length;
  const out: ReviewCallout[] = [];
  const workflows = (n: number) => `${n} ${n === 1 ? "workflow makes" : "workflows make"}`;
  if (more.compared > 0) out.push({ text: `${workflows(more.compared)} more external calls`, tone: "warn" });
  if (more.new > 0) out.push({ text: `${more.new} new ${more.new === 1 ? "workflow makes" : "workflows make"} external calls`, tone: "warn" });
  if (slower > 0) out.push({ text: `${slower} ${slower === 1 ? "workflow" : "workflows"} slower past the noise bands (one recording each side)`, tone: "info" });
  return out;
}

const TONE_ORDER: ReviewCallout["tone"][] = ["failed", "warn", "info"];

/** Past these the page is a list to scroll, not to read: review.json keeps every one. */
const PAGE_ITEMS = 40;
const PAGE_FINDINGS = 25;
const PAGE_PROPOSALS = 25;

function pageCategories(categories: BundleCategories): ReviewPageCategories {
  const { items, newFindings, proposals } = categories;
  return {
    items: items.slice(0, PAGE_ITEMS).map((item) => ({
      name: item.name,
      kind: item.kind,
      zone: item.zone,
      tags: item.tags.map((tag) => ({ lens: tag.lens, id: tag.id, by: tag.by, confidence: tag.confidence, text: claimText(tag) })),
    })),
    findings: newFindings.slice(0, PAGE_FINDINGS).map(({ severity, rule, item, message, evidence }) => ({ severity, rule, item, message, evidence })),
    proposals: proposals.slice(0, PAGE_PROPOSALS).map(({ match, zone, reason }) => ({ match, zone, reason })),
    omitted: {
      items: Math.max(0, items.length - PAGE_ITEMS),
      findings: Math.max(0, newFindings.length - PAGE_FINDINGS),
      proposals: Math.max(0, proposals.length - PAGE_PROPOSALS),
    },
  };
}

/** New findings the change adds, after the decisions: rules a person set are worth a look, not a red light. */
function findingCallouts(bundle: ReviewBundle): ReviewCallout[] {
  const count = bundle.categories?.newFindings.length ?? 0;
  if (count === 0) return [];
  const worst = bundle.categories!.newFindings.some((finding) => finding.severity === "error") ? "failed" : "warn";
  return [{ text: `${count} new architecture finding${count === 1 ? "" : "s"}`, tone: worst }];
}

/** The order a thread's workflows are listed in: the ones to look at first. */
const THREAD_KINDS = [ThreadKind.Different, ThreadKind.New, ThreadKind.Gone, ThreadKind.Same];

function side({ asked, recording, commit, subject }: ReviewSide): ReviewPageSide {
  return { asked, recording, commit, subject };
}

function pageFunction(fn: Pick<ChangedFunction, "symbol" | "change" | "revision">): ReviewPageFunction {
  return { name: fn.symbol.path, namespace: fn.symbol.namespace, change: fn.change, ...(fn.revision === undefined ? {} : { revision: fn.revision }) };
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
