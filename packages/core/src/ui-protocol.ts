// Messages between the webview (UI adapter) and its host (the VS Code extension, or the
// standalone demo). Plain JSON both ways: everything here must survive postMessage.
import { Phase } from "./model";
import type { RingAdvice } from "./ring-advice";
import type { DeclaredRing, RingRule } from "./rings";
import type { Grouping } from "./views/components";
import type { RunSummary } from "./session";
import type { ComponentView } from "./views/component-view";
import type { FunctionView } from "./views/function-view";
import type { ReplayStep } from "./views/replay";
import type { RunDiff } from "./views/run-diff";
import type { ComponentWiring, ObjectGraph } from "./views/object-graph";
import type { ReviewSummary } from "./views/review";
import type { ExecutionDiff, FunctionExecutionDiff, MergedReplayStep } from "./views/execution-diff";
import type { SystemGraph } from "./views/system-graph";

export type UiRequest =
  | { type: "ready" }
  | { type: "reload" }
  | { type: "graph"; phases: Phase[]; grouping: Grouping }
  | { type: "component"; id: string; grouping: Grouping }
  | { type: "function"; module: string; qualname: string }
  | { type: "replay"; scenarioId: string; phases: Phase[]; grouping: Grouping }
  | { type: "diff"; phases: Phase[]; grouping: Grouping }
  | { type: "setRing"; qualifiedName: string; ring: DeclaredRing; reason: string; by: RingRule["by"] }
  | { type: "adviseRing"; componentId: string; grouping: Grouping }
  | { type: "executionDiff"; scenarioId: string; phases: Phase[]; grouping: Grouping }
  | { type: "objects"; scenarioId: string }
  | { type: "functionExecutionDiff"; scenarioId: string; module: string; qualname: string; phases: Phase[] }
  | { type: "openSource"; file: string; line: number };

export type UiResponse =
  | { type: "loading"; message: string }
  | { type: "empty"; message: string }
  | { type: "error"; message: string }
  | { type: "run"; summary: RunSummary }
  | { type: "graph"; phases: Phase[]; graph: SystemGraph; wiring: ComponentWiring[] }
  | { type: "objects"; graph: ObjectGraph }
  | { type: "component"; view: ComponentView }
  | { type: "function"; view: FunctionView }
  | { type: "replay"; scenarioId: string; steps: ReplayStep[] }
  | { type: "diff"; diff: RunDiff; review: ReviewSummary }
  | { type: "rulesChanged"; count: number }
  | { type: "executionDiff"; diff: ExecutionDiff; replay: MergedReplayStep[] }
  | { type: "functionExecutionDiff"; diff: FunctionExecutionDiff }
  | { type: "ringAdvice"; componentId: string; advice: RingAdvice }
  | { type: "ringAdviceFailed"; componentId: string; message: string };
