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

/**
 * A commit's architecture: its rules, and where they and the recorded behaviour put each
 * component the recorded tests ran. Saved with each recording (architecture.json). Rule
 * placements are decisions; inferred ones follow what the tests did, so a test that mocks the
 * database can move them: comparisons must keep the two apart.
 */
export interface ArchitectureSnapshot {
  /** Of this file's format: a format change mustn't read as an architecture change. */
  version: typeof ARCHITECTURE_FORMAT_VERSION;
  style: string;
  /** The style's zones, so a person reading the file sees names, not only ids. */
  zones: { id: string; name: string }[];
  rules: ZoneRule[];
  /** Rules no recorded component matched: after a rename, it's the rule that needs a look. */
  unusedRules: string[];
  /** By kind and component name, in code-unit order: two snapshots line up, on any machine. */
  placements: Placement[];
}

export const ARCHITECTURE_FORMAT_VERSION = 1;

/** A class built only while setting up still has a place: placements look at every phase. */
const EVERY_PHASE = [Phase.Setup, Phase.Call, Phase.Teardown];

export function buildPlacements(run: Run, rules: ZoneRules): ArchitectureSnapshot {
  const graph = buildSystemGraph(run, { phases: EVERY_PHASE, grouping: FINE_GROUPING, rules, profile: rules.profile });
  const placements: Placement[] = [];
  const used = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind !== ComponentKind.Class && node.kind !== ComponentKind.Module) continue;
    // Never true of a class or module today; it tells the compiler what's left.
    if (node.qualifiedName === null || node.zoneSource === ZoneSource.Fixed) continue;
    const rule = node.zoneSource === ZoneSource.Rule ? (rules.matchFor(QualifiedName.parse(node.qualifiedName))?.rule ?? null) : null;
    if (rule !== null) used.add(rule.match);
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
  placements.sort((a, b) => byCodeUnit(a.component, b.component) || byCodeUnit(a.kind, b.kind));
  return {
    version: ARCHITECTURE_FORMAT_VERSION,
    style: rules.profile.style,
    zones: rules.profile.zones.map(({ id, name }) => ({ id, name })),
    rules: rules.rules,
    unusedRules: rules.rules.map((rule) => rule.match).filter((match) => !used.has(match)),
    placements,
  };
}

/** Code-unit order: localeCompare would sort by the recording machine's language. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
