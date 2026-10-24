// The trace module's diffs take the graphs the arch module drew for them; a workflow wires the
// two (comparedGraphs, then diffRuns or buildReview), and these tests wire them the same way.
import { comparedGraphs } from "@runshape/architecture";
import type { ArchitectureProfile, Grouping, Phase, Run } from "@runshape/core";
import type { ZoneRules } from "@runshape/architecture";

import { buildReview, diffRuns, Moves } from "../src";

interface Options {
  phases?: Phase[];
  grouping?: Grouping;
  rules?: ZoneRules;
  baseRules?: ZoneRules;
  profile?: ArchitectureProfile;
  moves?: Moves;
}

export function diffOf(before: Run, after: Run, options: Options = {}) {
  return diffRuns(before, after, comparedGraphs(before, after, options), options);
}

export function reviewOf(base: Run, head: Run, options: Options = {}) {
  return buildReview(base, head, comparedGraphs(base, head, options), options);
}
