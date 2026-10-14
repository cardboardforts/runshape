import { Renaming } from "@runshape/architecture";
import { CatalogFunction, CodeSymbol, QualifiedName, Role, Run, Scenario } from "@runshape/trace";

/** The same function under another name in head: moved, and maybe edited on the way. */
export interface FunctionMove {
  from: CodeSymbol;
  to: CodeSymbol;
  /** Paired by name inside a moved namespace, its text differs: the comparison shows how. */
  edited: boolean;
}

/** A namespace gone from head whose moved functions all went to one other namespace. */
export interface NamespaceMove {
  from: QualifiedName;
  to: QualifiedName;
}

/** A test only the base has and one only head has, with the same name: its file moved. */
export interface TestMove {
  from: Scenario;
  to: Scenario;
}

/** A class gone from head whose methods all moved to one class elsewhere. */
export interface TypeMove {
  from: QualifiedName;
  to: QualifiedName;
}

/**
 * What moved between two recordings, and how to read the base's names as head's. A name is
 * renamed only when it is exactly a moved namespace or type: moving app.db.repositories says
 * nothing about app.db.repositories.users beside it.
 */
export class Moves implements Renaming {
  private readonly headSymbols: Map<string, CodeSymbol>;
  private readonly headNamespaces: Map<string, QualifiedName>;
  private readonly headTypes: Map<string, QualifiedName>;
  private readonly baseTestIds: Map<string, string>;
  private readonly headTestIds: Map<string, string>;

  constructor(
    readonly functions: FunctionMove[],
    readonly namespaces: NamespaceMove[],
    readonly types: TypeMove[],
    readonly tests: TestMove[] = [],
  ) {
    this.headSymbols = new Map(functions.map(({ from, to }) => [from.key, to]));
    // A moved test's own function moved with it, catalogued or not (TypeScript tests aren't).
    for (const { from, to } of tests) {
      const [was, now] = [testFunction(from), testFunction(to)];
      if (was !== null && now !== null && !this.headSymbols.has(was.key)) this.headSymbols.set(was.key, now);
    }
    this.baseTestIds = new Map(tests.map(({ from, to }) => [to.nodeid, from.nodeid]));
    this.headTestIds = new Map(tests.map(({ from, to }) => [from.nodeid, to.nodeid]));
    this.headNamespaces = new Map(namespaces.map(({ from, to }) => [from.key, to]));
    this.headTypes = new Map(types.map(({ from, to }) => [from.key, to]));
  }

  static none(): Moves {
    return new Moves([], [], []);
  }

  /** The base's id for a head test: its old id if its file moved. */
  baseScenarioId = (headId: string): string => this.baseTestIds.get(headId) ?? headId;

  /** Head's id for a base test. */
  headScenarioId = (baseId: string): string => this.headTestIds.get(baseId) ?? baseId;

  /** A base CodeSymbol.key as head names that function. */
  headKey = (baseKey: string): string => this.headSymbols.get(baseKey)?.key ?? baseKey;

  /** A base module's name as head names it. */
  module = (name: QualifiedName): QualifiedName => this.headNamespaces.get(name.key) ?? name;

  /** A base class's name as head names it: its own move, or its module's. */
  type = (name: QualifiedName): QualifiedName => {
    const moved = this.headTypes.get(name.key);
    if (moved !== undefined) return moved;
    const namespace = name.parent();
    const movedNamespace = namespace === null ? undefined : this.headNamespaces.get(namespace.key);
    return movedNamespace === undefined ? name : new QualifiedName([...movedNamespace.segments, name.last]);
  };

  /** One line per namespace that moved, one per function that moved on its own. */
  describe(): string[] {
    const lines = this.namespaces.map(({ from, to }) => {
      const moved = this.functions.filter((move) => move.from.namespaceName.equals(from));
      const edited = moved.filter((move) => move.edited).length;
      return `${from.text} -> ${to.text} (${moved.length} function${moved.length === 1 ? "" : "s"}${edited > 0 ? `, ${edited} edited` : ""})`;
    });
    for (const { from, to } of this.functions) {
      if (this.headNamespaces.has(from.namespaceName.key)) continue;
      lines.push(`${from.localName.text}: ${from.namespaceName.text} -> ${to.namespaceName.text}`);
    }
    const testFiles = new Map<string, number>();
    for (const { from, to } of this.tests) testFiles.set(`${from.file} -> ${to.file}`, (testFiles.get(`${from.file} -> ${to.file}`) ?? 0) + 1);
    for (const [files, count] of testFiles) lines.push(`${files} (${count} test${count === 1 ? "" : "s"})`);
    return lines;
  }
}

/** The span a test's own function opened, at the root of its scenario. */
function testFunction(scenario: Scenario): CodeSymbol | null {
  const roots = scenario.spans.filter((span) => span.parent === null && span.fn.role === Role.Test);
  return roots.length === 1 ? roots[0]!.fn.symbol : null;
}

/**
 * Tests only one side has, paired one to one by their whole name within their file (Python's
 * includes the class, vitest's the describe blocks), and only out of a file head no longer has
 * tests in: a test whose file is still there didn't move.
 */
function testMoves(base: Run, head: Run): TestMove[] {
  const headIds = new Set(head.scenarios.map((scenario) => scenario.nodeid));
  const baseIds = new Set(base.scenarios.map((scenario) => scenario.nodeid));
  const headFiles = new Set(head.scenarios.map((scenario) => scenario.file));
  const nameInFile = (scenario: Scenario) => scenario.nodeid.slice(scenario.file.length);
  // A retried or repeated test is written once per attempt: one test, for pairing.
  const firsts = (scenarios: Scenario[]) => [...new Map(scenarios.map((scenario) => [scenario.nodeid, scenario])).values()];
  const added = groupBy(firsts(head.scenarios.filter((scenario) => !baseIds.has(scenario.nodeid))), nameInFile);
  const gone = firsts(base.scenarios.filter((scenario) => !headIds.has(scenario.nodeid) && !headFiles.has(scenario.file)));
  const moves: TestMove[] = [];
  for (const [name, candidates] of groupBy(gone, nameInFile)) {
    const targets = added.get(name);
    if (candidates.length === 1 && targets?.length === 1) moves.push({ from: candidates[0]!, to: targets[0]! });
  }
  return moves;
}

/**
 * Tests only one side has pair by their whole name within the file, one to one, when the file
 * they were in has no tests in head: the file moved (see testMoves). The rest needs both recordings' source: without it a move and a rewrite look
 * alike, and no function pairs.
 *
 * 1. A function only the base has pairs with one only head has when they share their name within
 *    the namespace, their kind and their source text, and nothing else shares all three. Bodies
 *    of a line or two (`pass`, `return None`) are too common to pair on text alone.
 * 2. A namespace moved when it's gone from head and those pairs all went to one namespace.
 * 3. Inside a moved namespace, the functions left over pair by name and kind: moved and edited,
 *    so the comparison shows their real change rather than a function gone and a namesake new.
 * 4. A class moved when it's gone from head and its paired methods all went to one class.
 */
export function detectMoves(base: Run, head: Run): Moves {
  // Tests pair by name, which needs no source.
  const tests = testMoves(base, head);
  if (base.sources === null || head.sources === null) return new Moves([], [], [], tests);
  const baseKeys = new Set(base.catalog.map((fn) => fn.symbol.key));
  const headKeys = new Set(head.catalog.map((fn) => fn.symbol.key));
  const gone = base.catalog.filter((fn) => !headKeys.has(fn.symbol.key));
  const added = head.catalog.filter((fn) => !baseKeys.has(fn.symbol.key));
  const paired = new Set<CatalogFunction>();
  const functions: FunctionMove[] = [];
  const pair = (from: CatalogFunction, to: CatalogFunction, edited: boolean) => {
    functions.push({ from: from.symbol, to: to.symbol, edited });
    paired.add(from).add(to);
  };

  const byText = (run: Run, fns: CatalogFunction[]) => groupBy(fns.filter((fn) => !trivial(run, fn)), (fn) => JSON.stringify([fn.symbol.localName.key, fn.symbol.kind, text(run, fn)]));
  const addedByText = byText(head, added);
  for (const [key, candidates] of byText(base, gone)) {
    const targets = addedByText.get(key);
    if (candidates.length === 1 && targets?.length === 1) pair(candidates[0]!, targets[0]!, false);
  }

  const namespaces = soleDestinations(
    functions.map(({ from, to }) => ({ from: from.namespaceName, to: to.namespaceName })),
    new Set(head.catalog.map((fn) => fn.symbol.namespaceName.key)),
  );

  for (const { from, to } of namespaces) {
    const left = gone.filter((fn) => !paired.has(fn) && fn.symbol.namespaceName.equals(from));
    const targets = groupBy(added.filter((fn) => !paired.has(fn) && fn.symbol.namespaceName.equals(to)), (fn) => JSON.stringify([fn.symbol.localName.key, fn.symbol.kind]));
    for (const [key, candidates] of groupBy(left, (fn) => JSON.stringify([fn.symbol.localName.key, fn.symbol.kind]))) {
      const target = targets.get(key);
      if (candidates.length === 1 && target?.length === 1) pair(candidates[0]!, target[0]!, text(base, candidates[0]!) !== text(head, target[0]!));
    }
  }

  const headOwners = new Set(head.catalog.filter((fn) => fn.symbol.ownerType !== null).map((fn) => fn.symbol.owner.key));
  const types = soleDestinations(
    functions.filter(({ from, to }) => from.ownerType !== null && to.ownerType !== null).map(({ from, to }) => ({ from: from.owner, to: to.owner })),
    headOwners,
  );

  const order = new Map(base.catalog.map((fn, index) => [fn.symbol.key, index]));
  functions.sort((a, b) => order.get(a.from.key)! - order.get(b.from.key)!);
  return new Moves(functions, namespaces, types, tests);
}

/** Names gone from head (not in `stillThere`) whose pairs all point to one other name. */
function soleDestinations(pairs: { from: QualifiedName; to: QualifiedName }[], stillThere: Set<string>): { from: QualifiedName; to: QualifiedName }[] {
  const destinations = new Map<string, { from: QualifiedName; to: Map<string, QualifiedName> }>();
  for (const { from, to } of pairs) {
    if (from.equals(to)) continue;
    const entry = destinations.get(from.key) ?? { from, to: new Map() };
    entry.to.set(to.key, to);
    destinations.set(from.key, entry);
  }
  return [...destinations.values()].filter(({ from, to }) => to.size === 1 && !stillThere.has(from.key)).map(({ from, to }) => ({ from, to: [...to.values()][0]! }));
}

function lines(run: Run, fn: CatalogFunction): string[] {
  const text: string[] = [];
  for (let line = fn.firstLine; line <= fn.lastLine; line += 1) text.push(run.sourceLine(fn.file, line)?.trim() ?? "");
  return text;
}

function text(run: Run, fn: CatalogFunction): string {
  return lines(run, fn).join("\n");
}

/** Its declaration and at most one line besides: common enough that equal text proves nothing. */
const TRIVIAL_LINE_COUNT = 2;

function trivial(run: Run, fn: CatalogFunction): boolean {
  return lines(run, fn).filter((line) => line !== "").length <= TRIVIAL_LINE_COUNT;
}

/** Groups in first-seen order. */
function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
}
