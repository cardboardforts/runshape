/**
 * Where each piece of the project's code sits in the architecture, as of one commit: its own
 * runshape.json applied to its own recording. Saved with each recording, so a person can
 * read exactly what was placed where and why, and two commits' placements can be compared:
 * a zone change in a branch is a change like any other (docs/ideas.md; the user's decision of
 * 2026-10-16: architecture is committed with the code and approved with it).
 *
 * Only the project's own classes and modules are placed: framework, test and external code
 * sits where it is by what it is (ZoneSource.Fixed), not by anyone's decision.
 */
import { describe, expect, test } from "vitest";

import { ZoneRules } from "../src";
import { ArchitectureSnapshot, buildPlacements } from "../src";
import { byCodeUnit } from "@runshape/trace";
import { ZoneSource } from "@runshape/trace";
import { loadFixtureRun } from "../../trace/test/fixtures";

const GO_SHOP_RULES = JSON.stringify({
  version: 2,
  style: "hexagonal",
  zones: [
    { match: "example\\.com.shop.internal.orders.**", zone: "core", reason: "the order rules", by: "user" },
    { match: "example\\.com.shop.internal.storage.MemoryRepository", zone: "outbound-adapter", reason: "stores orders", by: "llm" },
  ],
});

function render(snapshot: ArchitectureSnapshot): string[] {
  return snapshot.placements.map((p) => `${p.component} [${p.kind}] ${p.zone}, ${p.rule ? `rule ${p.rule} by ${p.decidedBy}` : "inferred"}: ${p.reason}`);
}

describe("buildPlacements", () => {
  test("each project class and module, its zone, and whether a rule or the recorded behaviour put it there", async () => {
    const run = await loadFixtureRun("go-shop");

    const snapshot = buildPlacements(run, ZoneRules.parse(GO_SHOP_RULES));

    expect({ version: snapshot.version, style: snapshot.style, rules: snapshot.rules.length, unusedRules: snapshot.unusedRules, zones: snapshot.zones.map((z) => `${z.id}: ${z.name}`) }).toEqual({
      version: 1,
      style: "hexagonal",
      rules: 2,
      unusedRules: [],
      zones: ["inbound-adapter: Inbound adapters", "core: Core", "outbound-adapter: Outbound adapters"],
    });
    expect(render(snapshot)).toMatchInlineSnapshot(`
      [
        "example\\.com.shop.internal.app [module] core, inferred: receives no requests and calls no external system",
        "example\\.com.shop.internal.orders [module] core, rule example\\.com.shop.internal.orders.** by user: the order rules",
        "example\\.com.shop.internal.orders.Order [class] core, rule example\\.com.shop.internal.orders.** by user: the order rules",
        "example\\.com.shop.internal.orders.Service [class] core, rule example\\.com.shop.internal.orders.** by user: the order rules",
        "example\\.com.shop.internal.storage [module] core, inferred: receives no requests and calls no external system",
        "example\\.com.shop.internal.storage.MemoryRepository [class] outbound-adapter, rule example\\.com.shop.internal.storage.MemoryRepository by llm: stores orders",
        "example\\.com.shop.internal.web [module] core, inferred: receives no requests and calls no external system",
        "example\\.com.shop.internal.web.Handler [class] inbound-adapter, inferred: handles a route",
        "example\\.com.shop.internal.web.statusRecorder [class] core, inferred: receives no requests and calls no external system",
      ]
    `);
  });

  test("a rule that places nothing is listed: after a rename, it's the rule that needs looking at", async () => {
    const run = await loadFixtureRun("go-shop");
    const rules = ZoneRules.parse(JSON.stringify({ version: 2, style: "hexagonal", zones: [{ match: "example\\.com.shop.internal.billing.**", zone: "core", reason: "gone", by: "user" }] }));

    expect(buildPlacements(run, rules).unusedRules).toEqual(["example\\.com.shop.internal.billing.**"]);
  });

  test("the order is by code unit, the same on every machine, whatever its locale", () => {
    expect(["app.z", "app.\u00e5", "app.B", "app.ch", "app.d"].sort(byCodeUnit)).toEqual(["app.B", "app.ch", "app.d", "app.z", "app.\u00e5"]);
  });

  test("with no runshape.json, everything is inferred, in the default style", async () => {
    const run = await loadFixtureRun("go-shop");

    const snapshot = buildPlacements(run, ZoneRules.none());

    expect({ style: snapshot.style, sources: [...new Set(snapshot.placements.map((p) => p.source))] }).toEqual({ style: "hexagonal", sources: [ZoneSource.Inferred] });
  });

  test("placements don't depend on view options: setup and teardown code is placed too, one entry per class", async () => {
    // FastAPI's app factory and its startup events run only while the tests set up; they
    // still have a place in the architecture.
    const run = await loadFixtureRun("fastapi");

    const names = buildPlacements(run, ZoneRules.none()).placements.map((p) => p.component);

    expect(names).toEqual([...new Set(names)].sort(byCodeUnit));
    expect(["app.main", "app.core.events", "app.db.events"].filter((name) => names.includes(name))).toEqual(["app.main", "app.core.events", "app.db.events"]);
  });
});
