// What the architecture module tells the viewer: a runshape.json rule as a decision, where each
// component sits and who put it there, how that moved between two commits, the styles a
// recording looks like, and a model's advice for one component. The arch module builds these
// (and owns runshape.json's reading and writing); the UI only shows them.
import type { ArchitectureStyle, LayoutShape } from "./trace/model/arch-trace";
import type { ComponentKind } from "./trace/model/components";
import type { ZoneSource } from "./trace/model/arch-trace";

export interface ZoneRule {
  /**
   * Dotted-name glob: `*` is any text within one segment, `**` any number of segments (zero too:
   * `app.**` matches `app`). A dot inside a segment is written `\.` (Go's `example\.com.shop`).
   */
  match: string;
  /** One of the style's zone ids (profiles.ts). Framework, external and test-double zones are facts, not choices. */
  zone: string;
  reason: string;
  /** Who decided: a person, or a model's or the detector's proposal a person accepted. */
  by: "user" | "llm" | "detected";
  /**
   * "composition-root": code that builds the adapters and hands them in (an app's main, a
   * framework's dependency functions). Its calls wire; they don't break the style.
   */
  role?: ZoneRole;
}

export type ZoneRole = "composition-root";

/** A region as a review compares it: by its path ("trace/moves"), its own rules included, its regions apart. */
export interface RegionSummary {
  path: string;
  match: string;
  in: string;
  style: string;
  reason: string;
  by: ZoneRule["by"];
  zones: ZoneRule[];
}

/** One of the project's classes or modules, where it sits, and who put it there. */
export interface Placement {
  /** Its name in Runshape's dotted syntax, as runshape.json globs match it. */
  component: string;
  kind: ComponentKind.Class | ComponentKind.Module;
  zone: string;
  source: ZoneSource.Rule | ZoneSource.Inferred;
  /** The glob of the rule that placed it; null when inferred. */
  rule: string | null;
  /** Who made the rule: a person, or a model's or the detector's proposal a person accepted. */
  decidedBy: ZoneRule["by"] | null;
  /** The rule's reason, or the behaviour inference went by. */
  reason: string;
}

/** One component's place before and after; null on the side it doesn't exist. */
export interface PlacementChange {
  component: string;
  kind: Placement["kind"];
  before: Placement | null;
  after: Placement | null;
  /** Its name in the base, when it moved there from somewhere else. */
  movedFrom: string | null;
}

/**
 * How the architecture moved between two commits, decisions apart from observations: see
 * the test (architecture-diff.test.ts) for why.
 */
export interface ArchitectureDiff {
  /** The styles the two commits' runshape.json declare; both are placed in the second. */
  styleBefore: string;
  styleAfter: string;
  /** The zones placements name, in the style they're placed in. */
  zones: { id: string; name: string }[];
  /** Rules by their glob: added, removed, or kept with another zone, reason or decider. */
  rules: { added: ZoneRule[]; removed: ZoneRule[]; changed: { before: ZoneRule; after: ZoneRule }[] };
  /** Regions (runshape.json v3) by path: added, removed, or kept with another match, zone, style, reason, decider or rules. */
  regions: { added: RegionSummary[]; removed: RegionSummary[]; changed: { before: RegionSummary; after: RegionSummary }[] };
  /** Placements a rule made or unmade: someone decided these. */
  decided: PlacementChange[];
  /** Inferred zones that moved with the tests' behaviour, no rule on either side. */
  observed: PlacementChange[];
  /** New code no rule places: inferred for now, waiting for a decision. */
  unplaced: Placement[];
  /** Code head no longer has (or the tests no longer run). */
  removed: Placement[];
  /** Head's rules no recorded component matches. */
  unusedRules: string[];
}

export interface ZoneProposal {
  zone: string;
  /** Dotted-name globs, in the same form as runshape.json rules. */
  patterns: string[];
}

export interface ArchitectureCandidate {
  style: ArchitectureStyle;
  name: string;
  layout: LayoutShape;
  /** 0–1; relative, for ranking candidates against each other, not a probability. */
  score: number;
  evidence: string[];
  zones: ZoneProposal[];
}

export enum Confidence {
  Low = "low",
  Medium = "medium",
  High = "high",
}

export interface ZoneAdvice {
  zone: string;
  reason: string;
  confidence: Confidence;
}
