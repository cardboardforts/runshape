import { ComponentKind, QualifiedName, ZoneSource } from "@runshape/trace";
import { ZoneRule } from "@runshape/architecture";
import { Moves } from "./moves";
import { ArchitectureSnapshot, byCodeUnit, Placement } from "./placements";

/** One component's place before and after; null on the side it doesn't exist. */
export interface PlacementChange {
  component: string;
  kind: Placement["kind"];
  before: Placement | null;
  after: Placement | null;
  /** Its name in the base, when it moved there from somewhere else. */
  movedFrom: string | null;
}

/**
 * How the architecture moved between two commits, decisions apart from observations: see
 * the test (architecture-diff.test.ts) for why.
 */
export interface ArchitectureDiff {
  /** The styles the two commits' runshape.json declare; both are placed in the second. */
  styleBefore: string;
  styleAfter: string;
  /** The zones placements name, in the style they're placed in. */
  zones: { id: string; name: string }[];
  /** Rules by their glob: added, removed, or kept with another zone, reason or decider. */
  rules: { added: ZoneRule[]; removed: ZoneRule[]; changed: { before: ZoneRule; after: ZoneRule }[] };
  /** Placements a rule made or unmade: someone decided these. */
  decided: PlacementChange[];
  /** Inferred zones that moved with the tests' behaviour, no rule on either side. */
  observed: PlacementChange[];
  /** New code no rule places: inferred for now, waiting for a decision. */
  unplaced: Placement[];
  /** Code head no longer has (or the tests no longer run). */
  removed: Placement[];
  /** Head's rules no recorded component matches. */
  unusedRules: string[];
}

export function diffArchitecture(before: ArchitectureSnapshot, after: ArchitectureSnapshot, moves: Moves = Moves.none()): ArchitectureDiff {
  // The base's components under head's names: a moved class is the same class.
  const headName = (placement: Placement): string => {
    const name = QualifiedName.parse(placement.component);
    return (placement.kind === ComponentKind.Class ? moves.type(name) : moves.module(name)).text;
  };
  const keyOf = (kind: string, component: string) => `${kind} ${component}`;
  // Code merged into a class that was already there: the one that kept its name is that
  // class's past; the rest are gone (otherwise sort order would pick, and could hide a rule).
  const previous = new Map<string, Placement>();
  const merged: Placement[] = [];
  for (const placement of before.placements) {
    const key = keyOf(placement.kind, headName(placement));
    const held = previous.get(key);
    if (held === undefined) previous.set(key, placement);
    else if (placement.component === headName(placement)) {
      merged.push(held);
      previous.set(key, placement);
    } else merged.push(placement);
  }
  const decided: PlacementChange[] = [];
  const observed: PlacementChange[] = [];
  const unplaced: Placement[] = [];

  for (const now of after.placements) {
    const key = keyOf(now.kind, now.component);
    const was = previous.get(key) ?? null;
    previous.delete(key);
    const change: PlacementChange = { component: now.component, kind: now.kind, before: was, after: now, movedFrom: was !== null && was.component !== now.component ? was.component : null };
    if (was === null) {
      if (now.source === ZoneSource.Rule) decided.push(change);
      else unplaced.push(now);
      continue;
    }
    const byRule = was.source === ZoneSource.Rule || now.source === ZoneSource.Rule;
    if (byRule && (was.zone !== now.zone || was.rule !== now.rule || was.decidedBy !== now.decidedBy)) decided.push(change);
    else if (!byRule && was.zone !== now.zone) observed.push(change);
  }

  return {
    styleBefore: before.declaredStyle,
    styleAfter: after.declaredStyle,
    zones: after.zones,
    rules: diffRules(before.rules, after.rules),
    decided,
    observed,
    unplaced,
    removed: [...previous.values(), ...merged].sort((a, b) => byCodeUnit(a.component, b.component)),
    unusedRules: after.unusedRules,
  };
}

function diffRules(before: ZoneRule[], after: ZoneRule[]): ArchitectureDiff["rules"] {
  const old = new Map(before.map((rule) => [rule.match, rule]));
  const now = new Set(after.map((rule) => rule.match));
  const changed: { before: ZoneRule; after: ZoneRule }[] = [];
  const added: ZoneRule[] = [];
  for (const rule of after) {
    const was = old.get(rule.match);
    if (was === undefined) added.push(rule);
    else if (was.zone !== rule.zone || was.reason !== rule.reason || was.by !== rule.by) changed.push({ before: was, after: rule });
  }
  return { added, removed: before.filter((rule) => !now.has(rule.match)), changed };
}
