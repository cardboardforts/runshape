// Seams: calls whose two ends sit in different regions (runshape.json v3), where one style hands
// over to another. See test/seams.test.ts for what counts as going in the right way.
import { QualifiedName, SystemGraph } from "@runshape/kernel";

import { forbiddenCall, profileFor } from "./profiles";
import { RegionPlacement, ZoneRules } from "./zones";

/** A call the regions have something to say about: it crosses a boundary (a seam), or breaks the style of the region it's in. */
export interface RegionCall {
  edgeId: string;
  /** The regions the call goes into, outermost first. */
  enters: string[];
  /** The regions it comes out of, innermost first. */
  leaves: string[];
  /** Why the crossing breaks a region's style; null when it goes in the way the style expects. */
  violation: string | null;
}

/**
 * Every call in the graph that crosses a region boundary, and every call inside a region that
 * its style forbids. A call entering a region must land on the region's way in: the zone its
 * style puts facing requests (the first). At the deepest level both ends share, below the top,
 * the call must be one that level's style allows. Leaving a region isn't judged yet.
 */
export function regionCalls(graph: SystemGraph, rules: ZoneRules): RegionCall[] {
  // Once per component, not per call: a component is at the end of many calls.
  const placements = new Map<string, RegionPlacement[]>();
  for (const node of graph.nodes) if (node.qualifiedName !== null) placements.set(node.id, rules.placementsOf(QualifiedName.parse(node.qualifiedName)));
  const calls: RegionCall[] = [];
  for (const edge of graph.edges) {
    const [caller, callee] = [placements.get(edge.from), placements.get(edge.to)];
    if (caller === undefined || callee === undefined) continue;
    const shared = sharedDepth(caller, callee);
    const problems: string[] = [];
    // The top level's own check is the edge's violation; below it, the shared region's style decides.
    const common = shared - 1;
    if (common > 0) {
      const profile = profileFor(caller[common]!.style);
      const [a, b] = [caller[common]!.zone, callee[common]!.zone];
      const forbidden = profile === undefined || a === null || b === null ? null : forbiddenCall(profile, a, b);
      if (forbidden !== null) problems.push(`in the ${caller[common]!.region} region: ${forbidden}`);
    }
    for (const entered of callee.slice(shared)) {
      const wayIn = profileFor(entered.style)?.zones[0]?.id;
      if (wayIn !== undefined && entered.zone !== null && entered.zone !== wayIn) {
        problems.push(`reaches past the ${entered.region} region's way in (${wayIn}) into its ${entered.zone} zone`);
      }
    }
    const enters = callee.slice(shared).map((placement) => placement.region);
    const leaves = caller.slice(shared).map((placement) => placement.region).reverse();
    if (enters.length === 0 && leaves.length === 0 && problems.length === 0) continue;
    calls.push({ edgeId: edge.id, enters, leaves, violation: problems.length === 0 ? null : problems.join("; ") });
  }
  return calls;
}

/** How many levels, from the top, both ends are in the same region. */
function sharedDepth(a: RegionPlacement[], b: RegionPlacement[]): number {
  let depth = 0;
  while (depth < a.length && depth < b.length && a[depth]!.region === b[depth]!.region) depth += 1;
  return depth;
}
