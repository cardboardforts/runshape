import { CatalogFunction, lastSegment, Run } from "../model";
import { componentOf, FINE_GROUPING, Grouping } from "./components";

/** One box from the system graph opened up: its functions and how much the tests reach. */
export interface ComponentView {
  id: string;
  label: string;
  qualifiedName: string | null;
  functions: FunctionSummary[];
}

export interface FunctionSummary {
  module: string;
  qualname: string;
  name: string;
  file: string;
  firstLine: number;
  /** Set when the method is defined on a base class but ran on this component's objects. */
  inheritedFrom: string | null;
  executableLines: number;
  coveredLines: number;
  calls: number;
  scenarioIds: string[];
}

interface Tally {
  calls: number;
  lines: Set<number>;
  scenarioIds: Set<string>;
}

export function buildComponentView(run: Run, componentId: string, grouping: Grouping = FINE_GROUPING): ComponentView {
  const tallies = new Map<string, Tally>();
  let label = componentId;
  let qualifiedName: string | null = null;

  for (const scenario of run.scenarios) {
    for (const span of scenario.spans) {
      const ref = componentOf(span, grouping);
      if (ref.id !== componentId) continue;
      label = ref.label;
      qualifiedName = ref.qualifiedName;
      const key = `${span.fn.module}:${span.fn.qualname}`;
      let tally = tallies.get(key);
      if (tally === undefined) {
        tally = { calls: 0, lines: new Set(), scenarioIds: new Set() };
        tallies.set(key, tally);
      }
      tally.calls += 1;
      tally.scenarioIds.add(scenario.nodeid);
      for (const line of span.lines) tally.lines.add(line);
    }
  }

  const functions: FunctionSummary[] = [];
  const listed = new Set<string>();
  for (const fn of ownFunctions(run, qualifiedName)) {
    listed.add(`${fn.module}:${fn.qualname}`);
    functions.push(summarize(fn, tallies.get(`${fn.module}:${fn.qualname}`), null));
  }
  // Methods that ran on these objects but are defined elsewhere (a base class).
  for (const [key, tally] of tallies) {
    if (listed.has(key)) continue;
    const [module = "", qualname = ""] = key.split(":");
    const fn = run.catalogFunction(module, qualname);
    if (fn === undefined) continue;
    const owner = qualname.includes(".") ? qualname.slice(0, qualname.indexOf(".")) : module;
    functions.push(summarize(fn, tally, owner));
  }
  return { id: componentId, label, qualifiedName, functions };
}

function ownFunctions(run: Run, qualifiedName: string | null): CatalogFunction[] {
  if (qualifiedName === null) return [];
  const modules = run.catalog.filter((fn) => fn.module === qualifiedName);
  if (modules.length > 0) {
    // A module component: its top-level functions.
    return modules.filter((fn) => !fn.qualname.includes("."));
  }
  const module = qualifiedName.slice(0, qualifiedName.lastIndexOf("."));
  const className = lastSegment(qualifiedName);
  return run.catalog.filter((fn) => {
    if (fn.module !== module) return false;
    const segments = fn.qualname.split(".");
    return segments.length === 2 && segments[0] === className;
  });
}

function summarize(fn: CatalogFunction, tally: Tally | undefined, inheritedFrom: string | null): FunctionSummary {
  const executable = new Set(fn.lines);
  let covered = 0;
  for (const line of tally?.lines ?? []) {
    if (executable.has(line)) covered += 1;
  }
  return {
    module: fn.module,
    qualname: fn.qualname,
    name: lastSegment(fn.qualname),
    file: fn.file,
    firstLine: fn.firstLine,
    inheritedFrom,
    executableLines: executable.size,
    coveredLines: covered,
    calls: tally?.calls ?? 0,
    scenarioIds: [...(tally?.scenarioIds ?? [])].sort(),
  };
}
