import { CatalogFunction, CodeSymbol, Outcome, Run, Span } from "../model";

/**
 * One function's source with, for every line, the scenarios (tests) whose execution passed
 * through it — the "bundle of wires" view. Lines no scenario reached are untested; scenarios
 * that took exactly the same path are candidates for consolidation.
 */
export interface FunctionView {
  title: string;
  module: string;
  file: string;
  firstLine: number;
  lastLine: number;
  lines: LineView[];
  scenarios: ScenarioPath[];
  samePathGroups: string[][];
  untestedLines: number[];
  executableLineCount: number;
}

export interface LineView {
  number: number;
  text: string;
  executable: boolean;
  scenarioIds: string[];
  hits: number;
}

export interface ScenarioPath {
  scenarioId: string;
  name: string;
  outcome: Outcome;
  calls: number;
  /** Distinct lines reached, ascending. */
  lines: number[];
  /** Lines in execution order for the first call, consecutive repeats collapsed. */
  firstCallPath: number[];
}

export class UnknownFunctionError extends Error {}

export function buildFunctionView(
  run: Run,
  symbol: CodeSymbol,
  sourceLines: string[] | null,
): FunctionView {
  const target = run.catalogFunction(symbol);
  if (target === undefined) {
    throw new UnknownFunctionError(`${symbol.dottedNamespace}.${symbol.dottedPath} is not in the recorded catalog`);
  }
  const executable = executableLines(run.catalog, target);
  const lineScenarios = new Map<number, Set<string>>();
  const lineHits = new Map<number, number>();
  const scenarios: ScenarioPath[] = [];

  for (const scenario of run.scenarios) {
    const spans = scenario.spans.filter((span) => isInside(span, target));
    if (spans.length === 0) continue;
    const reached = new Set<number>();
    for (const span of spans) {
      for (const line of span.lines) {
        if (!executable.has(line)) continue;
        reached.add(line);
        lineHits.set(line, (lineHits.get(line) ?? 0) + 1);
        let ids = lineScenarios.get(line);
        if (ids === undefined) {
          ids = new Set();
          lineScenarios.set(line, ids);
        }
        ids.add(scenario.nodeid);
      }
    }
    const firstCall = spans.find((span) => span.fn.firstLine === target.firstLine);
    scenarios.push({
      scenarioId: scenario.nodeid,
      name: scenario.name,
      outcome: scenario.outcome,
      calls: spans.filter((span) => span.fn.firstLine === target.firstLine).length,
      lines: [...reached].sort((a, b) => a - b),
      firstCallPath: firstCall ? collapseRepeats(firstCall.lines.filter((line) => executable.has(line))) : [],
    });
  }

  const lines: LineView[] = [];
  for (let number = target.firstLine; number <= target.lastLine; number += 1) {
    lines.push({
      number,
      text: sourceLines?.[number - 1] ?? "",
      executable: executable.has(number),
      scenarioIds: [...(lineScenarios.get(number) ?? [])].sort(),
      hits: lineHits.get(number) ?? 0,
    });
  }

  return {
    title: symbol.dottedPath,
    module: symbol.dottedNamespace,
    file: target.file,
    firstLine: target.firstLine,
    lastLine: target.lastLine,
    lines,
    scenarios,
    samePathGroups: samePathGroups(scenarios),
    untestedLines: [...executable].filter((line) => !lineScenarios.has(line)).sort((a, b) => a - b),
    executableLineCount: executable.size,
  };
}

/** The function's own lines plus those of comprehensions, lambdas and nested defs in it. */
function executableLines(catalog: CatalogFunction[], target: CatalogFunction): Set<number> {
  const lines = new Set<number>();
  for (const fn of catalog) {
    if (fn.file === target.file && fn.firstLine >= target.firstLine && fn.lastLine <= target.lastLine) {
      for (const line of fn.lines) lines.add(line);
    }
  }
  return lines;
}

function isInside(span: Span, target: CatalogFunction): boolean {
  return span.fn.file === target.file && span.fn.firstLine >= target.firstLine && span.fn.firstLine <= target.lastLine;
}

function collapseRepeats(lines: number[]): number[] {
  const path: number[] = [];
  for (const line of lines) {
    if (path[path.length - 1] !== line) path.push(line);
  }
  return path;
}

function samePathGroups(scenarios: ScenarioPath[]): string[][] {
  const bySignature = new Map<string, string[]>();
  for (const scenario of scenarios) {
    const signature = scenario.lines.join(",");
    const group = bySignature.get(signature) ?? [];
    group.push(scenario.scenarioId);
    bySignature.set(signature, group);
  }
  return [...bySignature.values()].filter((group) => group.length > 1);
}
