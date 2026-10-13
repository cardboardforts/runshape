import { Outcome, Run } from "./model";
import { UiRequest, UiResponse } from "./ui-protocol";
import { buildComponentView } from "./views/component-view";
import { buildFunctionView, UnknownFunctionError } from "./views/function-view";
import { buildReplay } from "./views/replay";
import { diffRuns } from "./views/run-diff";
import { buildSystemGraph } from "./views/system-graph";

/** Port: source lines of a project file, by path relative to the recorded root. */
export interface SourceReader {
  readLines(relativeFile: string): Promise<string[] | null>;
}

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
  python: string;
  backend: string;
  framework: string | null;
  middleware: string[];
  problems: string[];
  scenarios: ScenarioSummary[];
  /** When the previous recording was made, if there is one to compare against. */
  baselineCreatedAt: string | null;
}

/**
 * Answers the viewer's requests about one recorded run. The VS Code extension forwards
 * webview messages here; the standalone demo calls it directly.
 */
export class ViewerSession {
  constructor(
    private readonly run: Run,
    private readonly sources: SourceReader,
    private readonly baseline: Run | null = null,
  ) {}

  summary(): RunSummary {
    const run = this.run;
    return {
      root: run.root,
      createdAt: run.createdAt,
      python: run.python,
      backend: run.backend,
      framework: run.topology?.framework ?? null,
      middleware: run.topology?.middleware ?? [],
      problems: run.problems,
      scenarios: run.scenarios.map((scenario) => ({
        id: scenario.nodeid,
        name: scenario.name,
        file: scenario.file,
        outcome: scenario.outcome,
        durationMs: Math.round(scenario.durationUs / 1000),
        requests: scenario.requests().map((span) => `${span.request?.method} ${span.request?.path}`),
      })),
      baselineCreatedAt: this.baseline?.createdAt ?? null,
    };
  }

  async handle(request: UiRequest): Promise<UiResponse | null> {
    switch (request.type) {
      case "ready":
        return { type: "run", summary: this.summary() };
      case "graph":
        return {
          type: "graph",
          phases: request.phases,
          graph: buildSystemGraph(this.run, { phases: request.phases, grouping: request.grouping }),
        };
      case "component":
        return { type: "component", view: buildComponentView(this.run, request.id, request.grouping) };
      case "function": {
        const catalogEntry = this.run.catalogFunction(request.module, request.qualname);
        const source = catalogEntry ? await this.sources.readLines(catalogEntry.file) : null;
        try {
          return { type: "function", view: buildFunctionView(this.run, request.module, request.qualname, source) };
        } catch (error) {
          if (error instanceof UnknownFunctionError) return { type: "error", message: error.message };
          throw error;
        }
      }
      case "replay": {
        const scenario = this.run.scenario(request.scenarioId);
        if (scenario === undefined) return { type: "error", message: `no scenario ${request.scenarioId} in this run` };
        return {
          type: "replay",
          scenarioId: scenario.nodeid,
          steps: buildReplay(scenario, request.phases, request.grouping),
        };
      }
      case "diff":
        if (this.baseline === null) return { type: "error", message: "There is no earlier recording to compare with yet." };
        return { type: "diff", diff: diffRuns(this.baseline, this.run, { phases: request.phases, grouping: request.grouping }) };
      case "openSource":
      case "reload":
        return null; // host concerns: the extension handles these itself
    }
  }
}
