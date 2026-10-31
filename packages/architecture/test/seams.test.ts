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

  test("regions inside a region: siblings judged by the parent's style, a call entering two at once checked at each, unplaced names left alone (second-model review)", () => {
    const nested = ZoneRules.parse(
      JSON.stringify({
        version: 3,
        style: "hexagonal",
        zones: [{ match: "app.api.**", zone: "inbound-adapter", reason: "routes" }],
        regions: [
          {
            name: "shop",
            match: "app.shop.**",
            in: "core",
            style: "layered",
            reason: "the shop",
            regions: [
              { name: "front", match: "app.shop.front.**", in: "presentation", style: "hexagonal", reason: "its pages", zones: [{ match: "app.shop.front.http.**", zone: "inbound-adapter", reason: "r" }] },
              { name: "stock", match: "app.shop.stock.**", in: "data", style: "layered", reason: "its tables", zones: [{ match: "app.shop.stock.tables.**", zone: "data", reason: "r" }] },
            ],
          },
        ],
      }),
    );
    const graph = graphOf([
      ["app.api.Orders", "app.shop.front.http.Page"], // in through both ways in
      ["app.api.Orders", "app.shop.stock.tables.Items"], // past the shop's front, and past stock's
      ["app.shop.stock.tables.Items", "app.shop.front.http.Page"], // sibling to sibling, data up to presentation
      ["app.shop.front.http.Page", "app.api.Hooks"], // out of both
      ["app.api.Orders", "app.shop.unplaced.Thing"], // in the shop, no rule there: no claim to judge
    ]);

    const calls = regionCalls(graph, nested).map((call) => `${call.edgeId}: enters [${call.enters}] leaves [${call.leaves}]${call.violation === null ? "" : ` ! ${call.violation}`}`);

    expect(calls).toEqual([
      "app.api.Orders->app.shop.front.http.Page: enters [shop,front] leaves []",
      "app.api.Orders->app.shop.stock.tables.Items: enters [shop,stock] leaves [] ! reaches past the shop region's way in (presentation) into its data zone; reaches past the stock region's way in (presentation) into its data zone",
      "app.shop.stock.tables.Items->app.shop.front.http.Page: enters [front] leaves [stock] ! in the shop region: a lower layer calling up into presentation",
      "app.shop.front.http.Page->app.api.Hooks: enters [] leaves [front,shop]",
      "app.api.Orders->app.shop.unplaced.Thing: enters [shop] leaves []",
    ]);
  });
});
