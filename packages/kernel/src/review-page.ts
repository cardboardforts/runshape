// A review as the PR page shows it: page.json, saved beside review.json. Shaped for the screen,
// not the domain (the review bundle is that): the workflows write it, the UI only draws it.

export interface ReviewPage {
  format: "runshape-review-page";
  version: 1;
  base: ReviewPageSide;
  head: ReviewPageSide;
  /** "8 tests ran on both the base and this branch; 1 new on this branch." */
  headline: string;
  /** What to look at first, worst first; empty when the change behaves as before. */
  callouts: ReviewCallout[];
  /** Code that moved without changing: "app.services.articles -> app.domain.articles (5 functions)". */
  moved: string[];
  /** The tests by what happened to them ("Now failing", …), each row one cause. */
  sections: ReviewPageSection[];
  /** "source": changed means its own text changed; "behaviour": a workflow ran it differently (no source kept). */
  threadsBasis: "source" | "behaviour";
  threads: ReviewPageThread[];
  /** What the change costs at run time; absent from pages saved before it was measured. */
  cost?: ReviewPageCost;
  /** The categorizer's view of the change; absent in pages saved before it. */
  categories?: ReviewPageCategories;
  /** What the change is for; absent from pages saved before stories were read. */
  story?: ReviewPageStory;
}

/** What the changed code is, what the change newly breaks, and zones proposed for new code. */
export interface ReviewPageCategories {
  /** One per changed callable, its type, and new code. */
  items: { name: string; kind: string; zone: string | null; tags: ReviewPageTag[] }[];
  findings: { severity: "error" | "warn" | "info"; rule: string; item: string; message: string; evidence: string[] }[];
  /** For runshape.json, for a person to approve: never applied by Runshape. */
  proposals: { match: string; zone: string; reason: string }[];
  /** How many of each list the page leaves out; review.json has them all. */
  omitted: { items: number; findings: number; proposals: number };
}

/** A claim as the page shows it: `text` already says "no recorded effect" or "low confidence" where it should. */
export interface ReviewPageTag {
  lens: string;
  id: string;
  by: "declared" | "detected" | "judged" | "confirmed";
  confidence: number;
  text: string;
}

/**
 * What the change is for: the PR, its tickets, what couldn't be read, the docs and comments
 * changed, and, once it's explained, the model's account. Titles are other people's text: draw
 * them as text.
 */
export interface ReviewPageStory {
  pullRequest: { number: number; title: string; url: string | null } | null;
  tickets: { id: string; source: string; title: string; url: string | null; state: string }[];
  unread: { id: string; source: string; reason: string }[];
  notes: { path: string; kind: "doc" | "comments"; added: number; removed: number }[];
  /** The model's account, labelled as one: null until the review is explained. */
  account: { model: string; purpose: string; notInStory: { behaviour: string; evidence: string }[] } | null;
}

/** One number on each side; null on a side that doesn't have it. */
export interface ReviewPageCount {
  before: number | null;
  after: number | null;
}

export interface ReviewPageMs {
  beforeMs: number | null;
  afterMs: number | null;
}

/** Milliseconds each side, and whether the change is past the noise bands ("slower", "faster") or not. */
export interface ReviewPageTime extends ReviewPageMs {
  verdict: "slower" | "faster" | "within-noise" | "not-comparable" | "one-side";
}

export interface ReviewPageCost {
  /** What the numbers can't show: one recording each side, the recorder's overhead included. */
  caveats: string[];
  /** "`GET /api/articles/feed` newly requested: makes 10 external calls": routes whose external calls changed. */
  routes: { label: string; text: string; externalCalls: ReviewPageCount; tests: ReviewPageTest[] }[];
  /** Workflows on both sides whose calls, external calls or time changed; the rest of both sides' are counted in `unchanged`. */
  workflows: { test: ReviewPageTest; time: ReviewPageTime; calls: ReviewPageCount; externalCalls: ReviewPageCount }[];
  /** Workflows only head has: nothing to compare, but what they cost is still news. */
  newWorkflows: { test: ReviewPageTest; calls: number; externalCalls: number }[];
  /** Workflows only the base has. */
  goneWorkflows: ReviewPageTest[];
  unchanged: number;
  /** Each changed function over every workflow; `paths` are the distinct paths that ran through it; times are per call. */
  functions: { function: ReviewPageFunction; calls: ReviewPageCount; paths: ReviewPageCount; externalCalls: ReviewPageCount; timePerCall: ReviewPageTime; selfTimePerCall: ReviewPageMs }[];
}

export interface ReviewPageSide {
  asked: string;
  /** The kept recording's id: what the viewer opens. */
  recording: string;
  commit: string;
  subject: string;
}

export interface ReviewCallout {
  text: string;
  tone: "failed" | "warn" | "info";
}

export interface ReviewPageSection {
  heading: string;
  rows: ReviewPageRow[];
}

/** One test, or several whose change has one cause. */
export interface ReviewPageRow {
  tests: ReviewPageTest[];
  /** The changed functions they run through; empty when no changed function accounts for it. */
  cause: ReviewPageFunction[];
  /** Each distinct way they changed: "now calls `ensure_slug_available`; …". */
  changes: string[];
}

export interface ReviewPageTest {
  /** The scenario's id in head (the base's, when it's gone): what the viewer selects. */
  id: string;
  name: string;
  /** False for a test only the base has: there's nothing in head's graph to open it at. */
  inHead: boolean;
}

export interface ReviewPageFunction {
  name: string;
  namespace: string;
  change: "edited" | "added" | "removed" | "ran differently";
}

/** Changed functions with the same workflows through them: one thread to follow. */
export interface ReviewPageThread {
  functions: ReviewPageFunction[];
  /** By how they fare: "now run differently", "newly run through it", "no longer run through it", "run as before". */
  workflows: { kind: "different" | "new" | "gone" | "same"; tests: ReviewPageTest[] }[];
  routes: { label: string; on: "both" | "head" | "base" }[];
}
