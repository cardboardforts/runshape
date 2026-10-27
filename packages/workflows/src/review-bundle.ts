// One comparison, saved: the contract every reader of a review uses (docs/review-bundle.md).
import { Grouping, Phase, Run } from "@runshape/kernel";
import { ArchitectureDiff, buildPlacements, comparedGraphs, diffArchitecture, Placement, PlacementChange, ZoneRule, ZoneRules } from "@runshape/architecture";
import { buildReview, buildThreads, Change, detectMoves, diffRouteMaps, diffRuns, Op, reviewMarkdown, ReviewSummary, RouteMapDiff, ThreadKind, Threads } from "@runshape/trace";

/** One side of the comparison: what was asked for, and the recording that answered it. */
export interface ReviewSide {
  /** As the person named it: "main", "working", a branch or a commit. */
  asked: string;
  /** The kept recording's id: 12 hex digits, or "working". */
  recording: string;
  commit: string;
  subject: string;
  /** The working tree had changes `commit` doesn't hold. */
  dirty: boolean;
  /** Set when this is where head's branch left the branch asked for, not that branch's newest commit. */
  forkOf: { tip: string; commitsSince: number } | null;
}

/** A route that changed, as the bundle keeps it: each way's path once, tests by name, no request as sent. */
export interface BundleRoute {
  id: string;
  label: string;
  routed: boolean;
  change: Change;
  ways: BundleWay[];
}

export interface BundleWay {
  change: Change;
  /** Requests that took it in each recording. */
  before: number;
  after: number;
  isMain: boolean;
  reachedHandler: boolean;
  skips: string[];
  adds: string[];
  nowCalls: string[];
  noLongerCalls: string[];
  /** The tests whose requests took it (the base's, when it's gone). */
  tests: string[];
  path: { op: Op; depth: number; label: string }[];
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
  /** Changed routes in full; unchanged ones only counted (they'd make the bundle as big as the suite). */
  routes: { routes: BundleRoute[]; unchanged: number };
  /** Each function the change touched, and the workflows (tests, requests) that run through it. */
  threads: Threads;
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
  const graphs = comparedGraphs(base, head, { ...BUNDLE_OPTIONS, rules, baseRules });
  return {
    format: REVIEW_FORMAT,
    version: REVIEW_VERSION,
    createdAt: input.createdAt,
    base: input.baseSide,
    head: input.headSide,
    options: BUNDLE_OPTIONS,
    baseRulesKnown: input.baseRules !== null,
    review: withoutQueryText(buildReview(base, head, graphs, { ...BUNDLE_OPTIONS, moves })),
    // Both placed in head's style: a style change is one change, not every class moving.
    architecture: diffArchitecture(buildPlacements(base, baseRules, rules.profile), buildPlacements(head, rules), moves),
    routes: bundleRoutes(diffRouteMaps(base, head, { phases: BUNDLE_OPTIONS.phases, moves })),
    threads: buildThreads(base, head, diffRuns(base, head, graphs, { ...BUNDLE_OPTIONS, moves }), { phases: BUNDLE_OPTIONS.phases, moves }),
  };
}

/**
 * A query's system and kind ("sqlite: SELECT"), not its text: a bundle may be stored centrally,
 * and statements carry table names, literals and whatever else the code put in them.
 */
function withoutQueryText(review: ReviewSummary): ReviewSummary {
  const kind = (query: string) => {
    const at = query.indexOf(": ");
    const system = at === -1 ? query : query.slice(0, at);
    const statement = at === -1 ? "" : query.slice(at + 2).trim();
    return statement === "" ? system : `${system}: ${statement.split(/\s+/)[0]!.toUpperCase()}`;
  };
  return { ...review, items: review.items.map((item) => ({ ...item, queriesAdded: item.queriesAdded.map(kind), queriesRemoved: item.queriesRemoved.map(kind) })) };
}

function bundleRoutes(diff: RouteMapDiff): ReviewBundle["routes"] {
  const changed = diff.routes.filter((route) => route.change !== Change.Unchanged);
  return {
    routes: changed.map((route) => ({
      id: route.id,
      label: route.label,
      routed: route.routed,
      change: route.change,
      ways: route.variants.map(({ variant, change, before, after, nowCalls, noLongerCalls, path }) => ({
        change,
        before,
        after,
        isMain: variant.isMain,
        reachedHandler: variant.reachedHandler,
        skips: variant.skips,
        adds: variant.adds,
        nowCalls,
        noLongerCalls,
        tests: [...new Set(variant.requests.map((request) => request.scenarioName))],
        path: path.map(({ op, step }) => ({ op, depth: step.depth, label: step.label })),
      })),
    })),
    unchanged: diff.routes.length - changed.length,
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
    ...threadsMarkdown(bundle.threads),
    ...architectureMarkdown(bundle.architecture, bundle.baseRulesKnown),
    ...routesMarkdown(bundle.routes),
  ];
  return `${out.join("\n").trimEnd()}\n`;
}

function sideText(side: ReviewSide): string {
  if (side.recording === "working") return `the working tree (on ${code(side.commit.slice(0, 7))}${side.dirty ? ", with uncommitted changes" : ""})`;
  const commit = `${code(side.commit.slice(0, 7))} ${side.subject}`;
  if (side.forkOf === null) return `${code(side.asked)} (${commit})`;
  const since = `${side.forkOf.commitsSince} commit${side.forkOf.commitsSince === 1 ? "" : "s"} since`;
  return `where this branch left ${code(side.asked)} (${commit}; ${code(side.asked)} has ${since})`;
}

function architectureMarkdown(diff: ArchitectureDiff, baseRulesKnown: boolean): string[] {
  const zone = (id: string) => diff.zones.find((candidate) => candidate.id === id)?.name ?? id;
  const placed = (placement: Placement | null) =>
    placement === null ? "—" : `${zone(placement.zone)} (${placement.decidedBy === null ? "inferred" : decider(placement.decidedBy)})`;
  const out = ["### Architecture", ""];
  let changes = 0;
  if (!baseRulesKnown) out.push("> The base's own runshape.json isn't known: both sides are drawn with the current runshape.json, so only new and gone code shows.", "");
  if (diff.styleBefore !== diff.styleAfter) {
    out.push(`Style changed: ${diff.styleBefore} → ${diff.styleAfter}.`, "");
    changes += 1;
  }
  const rule = (r: ZoneRule) => `${code(r.match)} → ${zone(r.zone)} (${decider(r.by)}): ${r.reason}`;
  const decisions = [
    ...diff.rules.added.map((r) => `- Rule added: ${rule(r)}`),
    ...diff.rules.removed.map((r) => `- Rule removed: ${rule(r)}`),
    ...diff.rules.changed.map((r) => `- Rule changed: ${code(r.after.match)}: ${zone(r.before.zone)} (${decider(r.before.by)}) → ${rule(r.after)}`),
    ...diff.decided.filter((c) => !isConfirmation(c)).map((c) => `- ${code(c.component)}: ${placed(c.before)} → ${placed(c.after)}`),
  ];
  const confirmations = diff.decided.filter(isConfirmation).length;
  changes += decisions.length + confirmations + diff.unplaced.length + diff.observed.length + diff.unusedRules.length;
  if (decisions.length > 0 || confirmations > 0) {
    out.push("Decided in this change:", "", ...decisions);
    if (confirmations > 0) out.push(`- …and ${confirmations} now declared where they already were`);
    out.push("");
  }
  if (diff.unplaced.length > 0) out.push(`Needs a decision (${diff.unplaced.length}): no rule places it, so its zone is inferred from what it did:`, "", ...diff.unplaced.map((p) => `- ${code(p.component)}: ${zone(p.zone)}? (${p.reason})`), "");
  if (diff.observed.length > 0) out.push(`Moved with behaviour only (${diff.observed.length}), no rule either side:`, "", ...diff.observed.map((c) => `- ${code(c.component)}: ${placed(c.before)} → ${placed(c.after)}`), "");
  if (diff.unusedRules.length > 0) out.push(`Rules that place nothing: ${diff.unusedRules.map(code).join(", ")}`, "");
  if (changes === 0) out.push("No architecture changes.", "");
  return out;
}

function routesMarkdown(routes: ReviewBundle["routes"]): string[] {
  if (routes.routes.length === 0) return [];
  const out = ["### Routes", ""];
  for (const route of routes.routes) {
    const counts = [Change.Added, Change.Removed, Change.Changed].map((change) => [change, route.ways.filter((way) => way.change === change).length] as const).filter(([, n]) => n > 0);
    out.push(`- ${code(route.label)}: ${route.change === Change.Changed ? counts.map(([change, n]) => `${n} ${WAYS[change]![n === 1 ? 0 : 1]}`).join(", ") : route.change}`);
    // Ways that changed alike read as one line: a PR comment, not a list of repeats.
    const lines = new Map<string, number>();
    for (const way of route.ways.filter((w) => w.change === Change.Changed)) {
      const parts = [way.nowCalls.length ? `now calls ${way.nowCalls.map(code).join(", ")}` : "", way.noLongerCalls.length ? `no longer calls ${way.noLongerCalls.map(code).join(", ")}` : ""];
      const line = parts.filter(Boolean).join("; ") || "the same calls, nested or ordered differently";
      lines.set(line, (lines.get(line) ?? 0) + 1);
    }
    for (const [line, n] of lines) out.push(`  - ${line}${n > 1 ? ` (${n} ways)` : ""}`);
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

/** More than this many functions or workflow names is a list to open, not to read. */
const SHOWN_FUNCTIONS = 15;
const SHOWN_NAMES = 6;

/** "Threads to follow": each changed function, how many workflows run through it, and which changed. */
function threadsMarkdown(threads: Threads | undefined): string[] {
  if (threads === undefined || threads.functions.length === 0) return [];
  const out = [`### Threads to follow (${threads.functions.length} changed function${threads.functions.length === 1 ? "" : "s"})`, ""];
  if (threads.basis === "behaviour") out.push("These recordings don't keep their source: a function counts as changed when a workflow ran it differently.", "");
  for (const fn of threads.functions.slice(0, SHOWN_FUNCTIONS)) {
    const count = (kind: ThreadKind) => fn.threads.filter((thread) => thread.kind === kind).length;
    const parts = [ThreadKind.Different, ThreadKind.New, ThreadKind.Gone, ThreadKind.Same].filter((kind) => count(kind) > 0).map((kind) => `${count(kind)} ${THREAD_WORDS[kind]}`);
    const through = fn.threads.length === 0 ? "no recorded workflow runs through it" : `${fn.threads.length} workflow${fn.threads.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
    out.push(`- ${code(fn.symbol.path)} (${fn.symbol.namespace}), ${fn.change}: ${through}`);
    for (const kind of [ThreadKind.Different, ThreadKind.New, ThreadKind.Gone]) {
      const names = fn.threads.filter((thread) => thread.kind === kind).map((thread) => code(thread.name));
      if (names.length > 0) out.push(`  - ${THREAD_WORDS[kind]}: ${names.slice(0, SHOWN_NAMES).join(", ")}${names.length > SHOWN_NAMES ? ` and ${names.length - SHOWN_NAMES} more` : ""}`);
    }
    if (fn.routes.length > 0) out.push(`  - routes: ${fn.routes.map((route) => code(route.label) + (route.on === "both" ? "" : route.on === "head" ? " (new)" : " (gone)")).join(", ")}`);
  }
  if (threads.functions.length > SHOWN_FUNCTIONS) out.push(`- and ${threads.functions.length - SHOWN_FUNCTIONS} more (review.json lists them all)`);
  out.push("");
  return out;
}

/** How a workflow relates to the function: it's the workflows that are new to it, not new tests. */
const THREAD_WORDS: Record<ThreadKind, string> = {
  [ThreadKind.Different]: "now run differently",
  [ThreadKind.New]: "newly run through it",
  [ThreadKind.Gone]: "no longer run through it",
  [ThreadKind.Same]: "run as before",
};
