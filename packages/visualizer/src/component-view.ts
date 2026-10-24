import { CatalogFunction, CodeSymbol, ComponentView, componentOf, FINE_GROUPING, FunctionRef, functionRef, FunctionSummary, Grouping, QualifiedName, Run, Span, SymbolKind } from "@runshape/kernel";

interface Tally {
  symbol: CodeSymbol;
  calls: number;
  totalUs: number;
  selfUs: number;
  lines: Set<number>;
  scenarioIds: Set<string>;
}

export function buildComponentView(run: Run, componentId: string, grouping: Grouping = FINE_GROUPING): ComponentView {
  const tallies = new Map<string, Tally>();
  let label = componentId;
  let name: QualifiedName | null = null;

  for (const scenario of run.scenarios) {
    for (const span of scenario.spans) {
      const ref = componentOf(span, grouping);
      if (ref.id !== componentId) continue;
      label = ref.label;
      name = ref.name;
      let tally = tallies.get(span.fn.symbol.key);
      if (tally === undefined) {
        tally = { symbol: span.fn.symbol, calls: 0, totalUs: 0, selfUs: 0, lines: new Set(), scenarioIds: new Set() };
        tallies.set(span.fn.symbol.key, tally);
      }
      tally.calls += 1;
      if (!insideItself(span)) {
        const total = span.endUs - span.startUs;
        const inChildren = span.children.reduce((sum, child) => sum + (child.endUs - child.startUs), 0);
        tally.totalUs += total;
        tally.selfUs += Math.max(0, total - inChildren);
      }
      tally.scenarioIds.add(scenario.nodeid);
      for (const line of span.lines) tally.lines.add(line);
    }
  }

  const functions: FunctionSummary[] = [];
  const listed = new Set<string>();
  for (const fn of ownFunctions(run, name)) {
    listed.add(fn.symbol.key);
    functions.push(summarize(fn, tallies.get(fn.symbol.key), null));
  }
  // Methods that ran on these objects but are defined elsewhere (a base class).
  for (const tally of tallies.values()) {
    const { symbol } = tally;
    if (listed.has(symbol.key)) continue;
    // Comprehensions, lambdas and nested defs belong to the function that contains them
    // (its function view shows their lines); they aren't methods of their own.
    if (symbol.kind === SymbolKind.Nested) continue;
    const fn = run.catalogFunction(symbol.key);
    if (fn === undefined) continue;
    const owner = symbol.ownerType ?? symbol.namespaceName.text;
    functions.push(summarize(fn, tally, owner));
  }
  return { id: componentId, label, qualifiedName: name?.text ?? null, functions };
}

/** A call nested in a call of the same function: its time is already in the outer one's. */
function insideItself(span: Span): boolean {
  for (let ancestor = span.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.fn === span.fn) return true;
  }
  return false;
}

function ownFunctions(run: Run, name: QualifiedName | null): CatalogFunction[] {
  if (name === null) return [];
  const modules = run.catalog.filter((fn) => fn.symbol.namespaceName.equals(name));
  if (modules.length > 0) {
    // A module component: its top-level functions.
    return modules.filter((fn) => fn.symbol.container.length === 0);
  }
  const module = name.parent();
  if (module === null) return [];
  return run.catalog.filter(({ symbol }) => symbol.namespaceName.equals(module) && symbol.container.length === 1 && symbol.container[0] === name.last);
}

function summarize(fn: CatalogFunction, tally: Tally | undefined, inheritedFrom: string | null): FunctionSummary {
  const executable = new Set(fn.lines);
  let covered = 0;
  for (const line of tally?.lines ?? []) {
    if (executable.has(line)) covered += 1;
  }
  return {
    symbol: functionRef(fn.symbol),
    name: fn.symbol.name,
    file: fn.file,
    firstLine: fn.firstLine,
    inheritedFrom,
    executableLines: executable.size,
    coveredLines: covered,
    calls: tally?.calls ?? 0,
    totalUs: tally?.totalUs ?? 0,
    selfUs: tally?.selfUs ?? 0,
    scenarioIds: [...(tally?.scenarioIds ?? [])].sort(),
  };
}
