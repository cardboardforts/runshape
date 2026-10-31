// Messages between the webview (UI adapter) and its host (the VS Code extension, or the
// standalone demo). Plain JSON both ways: everything here must survive postMessage.
import { Outcome, Phase } from "./trace/model/trace";
import type { ArchitectureCandidate, ArchitectureDiff, ZoneAdvice, ZoneRule } from "./architecture-views";
import type { ArchitectureStyle } from "./trace/model/arch-trace";
import type { Layout } from "./layout";
import type { ComponentView } from "./trace/model/component-view";
import type { Grouping } from "./trace/model/components";
import type { ExecutionDiff, FunctionExecutionDiff, MergedReplayStep, ReplayStep, ReviewSummary, RouteMap, RouteMapDiff, RunDiff } from "@runshape/trace";
import type { ComponentWiring, FunctionView, ObjectGraph, Timeline } from "./recording-views";

export interface ScenarioSummary {
  id: string;
  name: string;
  file: string;
  outcome: Outcome;
  durationMs: number;
  requests: string[];
}

export interface RunSummary {
  root: string;
  createdAt: string;
  language: string;
  runtime: string;
  backend: string;
  framework: string | null;
  middleware: string[];
  problems: string[];
  scenarios: ScenarioSummary[];
  /** When the previous recording was made, if there is one to compare against. */
  baselineCreatedAt: string | null;
  /** How many rules runshape.json has, and the style it declares (hexagonal without a file). */
  zoneRules: number;
  style: ArchitectureStyle;
  canEditRules: boolean;
  canAdviseZones: boolean;
  /** The module view's boxes, as dotted prefixes (Grouping.modules): regions, then packages. */
  modules: string[];
  /** Every style the graph can be drawn in ("Draw as"), in the arch module's order. */
  styles: StyleChoice[];
}

export interface StyleChoice {
  style: ArchitectureStyle;
  name: string;
}

export type UiRequest =
  | { type: "ready" }
  | { type: "reload" }
  /**
   * `style` draws the graph in another style than runshape.json declares, without saving it.
   * `opened`: a module opened from the module view (one of grouping.modules), drawn class by
   * class while the other modules stay whole (groupingAt).
   */
  | { type: "graph"; phases: Phase[]; grouping: Grouping; style?: string; opened?: string }
  | { type: "component"; id: string; grouping: Grouping }
  /** `symbol` is the FunctionRef.key a view gave. */
  | { type: "function"; symbol: string }
  | { type: "replay"; scenarioId: string; phases: Phase[]; grouping: Grouping }
  | { type: "timeline"; scenarioId: string; phases: Phase[]; grouping: Grouping }
  | { type: "diff"; phases: Phase[]; grouping: Grouping; style?: string; opened?: string }
  /** Requests by route and the ways through the code they took; with `compare`, how those changed. */
  | { type: "routes"; phases: Phase[]; compare: boolean }
  /** Rank the styles against this recording. */
  | { type: "detectArchitecture" }
  /** Ask a language model which style the app follows and how its packages map to zones. */
  | { type: "adviseArchitecture" }
  /**
   * Write runshape.json from a proposal for `style`: the detector's candidate, or the model's
   * last proposal (which the session kept: the view never sends rules to write).
   */
  | { type: "adoptArchitecture"; style: string; from: "detected" | "model" }
  | { type: "setZone"; qualifiedName: string; zone: string; reason: string; by: ZoneRule["by"] }
  | { type: "adviseZone"; componentId: string; grouping: Grouping }
  | { type: "executionDiff"; scenarioId: string; phases: Phase[]; grouping: Grouping }
  | { type: "objects"; scenarioId: string }
  | { type: "functionExecutionDiff"; scenarioId: string; symbol: string; phases: Phase[] }
  | { type: "openSource"; file: string; line: number };

export type UiResponse =
  | { type: "loading"; message: string }
  | { type: "empty"; message: string }
  | { type: "error"; message: string }
  | { type: "run"; summary: RunSummary }
  /** What the canvas draws, placed for 2D and 3D alike (the visualizer's layout). */
  | { type: "graph"; phases: Phase[]; layout: Layout; wiring: ComponentWiring[] }
  | { type: "objects"; graph: ObjectGraph }
  | { type: "component"; view: ComponentView }
  | { type: "function"; view: FunctionView }
  | { type: "replay"; scenarioId: string; steps: ReplayStep[] }
  | { type: "timeline"; timeline: Timeline }
  /** `baseRulesKnown`: the base was drawn with its own commit's rules, not the current ones. */
  | { type: "diff"; diff: RunDiff; layout: Layout; review: ReviewSummary; architecture: ArchitectureDiff; baseRulesKnown: boolean }
  | { type: "routes"; routes: RouteMap; diff: RouteMapDiff | null }
  /** `modules`: the module view's boxes under the new rules (a region added is a module). */
  | { type: "rulesChanged"; count: number; style: string; modules: string[] }
  | { type: "architecture"; candidates: ArchitectureCandidate[] }
  | { type: "architectureAdvice"; style: string; reason: string; confidence: string; rules: { match: string; zone: string }[] }
  | { type: "architectureAdviceFailed"; message: string }
  | { type: "executionDiff"; diff: ExecutionDiff; replay: MergedReplayStep[] }
  | { type: "functionExecutionDiff"; diff: FunctionExecutionDiff }
  | { type: "zoneAdvice"; componentId: string; advice: ZoneAdvice }
  | { type: "zoneAdviceFailed"; componentId: string; message: string };
