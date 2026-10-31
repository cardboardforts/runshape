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
  /** "`GET /api/articles/feed` newly requested: makes 10 queries": routes whose queries changed. */
  routes: { label: string; text: string; queries: ReviewPageCount; tests: ReviewPageTest[] }[];
  /** Workflows whose calls, queries or time changed; the rest are counted in `unchanged`. */
  workflows: { test: ReviewPageTest; time: ReviewPageTime; calls: ReviewPageCount; queries: ReviewPageCount }[];
  unchanged: number;
  /** Each changed function over every workflow; `paths` are the distinct paths that ran through it. */
  functions: { function: ReviewPageFunction; calls: ReviewPageCount; paths: ReviewPageCount; queries: ReviewPageCount; time: ReviewPageTime; selfTime: ReviewPageMs }[];
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
