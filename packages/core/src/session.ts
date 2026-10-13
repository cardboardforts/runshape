import { Outcome, Run } from "./model";
import { ArchitectureProfile, ArchitectureStyle, PROFILES, profileFor } from "./profiles";
import { parseZoneAdvice, ZoneAdviceError, ZoneAdvisor, zoneAdvicePrompt, zoneFacts } from "./zone-advice";
import { ZoneRules } from "./zones";
import { UiRequest, UiResponse } from "./ui-protocol";
import { buildComponentView } from "./views/component-view";
import { Grouping } from "./views/components";
import { buildFunctionView, UnknownFunctionError } from "./views/function-view";
import { buildReplay } from "./views/replay";
import { diffExecution, diffFunctionExecution, mergeReplays } from "./views/execution-diff";
import { aggregateWiring, buildObjectGraph } from "./views/object-graph";
import { buildReview } from "./views/review";
import { diffRuns } from "./views/run-diff";
import { buildSystemGraph } from "./views/system-graph";

/** Port: source lines of a project file, by path relative to the recorded root. */
export interface SourceReader {
  readLines(relativeFile: string): Promise<string[] | null>;
}

/** Port: persist runshape.json. Resolves false when the person declined the change. */
export interface ZoneRuleStore {
  save(rules: ZoneRules, change: string): Promise<boolean>;
}

export interface SessionDependencies {
  sources: SourceReader;
  /** The previous recording, to compare against. */
  baseline?: Run | null;
  rules?: ZoneRules;
  /** Set when runshape.json exists but couldn't be read: saving would overwrite what's there. */
  rulesProblem?: string | null;
  ruleStore?: ZoneRuleStore | null;
  advisor?: ZoneAdvisor | null;
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
  /** How many rules runshape.json has, and the style it declares (hexagonal without a file). */
  zoneRules: number;
  style: ArchitectureStyle;
  canEditRules: boolean;
  canAdviseZones: boolean;
}

/**
 * Answers the viewer's requests about one recorded run. The VS Code extension forwards
 * webview messages here; the standalone demo calls it directly.
 */
export class ViewerSession {
  private readonly sources: SourceReader;
  private readonly baseline: Run | null;
  private readonly ruleStore: ZoneRuleStore | null;
  private readonly advisor: ZoneAdvisor | null;
  private rules: ZoneRules;
  private rulesProblem: string | null;

  constructor(
    private readonly run: Run,
    dependencies: SessionDependencies,
  ) {
    this.sources = dependencies.sources;
    this.baseline = dependencies.baseline ?? null;
    this.rules = dependencies.rules ?? ZoneRules.none();
    this.rulesProblem = dependencies.rulesProblem ?? null;
    this.ruleStore = dependencies.ruleStore ?? null;
    this.advisor = dependencies.advisor ?? null;
  }

  /** runshape.json changed on disk (edited by hand, or by another window). */
  replaceRules(rules: ZoneRules, problem: string | null): void {
    this.rules = rules;
    this.rulesProblem = problem;
  }

  currentRules(): ZoneRules {
    return this.rules;
  }

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
      zoneRules: this.rules.rules.length,
      style: this.rules.profile.style,
      canEditRules: this.ruleStore !== null,
      canAdviseZones: this.advisor?.available ?? false,
    };
  }

  async handle(request: UiRequest): Promise<UiResponse | null> {
    switch (request.type) {
      case "ready":
        return { type: "run", summary: this.summary() };
      case "graph": {
        const profile = this.drawingStyle(request.style);
        if (profile === null) return { type: "error", message: unknownStyle(request.style) };
        return {
          type: "graph",
          phases: request.phases,
          graph: buildSystemGraph(this.run, { phases: request.phases, grouping: request.grouping, rules: this.rules, profile }),
          wiring: aggregateWiring(this.run),
        };
      }
      case "objects": {
        const scenario = this.run.scenario(request.scenarioId);
        if (scenario === undefined) return { type: "error", message: `no scenario ${request.scenarioId} in this run` };
        return { type: "objects", graph: buildObjectGraph(scenario) };
      }
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
      case "diff": {
        if (this.baseline === null) return { type: "error", message: "There is no earlier recording to compare with yet." };
        const profile = this.drawingStyle(request.style);
        if (profile === null) return { type: "error", message: unknownStyle(request.style) };
        return {
          type: "diff",
          diff: diffRuns(this.baseline, this.run, { phases: request.phases, grouping: request.grouping, rules: this.rules, profile }),
          review: buildReview(this.baseline, this.run, { phases: request.phases, grouping: request.grouping, rules: this.rules }),
        };
      }
      case "setZone": {
        if (this.ruleStore === null) return { type: "error", message: "Zones can't be saved from here." };
        if (this.rulesProblem !== null) {
          // The session is showing inferred zones because the file couldn't be read; saving
          // now would replace every rule in it with this one.
          return { type: "error", message: `Fix runshape.json before adding rules: ${this.rulesProblem}` };
        }
        const invalid = invalidZoneRequest(request, this.rules);
        if (invalid !== null) return { type: "error", message: invalid };
        const next = this.rules.withRuleFor(request.qualifiedName, request.zone, request.reason, request.by);
        const replaces = this.rules.rules.some((rule) => rule.match === request.qualifiedName);
        const change =
          `${JSON.stringify(next.rules[0], null, 2)}\n\n` +
          `It goes first in runshape.json${replaces ? ", replacing the existing rule for this name" : ""}; the other ${next.rules.length - 1} rule(s) are kept.`;
        const saved = await this.ruleStore.save(next, change);
        if (!saved) return null;
        this.rules = next;
        return { type: "rulesChanged", count: next.rules.length };
      }
      case "adviseZone":
        return this.adviseZone(request.componentId, request.grouping);
      case "executionDiff": {
        const before = this.baseline?.scenario(request.scenarioId);
        const after = this.run.scenario(request.scenarioId);
        if (before === undefined || after === undefined) {
          return { type: "error", message: "This test exists in only one of the two recordings; there is no execution to compare." };
        }
        return {
          type: "executionDiff",
          diff: diffExecution(before, after, request.phases),
          replay: mergeReplays(before, after, request.phases, request.grouping),
        };
      }
      case "functionExecutionDiff":
        if (this.baseline === null) return { type: "error", message: "There is no earlier recording to compare with yet." };
        return {
          type: "functionExecutionDiff",
          diff: diffFunctionExecution(this.baseline, this.run, request.scenarioId, request.module, request.qualname, request.phases),
        };
      case "openSource":
      case "reload":
        return null; // host concerns: the extension handles these itself
    }
  }

  /** The style asked for, or the rules' own; null when asked for one that doesn't exist. */
  private drawingStyle(style: string | undefined): ArchitectureProfile | null {
    if (style === undefined) return this.rules.profile;
    return profileFor(style) ?? null;
  }

  private async adviseZone(componentId: string, grouping: Grouping): Promise<UiResponse> {
    if (this.advisor === null || !this.advisor.available) {
      return { type: "zoneAdviceFailed", componentId, message: "No language model is available (in VS Code, one comes with e.g. GitHub Copilot)." };
    }
    const graph = buildSystemGraph(this.run, { grouping, rules: this.rules });
    const node = graph.nodes.find((candidate) => candidate.id === componentId);
    if (node === undefined || node.qualifiedName === null) {
      return { type: "zoneAdviceFailed", componentId, message: "Only project classes and modules can be placed in a zone." };
    }
    const view = buildComponentView(this.run, componentId, grouping);
    const prompt = zoneAdvicePrompt(zoneFacts(graph, node, view), await this.componentSource(view), this.rules.profile);
    let answer: string;
    try {
      answer = await this.advisor.complete(prompt);
    } catch (error) {
      // Access denied, quota, network: the view must leave its "asking" state either way.
      return { type: "zoneAdviceFailed", componentId, message: `The model request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      return { type: "zoneAdvice", componentId, advice: parseZoneAdvice(answer, this.rules.profile) };
    } catch (error) {
      if (error instanceof ZoneAdviceError) return { type: "zoneAdviceFailed", componentId, message: error.message };
      throw error;
    }
  }

  /** The component's own functions, from the first to the last line, in their file. */
  private async componentSource(view: ReturnType<typeof buildComponentView>): Promise<string[] | null> {
    const own = view.functions.filter((fn) => fn.inheritedFrom === null);
    const file = own[0]?.file;
    if (file === undefined) return null;
    const lines = await this.sources.readLines(file);
    if (lines === null) return null;
    const ranges = own
      .filter((fn) => fn.file === file)
      .map((fn) => this.run.catalogFunction(fn.module, fn.qualname))
      .filter((fn) => fn !== undefined);
    const first = Math.min(...ranges.map((fn) => fn.firstLine));
    const last = Math.max(...ranges.map((fn) => fn.lastLine));
    return lines.slice(classStatementLine(lines, first, view.label) - 1, last);
  }
}

/** setZone arrives from the webview: check it like any input crossing into the session. */
function invalidZoneRequest(request: Extract<UiRequest, { type: "setZone" }>, rules: ZoneRules): string | null {
  const problems: string[] = [];
  if (typeof request.qualifiedName !== "string" || request.qualifiedName.trim() === "") problems.push("no component name");
  if (!rules.isZoneOfStyle(request.zone)) problems.push(`unknown zone ${JSON.stringify(request.zone)} for the ${rules.profile.style} style`);
  if (typeof request.reason !== "string" || request.reason.trim() === "") problems.push("no reason");
  if (request.by !== "user" && request.by !== "llm") problems.push(`unknown decider ${JSON.stringify(request.by)}`);
  return problems.length > 0 ? `Can't save that rule: ${problems.join("; ")}` : null;
}

/** How far above its first method a class statement (bases, docstring, decorators) may start. */
const MAX_CLASS_HEADER_LINES = 40;

/** The line of `class Name` above a class's first method, so the model sees its bases. */
function classStatementLine(lines: string[], firstMethodLine: number, className: string): number {
  const header = new RegExp(`^\\s*class\\s+${className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  for (let line = firstMethodLine - 1; line >= Math.max(1, firstMethodLine - MAX_CLASS_HEADER_LINES); line -= 1) {
    if (header.test(lines[line - 1] ?? "")) return line;
  }
  return Math.max(firstMethodLine - 1, 1);
}

function unknownStyle(style: string | undefined): string {
  return `unknown style ${JSON.stringify(style)}; one of ${PROFILES.map((profile) => profile.style).join(", ")}`;
}
