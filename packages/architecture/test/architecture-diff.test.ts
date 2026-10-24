/**
 * How a change moved the architecture: the base drawn with the base's runshape.json, head with
 * head's, and their placements compared. Zones are committed with the code and approved with
 * it (the user's decision of 2026-10-16), so this is what a reviewer approves alongside the
 * code.
 *
 * Decisions and observations are kept apart. A rule added, removed or changed, and anything it
 * moved, is a decision someone made (a person, or a model whose proposal is in the branch).
 * An inferred zone that moved only because the tests behave differently (a test now mocks the
 * database, a class now handles a route) is an observation: worth seeing, not something anyone
 * decided. New code no rule covers is listed apart: it's what still needs a decision.
 */
import { describe, expect, test } from "vitest";


import { QualifiedName, ZoneSource } from "@runshape/core";
import { detectMoves, diffRuns, Moves } from "@runshape/trace";
import { ArchitectureDiff, ArchitectureSnapshot, buildPlacements, comparedGraphs, diffArchitecture, Placement, ZoneRules } from "../src";
import { fixtureRuns, loadFixtureRun } from "../../core/test/fixtures";

const rules = (zones: { match: string; zone: string; reason: string; by: string }[]) => ZoneRules.parse(JSON.stringify({ version: 2, style: "hexagonal", zones }));
const ORDERS = { match: "example\\.com.shop.internal.orders.**", zone: "core", reason: "the order rules", by: "user" };
const STORAGE = { match: "example\\.com.shop.internal.storage.**", zone: "outbound-adapter", reason: "stores orders", by: "llm" };

function render(diff: ArchitectureDiff): string[] {
  const placed = (p: { zone: string; decidedBy: string | null } | null) => (p === null ? "-" : `${p.zone} (${p.decidedBy ?? "inferred"})`);
  return [
    `style ${diff.styleBefore} -> ${diff.styleAfter}`,
    ...diff.rules.added.map((r) => `rule added: ${r.match} -> ${r.zone} by ${r.by}`),
    ...diff.rules.removed.map((r) => `rule removed: ${r.match} -> ${r.zone} by ${r.by}`),
    ...diff.rules.changed.map((r) => `rule changed: ${r.before.match}: ${r.before.zone} by ${r.before.by} -> ${r.after.zone} by ${r.after.by}`),
    ...diff.decided.map((c) => `decided: ${c.component}: ${placed(c.before)} -> ${placed(c.after)}`),
    ...diff.observed.map((c) => `observed: ${c.component}: ${placed(c.before)} -> ${placed(c.after)}`),
    ...diff.unplaced.map((p) => `needs a decision: ${p.component} (inferred ${p.zone}: ${p.reason})`),
    ...diff.removed.map((p) => `gone: ${p.component}`),
    ...diff.unusedRules.map((r) => `rule places nothing: ${r}`),
  ];
}

describe("diffArchitecture", () => {
  test("a rule added in the branch: the decision, and every class it moved", async () => {
    const run = await loadFixtureRun("go-shop");

    const diff = diffArchitecture(buildPlacements(run, rules([ORDERS])), buildPlacements(run, rules([ORDERS, STORAGE])));

    expect(render(diff)).toEqual([
      "style hexagonal -> hexagonal",
      "rule added: example\\.com.shop.internal.storage.** -> outbound-adapter by llm",
      "decided: example\\.com.shop.internal.storage: core (inferred) -> outbound-adapter (llm)",
      "decided: example\\.com.shop.internal.storage.MemoryRepository: core (inferred) -> outbound-adapter (llm)",
    ]);
  });

  test("a rule removed, and one whose zone changed hands from a person to a model", async () => {
    const run = await loadFixtureRun("go-shop");
    const reassigned = { ...ORDERS, zone: "inbound-adapter", reason: "a model thinks so", by: "llm" };

    const diff = diffArchitecture(buildPlacements(run, rules([ORDERS, STORAGE])), buildPlacements(run, rules([reassigned])));

    expect(render(diff)).toEqual([
      "style hexagonal -> hexagonal",
      "rule removed: example\\.com.shop.internal.storage.** -> outbound-adapter by llm",
      "rule changed: example\\.com.shop.internal.orders.**: core by user -> inbound-adapter by llm",
      "decided: example\\.com.shop.internal.orders: core (user) -> inbound-adapter (llm)",
      "decided: example\\.com.shop.internal.orders.Order: core (user) -> inbound-adapter (llm)",
      "decided: example\\.com.shop.internal.orders.Service: core (user) -> inbound-adapter (llm)",
      "decided: example\\.com.shop.internal.storage: outbound-adapter (llm) -> core (inferred)",
      "decided: example\\.com.shop.internal.storage.MemoryRepository: outbound-adapter (llm) -> core (inferred)",
    ]);
  });

  test("the same rules, the code changed: code no rule covers that the base's tests never reached needs a decision", async () => {
    // The routing fix: the feed view existed in the base, but a misrouted URL meant no test reached
    // it. Placements cover what the tests ran, so to the architecture it's new.
    const runs = fixtureRuns("django-feed-fix");
    const base = (await runs.previous())!;
    const head = await runs.latest();

    const diff = diffArchitecture(buildPlacements(base, ZoneRules.none()), buildPlacements(head, ZoneRules.none()), detectMoves(base, head));

    expect(render(diff)).toMatchInlineSnapshot(`
      [
        "style hexagonal -> hexagonal",
        "needs a decision: conduit.apps.articles.views.ArticlesFeedAPIView (inferred inbound-adapter: handles a route)",
      ]
    `);
  });

  test("a rule that places nothing in head is listed", async () => {
    const run = await loadFixtureRun("go-shop");
    const stale = { ...STORAGE, match: "example\\.com.shop.internal.billing.**" };

    expect(diffArchitecture(buildPlacements(run, rules([ORDERS])), buildPlacements(run, rules([ORDERS, stale]))).unusedRules).toEqual(["example\\.com.shop.internal.billing.**"]);
  });
});

describe("what the example recordings don't show, written out", () => {
  const placement = (component: string, zone: string, reason: string, kind: "class" | "module" = "class"): Placement => ({
    component,
    kind: kind as Placement["kind"],
    zone,
    source: ZoneSource.Inferred,
    rule: null,
    decidedBy: null,
    reason,
  });
  const snapshot = (placements: Placement[]): ArchitectureSnapshot => ({ version: 1, style: "hexagonal", declaredStyle: "hexagonal", zones: [], rules: [], unusedRules: [], placements });

  test("an inferred zone that moved with the tests' behaviour is observed, not decided", () => {
    const before = snapshot([placement("app.Exporter", "core", "receives no requests and calls no external system")]);
    const after = snapshot([placement("app.Exporter", "outbound-adapter", "calls s3 directly")]);

    expect(render(diffArchitecture(before, after))).toEqual(["style hexagonal -> hexagonal", "observed: app.Exporter: core (inferred) -> outbound-adapter (inferred)"]);
  });

  test("a rule rewritten without moving anything is still a decision, and new code a rule places is decided, not waiting", () => {
    // Who stands behind a placement, and why, is what a reviewer approves: a person's rule
    // handed to a model, or given a new reason, is a change even where every zone stays put.
    const ruled = (component: string, zone: string, by: "user" | "llm", reason: string): Placement => ({
      ...placement(component, zone, reason),
      source: ZoneSource.Rule,
      rule: "app.**",
      decidedBy: by,
    });
    const rule = (by: "user" | "llm", reason: string) => ({ match: "app.**", zone: "core", reason, by });
    const reworded = (reason: string) => ({ match: "lib.**", zone: "core", reason, by: "user" as const });
    const before = { ...snapshot([ruled("app.Orders", "core", "user", "the rules")]), rules: [rule("user", "the rules"), reworded("shared code")] };
    const after = {
      ...snapshot([ruled("app.Invoices", "core", "llm", "domain code, a model says"), ruled("app.Orders", "core", "llm", "domain code, a model says")]),
      rules: [rule("llm", "domain code, a model says"), reworded("shared code, no I/O")],
    };

    expect(render(diffArchitecture(before, after))).toEqual([
      "style hexagonal -> hexagonal",
      "rule changed: app.**: core by user -> core by llm",
      "rule changed: lib.**: core by user -> core by user",
      "decided: app.Invoices: - -> core (llm)",
      "decided: app.Orders: core (user) -> core (llm)",
    ]);
  });

  test("a class that moved is the same class: its place travels with it, and nothing is new or gone", () => {
    const before = snapshot([placement("app.old.Exporter", "core", "no I/O")]);
    const after = snapshot([placement("app.exports.Exporter", "core", "no I/O")]);
    const moves = new Moves([], [], [{ from: QualifiedName.parse("app.old.Exporter"), to: QualifiedName.parse("app.exports.Exporter") }]);

    expect({ moved: render(diffArchitecture(before, after, moves)), unmatched: render(diffArchitecture(before, after)) }).toEqual({
      moved: ["style hexagonal -> hexagonal"],
      unmatched: ["style hexagonal -> hexagonal", "needs a decision: app.exports.Exporter (inferred core: no I/O)", "gone: app.old.Exporter"],
    });
  });
});

describe("cases the first version got wrong (second-model review)", () => {
  test("a style changed in the branch: both commits placed in the new style, so nothing moved that wasn't moved", async () => {
    const run = await loadFixtureRun("go-shop");
    const mvc = ZoneRules.parse(JSON.stringify({ version: 2, style: "mvc", zones: [] }));
    const hexagonal = ZoneRules.none();

    const diff = diffArchitecture(buildPlacements(run, mvc, hexagonal.profile), buildPlacements(run, hexagonal));

    expect(render(diff)).toEqual(["style mvc -> hexagonal"]);
  });

  test("two base classes merged into one: the one that keeps the name is compared, the other is listed gone", () => {
    const ruledTarget: Placement = { component: "app.Target", kind: "class" as Placement["kind"], zone: "core", source: ZoneSource.Rule, rule: "app.Target", decidedBy: "user", reason: "the rules" };
    const zeta: Placement = { component: "app.Zeta", kind: "class" as Placement["kind"], zone: "outbound-adapter", source: ZoneSource.Inferred, rule: null, decidedBy: null, reason: "calls s3" };
    const after: Placement = { ...zeta, component: "app.Target", zone: "inbound-adapter", reason: "handles a route" };
    const moves = new Moves([], [], [{ from: QualifiedName.parse("app.Zeta"), to: QualifiedName.parse("app.Target") }]);
    const snap = (placements: Placement[]): ArchitectureSnapshot => ({ version: 1, style: "hexagonal", declaredStyle: "hexagonal", zones: [], rules: [], unusedRules: [], placements });

    expect(render(diffArchitecture(snap([ruledTarget, zeta]), snap([after]), moves))).toEqual([
      "style hexagonal -> hexagonal",
      "decided: app.Target: core (user) -> inbound-adapter (inferred)",
      "gone: app.Zeta",
    ]);
  });
});

describe("diffRuns with each side's own rules", () => {
  test("a box whose zone a rule changed is changed, even though it was called the same", async () => {
    const run = await loadFixtureRun("go-shop");

    // As a workflow wires them: the arch module draws both sides, the trace module diffs them.
    const diff = diffRuns(run, run, comparedGraphs(run, run, { baseRules: rules([ORDERS]), rules: rules([ORDERS, STORAGE]) }));

    expect(diff.nodes.filter((node) => node.change !== "unchanged").map((node) => `${node.label}: ${node.change}, ${node.zoneBefore} -> ${node.zone}`)).toEqual([
      "MemoryRepository: changed, core -> outbound-adapter",
      "internal.storage: changed, core -> outbound-adapter",
    ]);
  });
});
