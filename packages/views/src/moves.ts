import { CatalogFunction, CodeSymbol, QualifiedName, Run } from "@runshape/trace";

/** The same function under another name in head: moved, not changed. */
export interface FunctionMove {
  from: CodeSymbol;
  to: CodeSymbol;
}

/** A namespace gone from head whose moved functions all went to one new namespace. */
export interface NamespaceMove {
  from: QualifiedName;
  to: QualifiedName;
}

/** What moved between two recordings, and how to read the base's names as head's. */
export class Moves {
  private readonly headSymbols: Map<string, CodeSymbol>;

  constructor(
    readonly functions: FunctionMove[],
    readonly namespaces: NamespaceMove[],
  ) {
    this.headSymbols = new Map(functions.map(({ from, to }) => [from.key, to]));
  }

  static none(): Moves {
    return new Moves([], []);
  }

  /** A base CodeSymbol.key as head names that function. */
  headKey = (baseKey: string): string => this.headSymbols.get(baseKey)?.key ?? baseKey;

  /** A base module or class name as head names it. */
  headName = (name: QualifiedName): QualifiedName => {
    for (const { from, to } of this.namespaces) {
      if (from.equals(name) || from.holds(name)) return new QualifiedName([...to.segments, ...name.segments.slice(from.segments.length)]);
    }
    return name;
  };

  /** One line per namespace that moved, one per function that moved on its own. */
  describe(): string[] {
    const lines = this.namespaces.map(({ from, to }) => {
      const count = this.functions.filter((move) => move.from.namespaceName.equals(from)).length;
      return `${from.text} -> ${to.text} (${count} function${count === 1 ? "" : "s"})`;
    });
    for (const { from, to } of this.functions) {
      if (this.namespaces.some((move) => move.from.equals(from.namespaceName))) continue;
      lines.push(`${from.localName.text}: ${from.namespaceName.text} -> ${to.namespaceName.text}`);
    }
    return lines;
  }
}

/**
 * Pairs each function only the base has with one only head has, when they share a name within
 * their namespace, a kind and their source text, and no other function shares all three. Needs
 * both recordings' source: without it, a move and a rewrite look alike, and nothing is paired.
 */
export function detectMoves(base: Run, head: Run): Moves {
  if (base.sources === null || head.sources === null) return Moves.none();
  const baseKeys = new Set(base.catalog.map((fn) => fn.symbol.key));
  const headKeys = new Set(head.catalog.map((fn) => fn.symbol.key));
  const gone = groupBy(base.catalog.filter((fn) => !headKeys.has(fn.symbol.key)), (fn) => signature(base, fn));
  const added = groupBy(head.catalog.filter((fn) => !baseKeys.has(fn.symbol.key)), (fn) => signature(head, fn));

  const functions: FunctionMove[] = [];
  for (const [key, candidates] of gone) {
    const targets = added.get(key);
    if (candidates.length === 1 && targets?.length === 1) functions.push({ from: candidates[0]!.symbol, to: targets[0]!.symbol });
  }

  const headNamespaces = new Set(head.catalog.map((fn) => fn.symbol.namespaceName.key));
  const destinations = new Map<string, { from: QualifiedName; to: Map<string, QualifiedName> }>();
  for (const { from, to } of functions) {
    const entry = destinations.get(from.namespaceName.key) ?? { from: from.namespaceName, to: new Map() };
    entry.to.set(to.namespaceName.key, to.namespaceName);
    destinations.set(from.namespaceName.key, entry);
  }
  const namespaces: NamespaceMove[] = [];
  for (const { from, to } of destinations.values()) {
    if (to.size === 1 && !headNamespaces.has(from.key)) namespaces.push({ from, to: [...to.values()][0]! });
  }
  return new Moves(functions, namespaces);
}

/** What has to match for two functions to be the same code: name within the namespace, kind, text. */
function signature(run: Run, fn: CatalogFunction): string {
  const text: string[] = [];
  for (let line = fn.firstLine; line <= fn.lastLine; line += 1) text.push(run.sourceLine(fn.file, line)?.trim() ?? "");
  return JSON.stringify([fn.symbol.localName.key, fn.symbol.kind, text]);
}

/** Groups in first-seen order, so moves are listed in catalog order. */
function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
}
