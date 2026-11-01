// One comparison, saved: the contract every reader of a review uses (docs/review-bundle.md).
import { ArchitectureDiff, Change, Grouping, Op, Phase, Placement, PlacementChange, plainMarkdown, QualifiedName, RegionSummary, ReviewHighlights, ReviewSummary, RouteMapDiff, Run, ZoneRule } from "@runshape/kernel";
import { ArchitectureSnapshot, buildPlacements, CategorizedItem, categorize, checkTagRules, claimText, comparedGraphs, diffArchitecture, expectedZonesIn, Finding, Kind, newFindings, ROLE_LENSES, ZoneRules } from "@runshape/architecture";
import { buildReview, buildThreads, CostDiff, detectMoves, diffCost, diffRouteMaps, diffRuns, groupThreads, Measure, Moves, reviewMarkdown, routeCostChanges, WorkflowCost, WorkflowSides, ChangedFunction, ThreadKind, Threads, TimeVerdict, workflowCostChanged } from "@runshape/trace";

import { NoteKind, ReviewStory, storyIsEmpty } from "./story";

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
  /** What the change costs at run time; absent from bundles saved before it was measured. */
  cost?: CostDiff;
  /** What it's for, as the PR, its tickets and the changed docs and comments say: titles, links, counts. Absent from bundles saved before stories were read. */
  story?: ReviewStory;
  /** The categorizer on head: the changed code's tags, the findings head adds, proposed zones for new code. */
  categories: BundleCategories;
}

/** Added after version 1's first release: readers treat it as optional. */
export interface BundleCategories {
  /** What the trace can't support, so no tag says it (docs/categorizer.md). */
  missing: string[];
  /** Head's changed callables, the types that hold them, and new types and modules no rule places. */
  items: CategorizedItem[];
  /** Findings head has that the base didn't (renames recognised), on any code. */
  newFindings: Finding[];
  /** A zone for each new class or module no rule places, from its roles: to add to runshape.json for approval, never applied. */
  proposals: ZoneRule[];
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
  /** The story the workflow gathered (gatherStory); left out, the bundle has none. */
  story?: ReviewStory;
  /** Hashing's sha256: each changed function's revision (a digest of its source), so a review knows when it was edited again. */
  digest?: (text: string) => string;
}

export function buildReviewBundle(input: BundleInput): ReviewBundle {
  const { base, head, rules } = input;
  const baseRules = input.baseRules ?? rules;
  const moves = detectMoves(base, head);
  const graphs = comparedGraphs(base, head, { ...BUNDLE_OPTIONS, rules, baseRules });
  const placed = { base: buildPlacements(base, baseRules, rules.profile), head: buildPlacements(head, rules) };
  const architecture = diffArchitecture(placed.base, placed.head, moves);
  const threads = buildThreads(base, head, diffRuns(base, head, graphs, { ...BUNDLE_OPTIONS, moves }), { phases: BUNDLE_OPTIONS.phases, moves, digest: input.digest });
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
    architecture,
    routes: bundleRoutes(diffRouteMaps(base, head, { phases: BUNDLE_OPTIONS.phases, moves })),
    threads,
    cost: diffCost(base, head, threads, { phases: BUNDLE_OPTIONS.phases, moves }),
    ...(input.story === undefined ? {} : { story: input.story }),
    categories: bundleCategories(input, baseRules, architecture, threads, moves, placed),
  };
}

function bundleCategories(input: BundleInput, baseRules: ZoneRules, architecture: ArchitectureDiff, threads: Threads, moves: Moves, placed: { base: ArchitectureSnapshot; head: ArchitectureSnapshot }): BundleCategories {
  const { base, head, rules } = input;
  const after = categorize(head, rules, placed.head);
  // The base was placed in head's style for the diff: reusable only when it is its own.
  const before = categorize(base, baseRules, baseRules.profile.style === rules.profile.style ? placed.base : undefined);
  const fresh = newFindings(checkTagRules(before, baseRules.taxonomy), checkTagRules(after, rules.taxonomy), {
    module: moves.module,
    type: moves.type,
    functionKey: moves.headKey,
  });
  const changedKeys = new Set(threads.functions.filter((fn) => fn.change !== "removed").map((fn) => fn.symbol.key));
  const changed = after.items.filter((item) => item.key !== null && changedKeys.has(item.key));
  const holders = after.items.filter((item) => item.kind === Kind.Type && changed.some((fn) => QualifiedName.parse(item.name).holds(QualifiedName.parse(fn.name))));
  const unplacedNames = new Set(architecture.unplaced.map((placement) => placement.component));
  const unplaced = after.items.filter((item) => (item.kind === Kind.Type || item.kind === Kind.Container) && unplacedNames.has(item.name));
  const items = after.items.filter((item) => changed.includes(item) || holders.includes(item) || unplaced.includes(item));
  return { missing: after.missing, items, newFindings: fresh, proposals: architecture.unplaced.map((placement) => proposal(placement, after.items, rules)) };
}

/**
 * Where new code no rule places should go: the zone its strongest role belongs in, when that
 * role names exactly one of the style's zones; otherwise where its behaviour put it. "detected":
 * the deterministic categorizer proposed it; a model's proposals say "llm".
 */
function proposal(placement: Placement, items: CategorizedItem[], rules: ZoneRules): ZoneRule {
  const item = items.find((candidate) => candidate.name === placement.component);
  for (const tag of (item?.tags ?? []).filter((candidate) => ROLE_LENSES.includes(candidate.lens)).sort((a, b) => b.confidence - a.confidence)) {
    const definition = rules.taxonomy.definition(tag.lens, tag.id);
    const zones = definition === undefined ? [] : expectedZonesIn(definition, rules.profile.style);
    if (zones.length === 1) return { match: placement.component, zone: zones[0]!, reason: `its role: ${tag.id} (${tag.evidence[0]})`, by: "detected" };
  }
  return { match: placement.component, zone: placement.zone, reason: `its behaviour: ${placement.reason}`, by: "detected" };
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
    reviewMarkdown(bundle.review, bundle.threads).trimEnd(),
    "",
    `Compared ${sideText(bundle.base)} with ${sideText(bundle.head)}.`,
    "",
    ...storyMarkdown(bundle.story),
    ...costMarkdown(bundle.cost),
    ...threadsMarkdown(bundle.threads),
    ...architectureMarkdown(bundle.architecture, bundle.baseRulesKnown),
    ...categoriesMarkdown(bundle.categories),
    ...routesMarkdown(bundle.routes),
  ];
  return `${out.join("\n").trimEnd()}\n`;
}

/** "primary-adapter; effect: reads-state, writes-state; cqs: both": roles by id, traits by lens. */
function tagsText(item: CategorizedItem): string {
  const byLens = new Map<string, string[]>();
  for (const tag of item.tags) byLens.set(tag.lens, [...(byLens.get(tag.lens) ?? []), claimText(tag)]);
  const parts = [...byLens].map(([lens, ids]) => (ROLE_LENSES.includes(lens) ? ids.join(", ") : `${lens}: ${ids.join(", ")}`));
  return parts.length > 0 ? parts.join("; ") : "no tags";
}

/**
 * "What the changed code is": the categorizer's tags for it, the findings this change adds,
 * and zones proposed for new code. Absent from bundles saved before the categorizer.
 */
function categoriesMarkdown(categories: BundleCategories | undefined): string[] {
  if (categories === undefined || (categories.items.length === 0 && categories.newFindings.length === 0)) return [];
  const out = ["### What the changed code is", ""];
  for (const item of categories.items.slice(0, SHOWN_FUNCTIONS)) out.push(`- ${code(item.name)} (${item.kind}, ${item.zone ?? "not placed"}): ${tagsText(item)}`);
  if (categories.items.length > SHOWN_FUNCTIONS) out.push(`- and ${categories.items.length - SHOWN_FUNCTIONS} more (review.json lists every claim with its evidence)`);
  if (categories.items.length > 0) out.push("");
  const findings = categories.newFindings;
  if (findings.length > 0) {
    out.push(`New findings (${findings.length}):`, "");
    for (const finding of findings.slice(0, SHOWN_FINDINGS)) out.push(`- **${finding.severity}** ${code(finding.rule)}: ${code(finding.item)} ${finding.message}${finding.evidence.length > 0 ? ` (${finding.evidence[0]})` : ""}`);
    if (findings.length > SHOWN_FINDINGS) out.push(`- and ${findings.length - SHOWN_FINDINGS} more (review.json lists them all)`);
    out.push("");
  }
  const proposals = categories.proposals;
  if (proposals.length > 0) {
    const shown = proposals.slice(0, SHOWN_PROPOSALS);
    out.push("Proposed zones for new code: add them to runshape.json to approve them in this diff (nothing is applied):", "", "```json");
    out.push(...shown.map((rule, i) => `${JSON.stringify(rule)}${i < shown.length - 1 ? "," : ""}`), "```");
    if (proposals.length > SHOWN_PROPOSALS) out.push(`and ${proposals.length - SHOWN_PROPOSALS} more (review.json lists them all)`);
    out.push("");
  }
  return out;
}

/** Past these, a PR comment becomes a list to open: review.json keeps every one. */
const SHOWN_FINDINGS = 15;
const SHOWN_PROPOSALS = 10;

function sideText(side: ReviewSide): string {
  if (side.recording === "working") return `the working tree (on ${code(side.commit.slice(0, 7))}${side.dirty ? ", with uncommitted changes" : ""})`;
  const commit = `${code(side.commit.slice(0, 7))} ${side.subject}`;
  if (side.forkOf === null) return `${code(side.asked)} (${commit})`;
  const since = `${side.forkOf.commitsSince} commit${side.forkOf.commitsSince === 1 ? "" : "s"} since`;
  return `where this branch left ${code(side.asked)} (${commit}; ${code(side.asked)} has ${since})`;
}

/** "trace: in core → business; style layered → hexagonal; its rules changed (2 → 3)": only what differs. */
function regionChange(before: RegionSummary, after: RegionSummary): string {
  const parts: string[] = [];
  if (before.match !== after.match) parts.push(`match ${code(before.match)} → ${code(after.match)}`);
  if (before.in !== after.in) parts.push(`in ${before.in} → ${after.in}`);
  if (before.style !== after.style) parts.push(`style ${before.style} → ${after.style}`);
  if (before.by !== after.by) parts.push(`${decider(before.by)} → ${decider(after.by)}`);
  if (before.reason !== after.reason) parts.push(`reason: ${after.reason}`);
  if (JSON.stringify(before.zones) !== JSON.stringify(after.zones)) parts.push(`its rules changed (${before.zones.length} → ${after.zones.length})`);
  return `${after.path}: ${parts.join("; ")}`;
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
  const rule = (r: ZoneRule) => `${code(r.match)} → ${zone(r.zone)}${r.role === undefined ? "" : `, ${r.role}`} (${decider(r.by)}): ${r.reason}`;
  const region = (r: RegionSummary) => `${r.path} (${code(r.match)}, ${r.style}, in ${zone(r.in)}; ${decider(r.by)}): ${r.reason}; ${r.zones.length} rule${r.zones.length === 1 ? "" : "s"}`;
  const decisions = [
    ...diff.rules.added.map((r) => `- Rule added: ${rule(r)}`),
    ...diff.rules.removed.map((r) => `- Rule removed: ${rule(r)}`),
    ...diff.rules.changed.map((r) => `- Rule changed: ${code(r.after.match)}: ${zone(r.before.zone)} (${decider(r.before.by)}) → ${rule(r.after)}`),
    ...diff.regions.added.map((r) => `- Region added: ${region(r)}`),
    ...diff.regions.removed.map((r) => `- Region removed: ${region(r)}`),
    ...diff.regions.changed.map((r) => `- Region changed: ${regionChange(r.before, r.after)}`),
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

/**
 * "The story": the pull request, its tickets, what was mentioned but not read, and the docs and
 * comments that changed. Titles and reasons are someone else's text in a comment that may be
 * posted: one line each, with Markdown and HTML escaped (no image, link or tag of theirs).
 */
function storyMarkdown(story: ReviewStory | undefined): string[] {
  if (story === undefined) return [];
  const out = ["### The story", ""];
  if (storyIsEmpty(story)) return [...out, "No pull request, ticket, doc or comment says what this change is for: its commit messages are all there is.", ""];
  const linked = (id: string, url: string | null) => (url === null ? plainMarkdown(id) : `[${plainMarkdown(id)}](${url})`);
  if (story.pullRequest !== null) out.push(`Pull request ${linked(`#${story.pullRequest.number}`, story.pullRequest.url)}: ${plainMarkdown(story.pullRequest.title)}`, "");
  if (story.tickets.length > 0) out.push("Tickets:", "", ...story.tickets.map((t) => `- ${linked(t.id, t.url)} ${plainMarkdown(t.title)} (${plainMarkdown(t.source)}, ${plainMarkdown(t.state)})`), "");
  if (story.unread.length > 0) out.push(`Mentioned, not read: ${story.unread.map((u) => `${plainMarkdown(u.id)} (${plainMarkdown(u.reason)})`).join("; ")}`, "");
  if (story.notes.length > 0) {
    const counts = (n: ReviewStory["notes"][number]) => [n.added > 0 ? `+${n.added}` : "", n.removed > 0 ? `−${n.removed}` : ""].filter(Boolean).join(" ");
    out.push("Docs and comments changed:", "", ...story.notes.slice(0, SHOWN_FUNCTIONS).map((n) => `- ${code(n.path.replace(/\s+/g, " "))}: ${n.kind === NoteKind.Doc ? "doc" : "comments"}, ${counts(n)} lines`));
    if (story.notes.length > SHOWN_FUNCTIONS) out.push(`- and ${story.notes.length - SHOWN_FUNCTIONS} more (review.json lists every file)`);
    out.push("");
  }
  return out;
}

/** A name containing a backtick needs a longer fence, or it ends the span early. */
function code(text: string): string {
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** More than this many entries or workflow names is a list to open, not to read. */
const SHOWN_FUNCTIONS = 15;
const SHOWN_NAMES = 6;

/**
 * "Threads to follow": each changed function, how many workflows run through it, and which
 * changed. Functions with the same workflows are one entry: one thread to follow.
 */
function threadsMarkdown(threads: Threads | undefined): string[] {
  if (threads === undefined || threads.functions.length === 0) return [];
  const groups = groupThreads(threads);
  const out = [`### Threads to follow (${threads.functions.length} changed function${threads.functions.length === 1 ? "" : "s"})`, ""];
  if (threads.basis === "behaviour") out.push("These recordings don't keep their source: a function counts as changed when a workflow ran it differently.", "");
  for (const group of groups.slice(0, SHOWN_FUNCTIONS)) {
    const count = (kind: ThreadKind) => group.threads.filter((thread) => thread.kind === kind).length;
    const words = (kind: ThreadKind) => (group.functions.length === 1 ? THREAD_WORDS[kind] : THREAD_WORDS[kind].replace(/ it$/, " them"));
    const parts = [ThreadKind.Different, ThreadKind.New, ThreadKind.Gone, ThreadKind.Same].filter((kind) => count(kind) > 0).map((kind) => `${count(kind)} ${words(kind)}`);
    const workflows = group.threads.length === 0 ? `no recorded workflow runs through ${group.functions.length === 1 ? "it" : "them"}` : `${group.threads.length} workflow${group.threads.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
    out.push(`- ${functionsText(group.functions)}: ${workflows}`);
    for (const kind of [ThreadKind.Different, ThreadKind.New, ThreadKind.Gone]) {
      const names = group.threads.filter((thread) => thread.kind === kind).map((thread) => code(thread.name));
      if (names.length > 0) out.push(`  - ${words(kind)}: ${names.slice(0, SHOWN_NAMES).join(", ")}${names.length > SHOWN_NAMES ? ` and ${names.length - SHOWN_NAMES} more` : ""}`);
    }
    if (group.routes.length > 0) out.push(`  - routes: ${group.routes.map((route) => code(route.label) + (route.on === "both" ? "" : route.on === "head" ? " (new)" : " (gone)")).join(", ")}`);
  }
  if (groups.length > SHOWN_FUNCTIONS) out.push(`- and ${groups.length - SHOWN_FUNCTIONS} more threads (review.json lists every function)`);
  out.push("");
  return out;
}

/** "`a` (ns), edited" for one; "`a`, `b` (ns), added; `c` (ns2), edited" for several. */
function functionsText(functions: ChangedFunction[]): string {
  const byWhere = new Map<string, ChangedFunction[]>();
  for (const fn of functions) {
    const where = `${fn.symbol.namespace}|${fn.change}`;
    if (!byWhere.has(where)) byWhere.set(where, []);
    byWhere.get(where)!.push(fn);
  }
  return [...byWhere.values()].map((fns) => `${fns.map((fn) => code(fn.symbol.path)).join(", ")} (${fns[0]!.symbol.namespace}), ${fns[0]!.change}`).join("; ");
}

/** How a workflow relates to the function: it's the workflows that are new to it, not new tests. */
const THREAD_WORDS: Record<ThreadKind, string> = {
  [ThreadKind.Different]: "now run differently",
  [ThreadKind.New]: "newly run through it",
  [ThreadKind.Gone]: "no longer run through it",
  [ThreadKind.Same]: "run as before",
};

/**
 * "Cost": the routes whose external calls changed (the route that pays), the workflows whose
 * calls, external calls or time changed, the workflows only one side has, and each changed
 * function's calls, paths and time per call. The caveats come first: one recording each side
 * is the reader's first fact about every time below.
 */
function costMarkdown(cost: CostDiff | undefined): string[] {
  if (cost === undefined) return [];
  const out = ["### Cost", "", ...cost.caveats.map((caveat) => `> ${caveat}`), ""];
  const changed = cost.workflows.filter(workflowCostChanged);
  const routes = routeExternalCallChanges(changed);
  if (routes.length > 0) out.push("External calls by route:", "", ...routes, "");
  if (changed.length > 0) {
    out.push("| Workflow | Time (ms) | Calls | External calls |", "|---|---|---|---|");
    for (const workflow of changed.slice(0, SHOWN_FUNCTIONS)) {
      out.push(`| ${code(workflow.name)} | ${timeText(workflow.timeUs, workflow.time)} | ${countText(workflow.calls)} | ${countText(workflow.externalCalls)} |`);
    }
    if (changed.length > SHOWN_FUNCTIONS) out.push(`| and ${changed.length - SHOWN_FUNCTIONS} more (review.json lists every workflow) | | | |`);
    out.push("");
  }
  const added = cost.workflows.filter((w) => w.sides === WorkflowSides.New);
  const gone = cost.workflows.filter((w) => w.sides === WorkflowSides.Gone);
  const names = (workflows: WorkflowCost[], detail: (w: WorkflowCost) => string) =>
    `${workflows.slice(0, SHOWN_NAMES).map((w) => `${code(w.name)}${detail(w)}`).join(", ")}${workflows.length > SHOWN_NAMES ? ` and ${workflows.length - SHOWN_NAMES} more` : ""}`;
  if (added.length > 0) out.push(`New on this branch, not compared (${added.length}): ${names(added, (w) => ` (${externalCallsText(w.externalCalls.after!)})`)}.`, "");
  if (gone.length > 0) out.push(`Only on the base, not compared (${gone.length}): ${names(gone, () => "")}.`, "");
  const same = cost.workflows.length - changed.length - added.length - gone.length;
  if (same > 0) out.push(`${same} workflow${same === 1 ? "" : "s"} on both sides cost the same: the same calls and external calls, and no time change past the noise bands.`, "");
  if (cost.functions.length > 0) {
    out.push(
      "Changed functions, over every workflow (time per call, so more callers isn't slower):",
      "",
      "| Function | Calls | Paths that ran | External calls under it | Time per call (ms) | Its own lines per call (ms) |",
      "|---|---|---|---|---|---|",
    );
    for (const fn of cost.functions.slice(0, SHOWN_FUNCTIONS)) {
      const name = `${code(fn.symbol.path)} (${fn.symbol.namespace}), ${fn.change}`;
      out.push(`| ${name} | ${countText(fn.calls)} | ${countText(fn.paths)} | ${countText(fn.externalCalls)} | ${timeText(fn.timePerCallUs, fn.time)} | ${msText(fn.selfTimePerCallUs)} |`);
    }
    if (cost.functions.length > SHOWN_FUNCTIONS) out.push(`| and ${cost.functions.length - SHOWN_FUNCTIONS} more (review.json lists every function) | | | | | |`);
    out.push("");
  }
  return out;
}

/** "`GET /feed` now makes 10 external calls, up from 3 (`test_a`)": workflows whose route changed alike are one line. */
function routeExternalCallChanges(workflows: CostDiff["workflows"]): string[] {
  return routeCostChanges(workflows).map((route) => {
    const names = route.workflows.map((workflow) => workflow.name);
    return `- ${code(route.label)} ${routeExternalCallText(route)} (${names.slice(0, SHOWN_NAMES).map(code).join(", ")}${names.length > SHOWN_NAMES ? ` and ${names.length - SHOWN_NAMES} more` : ""})`;
  });
}

/** "now makes 12 external calls, up from 3"; a route only one side requested didn't get cheaper or dearer: the request went elsewhere. */
export function routeExternalCallText(route: { requests: Measure; externalCalls: Measure }): string {
  const [before, after] = [route.externalCalls.before ?? 0, route.externalCalls.after ?? 0];
  if (route.requests.before === 0) return `newly requested: makes ${externalCallsText(after)}`;
  if (route.requests.after === 0) return `no longer requested: it made ${externalCallsText(before)}`;
  return `now makes ${externalCallsText(after)}, ${after > before ? "up" : "down"} from ${before}`;
}

/** SQL, HTTP or any other system the recorder saw at a boundary: not every one is a query. */
function externalCallsText(n: number): string {
  return `${n} external call${n === 1 ? "" : "s"}`;
}

function countText({ before, after }: Measure): string {
  return before === after ? `${after}` : `${before ?? "—"} → ${after ?? "—"}`;
}

/** Milliseconds to a tenth: already finer than one traced run can tell apart. */
function ms(us: number): string {
  return (us / 1000).toFixed(1);
}

function msText({ before, after }: Measure): string {
  return `${before === null ? "—" : ms(before)} → ${after === null ? "—" : ms(after)}`;
}

/** "10.6 → 25.3, **slower** (+14.7, +138%)": a change is named only past the noise bands. */
function timeText(timeUs: Measure, verdict: TimeVerdict): string {
  if (verdict !== TimeVerdict.Slower && verdict !== TimeVerdict.Faster) return `${msText(timeUs)}${TIME_WORDS[verdict]}`;
  const [before, after] = [timeUs.before!, timeUs.after!];
  const sign = after > before ? "+" : "−";
  const share = before === 0 ? "" : `, ${sign}${Math.round((Math.abs(after - before) / before) * 100)}%`;
  return `${msText(timeUs)}, **${verdict}** (${sign}${ms(Math.abs(after - before))}${share})`;
}

const TIME_WORDS: Record<TimeVerdict, string> = {
  [TimeVerdict.Slower]: "",
  [TimeVerdict.Faster]: "",
  [TimeVerdict.WithinNoise]: ", within noise",
  [TimeVerdict.NotComparable]: ", not comparable",
  [TimeVerdict.OneSide]: "",
};

/** What a morning's list shows of a review before it's opened, and the PR page's callouts. */
export function reviewHighlights(bundle: ReviewBundle): ReviewHighlights {
  return {
    nowFailing: bundle.review.counts["now-failing"],
    silentChanges: bundle.review.counts["silent-change"],
    newTests: bundle.review.counts.added,
    decided: bundle.architecture.decided.length + bundle.architecture.regions.added.length + bundle.architecture.regions.removed.length + bundle.architecture.regions.changed.length + bundle.architecture.rules.added.length + bundle.architecture.rules.removed.length + bundle.architecture.rules.changed.length,
    needsDecision: bundle.architecture.unplaced.length,
    routesChanged: bundle.routes.routes.length,
  };
}
