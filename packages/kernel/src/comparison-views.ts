// What the viewer shows of two recordings compared: the run and execution diffs, a test's
// replay, the routes and their variants, and the review by behaviour. The
// trace module builds these and the review module reads them; the UI only draws them, over the
// UI protocol. They moved here from the trace module in Phase 6, so the webview and the protocol
// import nothing but the kernel.
import type { ArchitectureProfile, GraphEdge, GraphNode } from "./trace/model/arch-trace";
import type { FunctionRef } from "./trace/model/function-ref";
import type { Outcome } from "./trace/model/trace";
import type { Change } from "./layout";

export enum Op {
  Same = "same",
  Added = "added",
  Removed = "removed",
}

export enum StepKind {
  Call = "call",
  Return = "return",
  External = "external",
}

/**
 * One hop of a scenario between two system-graph components, in time order. Played back,
 * the steps are the pulses of light travelling along the graph's edges. Calls within one
 * component are not hops; they show up in that component's function view instead.
 */
export interface ReplayStep {
  tUs: number;
  kind: StepKind;
  from: string;
  to: string;
  edgeId: string;
  label: string;
  /** Source location to highlight while this step plays, when it is project code. */
  file: string | null;
  line: number | null;
  /** The project object doing the work (self): the callee for calls and returns, the caller for external calls. */
  objectId: number | null;
}

/**
 * How one test's execution changed between two recordings, matched by what ran rather than
 * where it sits in the file: calls by their path of qualified names, statements by their
 * text. A function that moved (or had code inserted above it) lines up with itself; a call
 * that now happens under a new parent shows as removed in one place and added in another.
 */
export interface CallStep {
  op: Op;
  depth: number;
  symbol: FunctionRef;
  /** "test_x > create_new_article > get_slug_for_article": where the call sits, to show. */
  path: string;
  /** Set on a removed/added pair of the same function: it still runs, under a new caller. */
  reparented: boolean;
  /** The namespace the function had in the base, when it moved (see moves.ts); null otherwise. */
  movedFrom: string | null;
}

export interface ExecutionDiff {
  scenarioId: string;
  /** False when the two executions were too different to align (see align.ts). */
  complete: boolean;
  calls: CallStep[];
  added: number;
  removed: number;
}

export interface MergedReplayStep {
  op: Op;
  step: ReplayStep;
}

/** One function in one test: the statements it executed, before against after, by their text. */
export interface StatementStep {
  op: Op;
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
}

export interface FunctionExecutionDiff {
  scenarioId: string;
  symbol: FunctionRef;
  /** "text" when both recordings carry their source; otherwise line numbers stand in, and moves show as changes. */
  matchedBy: "text" | "line-number";
  /** False when the two were too different to align (see align.ts). */
  complete: boolean;
  callsBefore: number;
  callsAfter: number;
  fileBefore: string | null;
  fileAfter: string | null;
  statements: StatementStep[];
}

/**
 * What a code change did to behaviour: the same tests recorded before and after, compared
 * flow by flow. This is the review aid for a change you didn't write line by line (an AI
 * agent's, say): which requests now take a different route, touch the database
 * differently, or run different lines.
 */
export interface DiffNode extends GraphNode {
  change: Change;
  /** Its zone in the base, drawn with the base's rules; null when the base hasn't it. */
  zoneBefore: string | null;
}

export interface DiffEdge extends GraphEdge {
  change: Change;
  callsBefore: number;
}

export interface FunctionChange {
  symbol: FunctionRef;
  /** Lines (in the new code) whose statement didn't run before. */
  linesNowReached: number[];
  /** Lines (in the old code) whose statement no longer runs. */
  linesNoLongerReached: number[];
}

export interface ScenarioDiff {
  id: string;
  name: string;
  change: Change;
  outcomeBefore: Outcome | null;
  outcomeAfter: Outcome | null;
  hopsAdded: string[];
  hopsRemoved: string[];
  statementsAdded: string[];
  statementsRemoved: string[];
  functionsChanged: FunctionChange[];
}

export interface RunDiff {
  /** Reasons the two recordings may differ that have nothing to do with the code. */
  caveats: string[];
  nodes: DiffNode[];
  edges: DiffEdge[];
  scenarios: ScenarioDiff[];
  /** Both sides are drawn in the rules' style. */
  profile: ArchitectureProfile;
  /** Code that moved rather than changed (see moves.ts), one line per namespace or lone function. */
  moved: string[];
}

/**
 * A run's requests by the route that served them, and each route's requests by the path they
 * took through the project's code. Real traffic sends a route hundreds of requests that do a
 * handful of different things; a variant is one of those things.
 */
export interface RouteMap {
  routes: RouteGroup[];
  /** Startup, background work, unit tests: scenarios with no request in the phases shown. */
  scenariosWithoutRequests: number;
}

export interface RouteGroup {
  /** Method and pattern as recorded: what pairs a route across two recordings. */
  id: string;
  /** "GET /orders/{id}": the pattern written one way whatever the framework's syntax. */
  label: string;
  /** False when no route in the framework's table served it: grouped by its literal path. */
  routed: boolean;
  requestCount: number;
  /** The main path first, then by how many requests took each. */
  variants: RouteVariant[];
}

export interface RouteVariant {
  /** The shape of the call tree: what makes two requests the same variant. */
  key: string;
  steps: VariantStep[];
  requests: RequestRef[];
  /** The route's most taken path (the longest, on a tie): the others are told against it. */
  isMain: boolean;
  /**
   * False when the request matched the route's pattern but was turned away before its handler
   * ran (authentication, validation in middleware): `steps` are what ran instead, and `adds`
   * lists them rather than `skips` listing the whole main path.
   */
  reachedHandler: boolean;
  /** What the main path runs that this one doesn't, and the other way round. */
  skips: string[];
  adds: string[];
}

export interface VariantStep {
  /** What pairs a step across variants: the function's symbol key, or the external call. */
  key: string;
  /** Below the request's entry: the project code the framework called first is depth 0. */
  depth: number;
  label: string;
  /** Null for a call out of the program (a query, an HTTP call). */
  symbol: FunctionRef | null;
  /** It ran more than once in a row (a loop): how many times doesn't make another variant. */
  repeated: boolean;
}

export interface RequestRef {
  scenarioId: string;
  scenarioName: string;
  /** "GET /orders/ord-1": the request as sent. */
  line: string;
  outcome: Outcome;
}

/** How a route's ways through the code changed between two recordings. */
export interface RouteMapDiff {
  routes: RouteGroupDiff[];
}

export interface RouteGroupDiff {
  id: string;
  label: string;
  routed: boolean;
  /** Changed when a variant appeared or went; requests per variant may differ either way. */
  change: Change;
  variants: RouteVariantDiff[];
}

export interface RouteVariantDiff {
  /** Head's variant, or the base's when it's gone. */
  variant: RouteVariant;
  /**
   * Changed: a path only head takes, paired with one only the base took that it mostly
   * follows. A refactor that adds a call to every placed order is one variant changed, not
   * one gone and one new.
   */
  change: Change;
  /** For a changed variant: the base's, and the functions one calls that the other doesn't. */
  previous: RouteVariant | null;
  nowCalls: string[];
  noLongerCalls: string[];
  /** The path with each step marked: a changed variant's steps aligned with its previous one's. */
  path: { op: Op; step: VariantStep }[];
  /** Requests that took it in each recording. */
  before: number;
  after: number;
}

/**
 * A pull request reviewed by its behaviour: every test run on the base and on the head,
 * sorted by what a reviewer should look at first. Red tests already get attention; the
 * signal this exists for is the test that is still green but now executes differently —
 * a real user journey whose route through the code changed without anyone being told.
 */
export enum ReviewCategory {
  NowFailing = "now-failing",
  /** Green on both sides, yet executed differently: what CI can't show. */
  SilentChange = "silent-change",
  NowPassing = "now-passing",
  NowSkipped = "now-skipped",
  /** Broken on both sides; it may fail differently now. */
  StillFailing = "still-failing",
  Added = "added",
  Removed = "removed",
  Unchanged = "unchanged",
}

export const REVIEW_ORDER = [
  ReviewCategory.NowFailing,
  ReviewCategory.SilentChange,
  ReviewCategory.NowPassing,
  ReviewCategory.NowSkipped,
  ReviewCategory.StillFailing,
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
  /** Code that moved rather than changed (see moves.ts). */
  moved: string[];
}
