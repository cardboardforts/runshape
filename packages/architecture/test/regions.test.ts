/**
 * Nested regions (runshape.json version 3, PLAN.md Phase 2): a region is an area of the code
 * with one style. A zone is a slot inside that style. A region sits inside one of its parent's
 * zones ("in"), has its own rules in its own style, and may hold regions of its own: Runshape
 * itself is hexagonal at the top, and its trace module could be layered inside the core.
 *
 * A region is a subtree of names ("packages.trace.**"), so "inside" can be checked when the
 * file loads: a parent rule that would put part of a region in another zone of the parent is
 * an error, because a region sits in one zone, whole.
 */
import { describe, expect, test } from "vitest";

import { QualifiedName } from "@runshape/kernel";
import { ZoneRules } from "../src";

const named = (dotted: string) => QualifiedName.parse(dotted);

const RUNSHAPE = {
  version: 3,
  style: "hexagonal",
  zones: [
    { match: "packages.cli.**", zone: "inbound-adapter", reason: "the command line" },
    { match: "packages.infra.**", zone: "outbound-adapter", reason: "the Node toolkit" },
  ],
  regions: [
    {
      name: "trace",
      match: "packages.trace.**",
      in: "core",
      style: "layered",
      reason: "the trace module: diffs on top of the run model",
      zones: [
        { match: "packages.trace.src.review", zone: "presentation", reason: "what a reviewer reads" },
        { match: "packages.trace.src.**", zone: "business", reason: "the diffs" },
      ],
      regions: [
        {
          name: "moves",
          match: "packages.trace.src.moves.**",
          in: "business",
          style: "hexagonal",
          reason: "pairing moved code",
          zones: [{ match: "packages.trace.src.moves.**", zone: "core", reason: "pure pairing" }],
        },
      ],
    },
  ],
};

/** Where a name lands: each region it's in, outermost first, and the zone it has in each. */
function placed(rules: ZoneRules, dotted: string): string {
  return rules
    .placementsOf(named(dotted))
    .map(({ region, style, zone }) => `${region}(${style}):${zone ?? "-"}`)
    .join(" > ");
}

describe("nested regions", () => {
  test("a name is placed in every region it's in, outermost first; the top level sees the region's zone", () => {
    const rules = ZoneRules.parse(JSON.stringify(RUNSHAPE));

    expect({
      cli: placed(rules, "packages.cli.src.main"),
      review: placed(rules, "packages.trace.src.review"),
      diff: placed(rules, "packages.trace.src.run-diff"),
      moves: placed(rules, "packages.trace.src.moves.detect"),
      // In the region, and no rule of its own there: placed in the region, zone left to inference.
      test: placed(rules, "packages.trace.test.helpers"),
      // The top-level match for a name in a region is the region itself, sitting in its parent's zone.
      topLevel: rules.matchFor(named("packages.trace.src.review"))?.rule,
    }).toEqual({
      cli: "(hexagonal):inbound-adapter",
      review: "(hexagonal):core > trace(layered):presentation",
      diff: "(hexagonal):core > trace(layered):business",
      moves: "(hexagonal):core > trace(layered):business > moves(hexagonal):core",
      test: "(hexagonal):core > trace(layered):-",
      topLevel: { match: "packages.trace.**", zone: "core", reason: "the trace region (layered): the trace module: diffs on top of the run model", by: "user" },
    });
  });

  test("saved back as version 3 with its regions; a file without regions stays version 2", () => {
    const rules = ZoneRules.parse(JSON.stringify(RUNSHAPE));
    const flat = ZoneRules.parse(JSON.stringify({ version: 2, style: "hexagonal", zones: RUNSHAPE.zones }));

    const saved = JSON.parse(rules.serialize());

    expect(saved.version).toBe(3);
    expect(placed(ZoneRules.parse(rules.serialize()), "packages.trace.src.moves.detect")).toBe(placed(rules, "packages.trace.src.moves.detect"));
    expect(saved.regions[0].regions[0]).toEqual({ ...RUNSHAPE.regions[0]!.regions![0], by: "user", zones: [{ ...RUNSHAPE.regions[0]!.regions![0]!.zones[0], by: "user" }] });
    expect(JSON.parse(flat.serialize()).version).toBe(2);
  });

  test("every mistake in a region is reported, with where it is", () => {
    const broken = {
      version: 3,
      style: "hexagonal",
      zones: [
        // Would put part of the trace region in another zone: a region sits in one zone, whole.
        { match: "packages.trace.src.views.**", zone: "inbound-adapter", reason: "views" },
      ],
      regions: [
        {
          name: "trace",
          match: "packages.trace.**",
          in: "presentation",
          style: "layered",
          reason: "r",
          zones: [{ match: "packages.trace.**", zone: "core", reason: "r" }],
          regions: [{ name: "elsewhere", match: "packages.kernel.**", in: "business", style: "layered", reason: "r", zones: [] }],
        },
        { name: "", match: "packages.*.src", in: "core", style: "microservices", reason: "" },
        { name: "overlap", match: "packages.trace.src.**", in: "core", style: "layered", reason: "r", zones: [] },
      ],
    };

    expect(() => ZoneRules.parse(JSON.stringify(broken))).toThrowErrorMatchingInlineSnapshot(`
      [Error: runshape.json is invalid:
        - regions[0].in must be one of inbound-adapter, core, outbound-adapter (the hexagonal zone it sits in)
        - regions[0].zones[0].zone must be one of presentation, business, data (the layered zones)
        - regions[0].regions[0].match packages.kernel.** is outside the trace region (packages.trace.**)
        - regions[1].name must be a non-empty string
        - regions[1].match must be a name, or a name and everything under it ("a.b.**")
        - regions[1].reason must say why
        - regions[1].style "microservices" is not one of hexagonal, layered, mvc, mvvm, mvp
        - regions[2] (overlap) overlaps regions[0] (trace): a name is in one region at each level
        - zones[0] (packages.trace.src.views.**) is inside the trace region: a region sits in one zone, whole; set it in the region's zones]
    `);
  });

  test("a zone set on a name inside a region goes into that region's rules, in its style", () => {
    const rules = ZoneRules.parse(JSON.stringify(RUNSHAPE));

    const moved = rules.withRuleFor("packages.trace.src.routes", "presentation", "what a reviewer reads", "user");

    expect(placed(moved, "packages.trace.src.routes")).toBe("(hexagonal):core > trace(layered):presentation");
    expect(moved.regions[0]!.rules.rules[0]).toEqual({ match: "packages.trace.src.routes", zone: "presentation", reason: "what a reviewer reads", by: "user" });
    // The region's own style decides: a hexagonal zone inside the layered region is refused.
    expect(() => rules.withRuleFor("packages.trace.src.routes", "core", "r", "user")).toThrowError(/packages.trace.src.routes is in the trace region \(layered\): its zone is one of presentation, business, data/);
  });
});

describe("regions and the rules around them", () => {
  test("a region wins over a broader rule listed before it; a rule that can't reach an exact region's one name is refused; names are unique (second-model review)", () => {
    const broad = ZoneRules.parse(JSON.stringify({ ...RUNSHAPE, zones: [{ match: "**", zone: "outbound-adapter", reason: "everything else" }, ...RUNSHAPE.zones] }));
    const exact = { version: 3, style: "hexagonal", zones: [], regions: [{ name: "one", match: "a.b", in: "core", style: "layered", reason: "r", zones: [{ match: "a.b.c", zone: "business", reason: "r" }] }] };
    const twins = { version: 3, style: "hexagonal", zones: [], regions: ["a.**", "b.**"].map((match) => ({ name: "twin", match, in: "core", style: "layered", reason: "r" })) };

    expect(placed(broad, "packages.trace.src.review")).toBe("(hexagonal):core > trace(layered):presentation");
    expect(() => ZoneRules.parse(JSON.stringify(exact))).toThrowError(/regions\[0\]\.zones\[0\]\.match a\.b\.c is outside the one region \(a\.b\)/);
    expect(() => ZoneRules.parse(JSON.stringify(twins))).toThrowError(/regions\[1\]\.name twin is used by another region here/);
  });
});
