/**
 * Seams (PLAN.md Phase 2): a call whose two ends sit in different regions. A use case can run
 * through a hexagon's core into a layered module and back; the seam is where one style hands
 * over to another, and where a reviewer's mental model has to switch.
 *
 * Going in through the region's front is expected: a layered region is entered at its
 * presentation layer, a hexagonal one at its inbound adapters. Reaching past the front, into a
 * region's business layer or core, is a violation of the region. At the deepest level both
 * ends share, the call must be one that level's style allows (the top level's own check is the
 * graph's edge violation, unchanged).
 */
import { describe, expect, test } from "vitest";

import { ComponentKind, GraphEdge, GraphNode, SystemGraph, ZoneSource } from "@runshape/kernel";
import { HEXAGONAL, regionCalls, ZoneRules } from "../src";

const RULES = ZoneRules.parse(
  JSON.stringify({
    version: 3,
    style: "hexagonal",
    zones: [{ match: "app.api.**", zone: "inbound-adapter", reason: "routes" }],
    regions: [
      {
        name: "billing",
        match: "app.billing.**",
        in: "core",
        style: "layered",
        reason: "the billing module",
        zones: [
          { match: "app.billing.views.**", zone: "presentation", reason: "its front" },
          { match: "app.billing.rules.**", zone: "business", reason: "its rules" },
          { match: "app.billing.store.**", zone: "data", reason: "its tables" },
        ],
      },
    ],
  }),
);

function node(qualifiedName: string): GraphNode {
  return { id: qualifiedName, kind: ComponentKind.Class, label: qualifiedName.split(".").at(-1)!, qualifiedName, zone: "core", zoneSource: ZoneSource.Rule, zoneReason: "", smells: [], calls: 1, instances: 0, scenarioIds: [] };
}

function graphOf(calls: [string, string][]): SystemGraph {
  const names = [...new Set(calls.flat())];
  const edges: GraphEdge[] = calls.map(([from, to]) => ({ id: `${from}->${to}`, from, to, calls: 1, scenarioIds: [], violation: null }));
  return { nodes: names.map(node), edges, profile: HEXAGONAL };
}

describe("regionCalls", () => {
  test("calls into, out of and inside a region: which cross it, and which break its style", () => {
    const graph = graphOf([
      ["app.api.Invoices", "app.billing.views.InvoiceView"], // in through the front
      ["app.api.Payments", "app.billing.rules.Pricing"], // past the front, into the rules
      ["app.billing.views.InvoiceView", "app.billing.rules.Pricing"], // inside, as layered allows: nothing to say
      ["app.billing.store.Ledger", "app.billing.views.InvoiceView"], // inside, upwards: the region's own style forbids it
      ["app.billing.store.Ledger", "app.api.Hooks"], // out of the region
      ["app.api.Invoices", "app.api.Payments"], // outside: not a seam
    ]);

    const seams = regionCalls(graph, RULES).map((seam) => `${seam.edgeId}: ${[...seam.enters.map((r) => `enters ${r}`), ...seam.leaves.map((r) => `leaves ${r}`)].join(", ")}${seam.violation === null ? "" : ` ! ${seam.violation}`}`);

    expect(seams).toEqual([
      "app.api.Invoices->app.billing.views.InvoiceView: enters billing",
      "app.api.Payments->app.billing.rules.Pricing: enters billing ! reaches past the billing region's way in (presentation) into its business zone",
      "app.billing.store.Ledger->app.billing.views.InvoiceView:  ! in the billing region: a lower layer calling up into presentation",
      "app.billing.store.Ledger->app.api.Hooks: leaves billing",
    ]);
  });
});
