// The module view's boxes: which name prefixes are modules. Regions declared at the top of
// runshape.json are modules as written; elsewhere the names decide (see test/modules.test.ts).
import { QualifiedName } from "@runshape/kernel";

import { ZoneRules } from "./zones";

/**
 * The modules of a project, as dotted prefixes: each top-level region, then, for the rest of
 * the names, below each top-level name, down while there's only one way down (app.src.…),
 * one module per branch there ("packages" → "packages.trace", "packages.cli", …).
 */
export function moduleRoots(names: QualifiedName[], rules: ZoneRules): string[] {
  const regions = rules.regions.map((region) => QualifiedName.parse(region.match.replace(/\.\*\*$/, "")));
  const rest = names.filter((name) => !regions.some((region) => region.equals(name) || region.holds(name)));
  const modules = new Set(regions.map((region) => region.text));
  for (const [, group] of groupBy(rest, (name) => name.segments[0]!)) for (const module of branches([], group.map((name) => name.segments))) modules.add(module);
  return [...modules].sort();
}

function branches(prefix: readonly string[], names: (readonly string[])[]): string[] {
  const depth = prefix.length;
  const next = new Set(names.map((name) => name[depth]));
  // One way down, and no name stops here: the module boundary is further in.
  if (next.size === 1 && !next.has(undefined) && names.some((name) => name.length > depth + 1)) {
    return branches([...prefix, [...next][0]!], names);
  }
  if (depth === 0) return [...next].filter((segment) => segment !== undefined).map((segment) => new QualifiedName([segment!]).text);
  return [...next].map((segment) => new QualifiedName(segment === undefined ? [...prefix] : [...prefix, segment]).text);
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
}
