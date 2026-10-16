import { Phase, QualifiedName, Run } from "@runshape/trace";
import { ComponentKind, FINE_GROUPING, ZoneRule, ZoneRules } from "@runshape/architecture";
import { buildSystemGraph, ZoneSource } from "./system-graph";

/** One of the project's classes or modules, where it sits, and who put it there. */
export interface Placement {
  /** Its name in Runshape's dotted syntax, as runshape.json globs match it. */
  component: string;
  kind: ComponentKind.Class | ComponentKind.Module;
  zone: string;
  source: ZoneSource.Rule | ZoneSource.Inferred;
  /** The glob of the rule that placed it; null when inferred. */
  rule: string | null;
  /** Who made the rule: a person, or a model's or the detector's proposal a person accepted. */
  decidedBy: ZoneRule["by"] | null;
  /** The rule's reason, or the behaviour inference went by. */
  reason: string;
}

/** A commit's architecture: its rules, and where they and the recorded behaviour put each component. */
export interface ArchitectureSnapshot {
  style: string;
  rules: ZoneRule[];
  /** By component name, so two snapshots line up and read top to bottom. */
  placements: Placement[];
}

/** A class built only while setting up still has a place: placements look at every phase. */
const EVERY_PHASE = [Phase.Setup, Phase.Call, Phase.Teardown];

export function buildPlacements(run: Run, rules: ZoneRules): ArchitectureSnapshot {
  const graph = buildSystemGraph(run, { phases: EVERY_PHASE, grouping: FINE_GROUPING, rules, profile: rules.profile });
  const placements: Placement[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== ComponentKind.Class && node.kind !== ComponentKind.Module) continue;
    // Never true of a class or module today; it tells the compiler what's left.
    if (node.qualifiedName === null || node.zoneSource === ZoneSource.Fixed) continue;
    const rule = node.zoneSource === ZoneSource.Rule ? (rules.matchFor(QualifiedName.parse(node.qualifiedName))?.rule ?? null) : null;
    placements.push({
      component: node.qualifiedName,
      kind: node.kind,
      zone: node.zone,
      source: node.zoneSource,
      rule: rule?.match ?? null,
      decidedBy: rule?.by ?? null,
      reason: rule?.reason ?? node.zoneReason,
    });
  }
  placements.sort((a, b) => a.component.localeCompare(b.component));
  return { style: rules.profile.style, rules: rules.rules, placements };
}
