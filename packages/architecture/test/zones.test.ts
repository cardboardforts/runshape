/**
 * Declared zones: the rules a project checks in as runshape.json, read, matched and written. How
 * they place boxes on the system graph is in packages/views/test/zones-on-graph.test.ts.
 */
import { describe, expect, test } from "vitest";

import { QualifiedName } from "@runshape/core";
import { HexagonalZone, ZoneRules, ZoneRulesError } from "../src";

/** Names written the way runshape.json writes them. */
const named = (dotted: string) => QualifiedName.parse(dotted);

describe("ZoneRules", () => {
  test("a runshape.json with mistakes reports every one of them", () => {
    const text = JSON.stringify({
      version: 2,
      zones: [
        { match: "app.domain.**", zone: "core", reason: "entities and services" },
        { match: "", zone: "domain", reason: "" },
        { match: "app.db.*", zone: "outbound-adapter", reason: "repositories", by: "robot" },
      ],
    });

    expect(() => ZoneRules.parse(text)).toThrowError(ZoneRulesError);
    expect(() => ZoneRules.parse(text)).toThrowErrorMatchingInlineSnapshot(`
      [Error: runshape.json is invalid:
        - zones[1].match must be a non-empty string
        - zones[1].zone must be one of inbound-adapter, core, outbound-adapter (the hexagonal zones)
        - zones[1].reason must say why
        - zones[2].by must be "user", "llm" or "detected"]
    `);
  });

  test("a version 1 file (\"rings\") still reads, and is saved back as version 2", () => {
    const v1 = JSON.stringify({ version: 1, rings: [{ match: "app.db.**", ring: "outbound-adapter", reason: "persistence" }] });

    const rules = ZoneRules.parse(v1);

    expect(rules.rules).toEqual([{ match: "app.db.**", zone: "outbound-adapter", reason: "persistence", by: "user" }]);
    expect(JSON.parse(rules.serialize())).toEqual({ version: 2, style: "hexagonal", zones: rules.rules });
    // A broken version 1 file is reported like a broken version 2 one: every problem, no crash.
    expect(() => ZoneRules.parse(JSON.stringify({ version: 1, rings: [null] }))).toThrowError(ZoneRulesError);
  });

  test("the file's style picks the zones its rules may use; an unknown style is reported", () => {
    const layered = ZoneRules.parse(JSON.stringify({ version: 2, style: "layered", zones: [{ match: "app.db.**", zone: "data", reason: "repositories" }] }));
    const wrongZone = JSON.stringify({ version: 2, style: "layered", zones: [{ match: "app.db.**", zone: "outbound-adapter", reason: "r" }] });
    const unknown = JSON.stringify({ version: 2, style: "microservices", zones: [] });

    expect(layered.profile.style).toBe("layered");
    expect(layered.rules[0]?.zone).toBe("data");
    expect(() => ZoneRules.parse(wrongZone)).toThrowError(/zone must be one of presentation, business, data \(the layered zones\)/);
    expect(() => ZoneRules.parse(unknown)).toThrowError(/"style" "microservices" is not one of hexagonal, layered, mvc, mvvm, mvp/);
  });

  test("first match wins; `*` stays within one dotted segment, `**` spans any number", () => {
    const rules = new ZoneRules([
      { match: "app.db.repositories.base.*", zone: HexagonalZone.Core, reason: "shared base", by: "user" },
      { match: "app.db.**", zone: HexagonalZone.OutboundAdapter, reason: "persistence", by: "user" },
      { match: "app.*", zone: HexagonalZone.InboundAdapter, reason: "top-level modules", by: "user" },
    ]);

    expect(
      ["app.db.repositories.base.BaseRepository", "app.db.repositories.users.UsersRepository", "app.main", "app.services.jwt"].map(
        (name) => `${name} -> ${rules.matchFor(named(name))?.rule.reason ?? "no rule"}`,
      ),
    ).toEqual([
      "app.db.repositories.base.BaseRepository -> shared base",
      "app.db.repositories.users.UsersRepository -> persistence",
      "app.main -> top-level modules",
      "app.services.jwt -> no rule",
    ]);
    // `**` also stands for no segments, so a package's own module matches its subtree rule.
    const subtree = new ZoneRules([{ match: "app.db.**", zone: HexagonalZone.OutboundAdapter, reason: "persistence", by: "user" }]);
    expect(["app.db", "app.db.users", "app.dbx"].map((name) => subtree.matchFor(named(name)) !== null)).toEqual([true, true, false]);
    const middle = new ZoneRules([{ match: "a.**.b", zone: HexagonalZone.Core, reason: "r", by: "user" }]);
    expect(["a.b", "a.x.b", "a.x.y.b", "ab"].map((name) => middle.matchFor(named(name)) !== null)).toEqual([true, true, true, false]);
    const leading = new ZoneRules([{ match: "**.models", zone: HexagonalZone.Core, reason: "r", by: "user" }]);
    expect(["models", "app.models", "app.x.models", "app.modelsx"].map((name) => leading.matchFor(named(name)) !== null)).toEqual([true, true, true, false]);
  });

  test("a dot inside a segment is written \\. so Go's example.com stays one segment", () => {
    const goPackage = new QualifiedName(["example.com", "shop", "orders"]);
    const lookalike = new QualifiedName(["example", "com", "shop", "orders"]);
    const odd = new QualifiedName(["a\\b", "c.d"]);

    expect([goPackage.text, lookalike.text, odd.text]).toEqual(["example\\.com.shop.orders", "example.com.shop.orders", "a\\\\b.c\\.d"]);
    expect([goPackage, lookalike, odd].every((name) => QualifiedName.parse(name.text).equals(name))).toBe(true);

    const rules = new ZoneRules([{ match: "example\\.com.shop.**", zone: HexagonalZone.Core, reason: "the shop module", by: "user" }]);
    expect([rules.matchFor(goPackage) !== null, rules.matchFor(lookalike) !== null]).toEqual([true, false]);
    // "Set zone" writes the node's name as an exact rule: it has to match that node again.
    const placed = ZoneRules.none().withRuleFor(goPackage.text, HexagonalZone.InboundAdapter, "by hand", "user");
    expect(placed.matchFor(goPackage)?.rule.reason).toBe("by hand");
  });

  test("a hostile glob in a cloned repo's runshape.json can't hang the viewer", () => {
    // As a regular expression, eight ".**" in a row took 3.4 s against this name (and each
    // more one about 6x longer): catastrophic backtracking, run once per graph node.
    const hostile = new ZoneRules([{ match: `a${".**".repeat(30)}.zzz`, zone: HexagonalZone.Core, reason: "r", by: "user" }]);
    const wildcards = new ZoneRules([{ match: `a.${"*a".repeat(30)}b`, zone: HexagonalZone.Core, reason: "r", by: "user" }]);
    const name = `a${".b".repeat(200)}`;

    const started = performance.now();
    const matched = [hostile.matchFor(named(name)), wildcards.matchFor(named(`a.${"a".repeat(200)}`)), hostile.matchFor(named(`${name}.zzz`))];
    const elapsedMs = performance.now() - started;

    expect(matched.map((match) => match !== null)).toEqual([false, false, true]);
    expect(elapsedMs).toBeLessThan(100);
  });

  test("setting the zone of one component adds the most specific rule first and round-trips", () => {
    const rules = ZoneRules.none()
      .withRuleFor("app.**", HexagonalZone.Core, "default", "user")
      .withRuleFor("app.db.users.UsersRepository", HexagonalZone.OutboundAdapter, "talks to postgres", "llm");

    expect(ZoneRules.parse(rules.serialize()).rules).toEqual([
      { match: "app.db.users.UsersRepository", zone: "outbound-adapter", reason: "talks to postgres", by: "llm" },
      { match: "app.**", zone: "core", reason: "default", by: "user" },
    ]);
  });
});

