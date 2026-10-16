// One comparison, saved: the contract every reader of a review uses (docs/review-bundle.md).
import { Phase, Run } from "@runshape/trace";
import { Grouping, ZoneRule, ZoneRules } from "@runshape/architecture";
import {
  ArchitectureDiff,
  buildPlacements,
  buildReview,
  Change,
  detectMoves,
  diffArchitecture,
  diffRouteMaps,
  Placement,
  PlacementChange,
  ReviewSummary,
  reviewMarkdown,
  RouteMapDiff,
} from "@runshape/views";

/** One side of the comparison: what was asked for, and the recording that answered it. */
export interface ReviewSide {
  /** As the person named it: "main", "working", a branch or a commit. */
  asked: string;
  /** The kept recording's id: 12 hex digits, or "working". */
  recording: string;
  commit: string;
  subject: string;
}

export interface ReviewBundle {
  format: typeof REVIEW_FORMAT;
  version: typeof REVIEW_VERSION;
  createdAt: string;
  base: ReviewSide;
  head: ReviewSide;
  /** What the views were computed with: a reader sees what the review saw. */
  options: { phases: Phase[]; grouping: Grouping };
  /** False when the base's own runshape.json wasn't known and both sides used head's. */
  baseRulesKnown: boolean;
  review: ReviewSummary;
  architecture: ArchitectureDiff;
  routes: RouteMapDiff;
}

export const REVIEW_FORMAT = "runshape-review";
export const REVIEW_VERSION = 1;
/** The test bodies, middleware as one box: the defaults the viewer opens with. */
const BUNDLE_OPTIONS = { phases: [Phase.Call], grouping: { collapseMiddleware: true } };

export interface BundleInput {
  base: Run;
  head: Run;
  baseSide: ReviewSide;
  headSide: ReviewSide;
  /** The base commit's own rules; null when unknown (head's are used for both). */
  baseRules: ZoneRules | null;
  rules: ZoneRules;
  createdAt: string;
}

export function buildReviewBundle(input: BundleInput): ReviewBundle {
  const { base, head, rules } = input;
  const baseRules = input.baseRules ?? rules;
  const moves = detectMoves(base, head);
  return {
    format: REVIEW_FORMAT,
    version: REVIEW_VERSION,
    createdAt: input.createdAt,
    base: input.baseSide,
    head: input.headSide,
    options: BUNDLE_OPTIONS,
    baseRulesKnown: input.baseRules !== null,
    review: buildReview(base, head, { ...BUNDLE_OPTIONS, rules, baseRules, moves }),
    // Both placed in head's style: a style change is one change, not every class moving.
    architecture: diffArchitecture(buildPlacements(base, baseRules, rules.profile), buildPlacements(head, rules), moves),
    routes: diffRouteMaps(base, head, { phases: BUNDLE_OPTIONS.phases, moves }),
  };
}

/**
 * The bundle as a PR comment or a file to read: the behaviour review, then the architecture,
 * then the routes. Names only: no SQL text or source, as the behaviour review already holds to.
 */
export function reviewBundleMarkdown(bundle: ReviewBundle): string {
  const out = [
    reviewMarkdown(bundle.review).trimEnd(),
    "",
    `Compared ${sideText(bundle.base)} with ${sideText(bundle.head)}.`,
    "",
    ...architectureMarkdown(bundle.architecture, bundle.baseRulesKnown),
    ...routesMarkdown(bundle.routes),
  ];
  return `${out.join("\n").trimEnd()}\n`;
}

function sideText(side: ReviewSide): string {
  return side.recording === "working" ? `the working tree (on ${code(side.commit.slice(0, 7))})` : `${code(side.asked)} (${code(side.commit.slice(0, 7))} ${side.subject})`;
}

function architectureMarkdown(diff: ArchitectureDiff, baseRulesKnown: boolean): string[] {
  const zone = (id: string) => diff.zones.find((candidate) => candidate.id === id)?.name ?? id;
  const placed = (placement: Placement | null) =>
    placement === null ? "—" : `${zone(placement.zone)} (${placement.decidedBy === null ? "inferred" : decider(placement.decidedBy)})`;
  const out = ["### Architecture", ""];
  if (!baseRulesKnown) out.push("> The base's own runshape.json isn't known: both sides are drawn with the current runshape.json, so only new and gone code shows.", "");
  if (diff.styleBefore !== diff.styleAfter) out.push(`Style changed: ${diff.styleBefore} → ${diff.styleAfter}.`, "");
  const rule = (r: ZoneRule) => `${code(r.match)} → ${zone(r.zone)} (${decider(r.by)}): ${r.reason}`;
  const decisions = [
    ...diff.rules.added.map((r) => `- Rule added: ${rule(r)}`),
    ...diff.rules.removed.map((r) => `- Rule removed: ${rule(r)}`),
    ...diff.rules.changed.map((r) => `- Rule changed: ${code(r.after.match)}: ${zone(r.before.zone)} (${decider(r.before.by)}) → ${rule(r.after)}`),
    ...diff.decided.filter((c) => !isConfirmation(c)).map((c) => `- ${code(c.component)}: ${placed(c.before)} → ${placed(c.after)}`),
  ];
  const confirmations = diff.decided.filter(isConfirmation).length;
  if (decisions.length > 0 || confirmations > 0) {
    out.push("Decided in this change:", "", ...decisions);
    if (confirmations > 0) out.push(`- …and ${confirmations} now declared where they already were`);
    out.push("");
  }
  if (diff.unplaced.length > 0) out.push(`Needs a decision (${diff.unplaced.length}): no rule places it, so its zone is inferred from what it did:`, "", ...diff.unplaced.map((p) => `- ${code(p.component)}: ${zone(p.zone)}? (${p.reason})`), "");
  if (diff.observed.length > 0) out.push(`Moved with behaviour only (${diff.observed.length}), no rule either side:`, "", ...diff.observed.map((c) => `- ${code(c.component)}: ${placed(c.before)} → ${placed(c.after)}`), "");
  if (diff.unusedRules.length > 0) out.push(`Rules that place nothing: ${diff.unusedRules.map(code).join(", ")}`, "");
  if (out.length === 2) out.push("No architecture changes.", "");
  return out;
}

function routesMarkdown(routes: RouteMapDiff): string[] {
  const changed = routes.routes.filter((route) => route.change !== Change.Unchanged);
  if (changed.length === 0) return [];
  const out = ["### Routes", ""];
  for (const route of changed) {
    const counts = [Change.Added, Change.Removed, Change.Changed].map((change) => [change, route.variants.filter((v) => v.change === change).length] as const).filter(([, n]) => n > 0);
    out.push(`- ${code(route.label)}: ${route.change === Change.Changed ? counts.map(([change, n]) => `${n} ${WAYS[change]![n === 1 ? 0 : 1]}`).join(", ") : route.change}`);
    for (const variant of route.variants.filter((v) => v.change === Change.Changed)) {
      const parts = [variant.nowCalls.length ? `now calls ${variant.nowCalls.map(code).join(", ")}` : "", variant.noLongerCalls.length ? `no longer calls ${variant.noLongerCalls.map(code).join(", ")}` : ""];
      out.push(`  - ${parts.filter(Boolean).join("; ") || "the same calls, nested or ordered differently"}`);
    }
  }
  out.push("");
  return out;
}

/** A rule writing down where inference already had a class: a count, not a line each. */
function isConfirmation(change: PlacementChange): boolean {
  return change.before !== null && change.before.decidedBy === null && change.after !== null && change.before.zone === change.after.zone;
}

/** How a route's ways through the code changed, one and several. */
const WAYS: Partial<Record<Change, [string, string]>> = {
  [Change.Added]: ["new way", "new ways"],
  [Change.Removed]: ["way gone", "ways gone"],
  [Change.Changed]: ["way changed", "ways changed"],
};

function decider(by: ZoneRule["by"]): string {
  return by === "llm" ? "a model" : by === "detected" ? "the detector" : "a person";
}

/** A name containing a backtick needs a longer fence, or it ends the span early. */
function code(text: string): string {
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}
