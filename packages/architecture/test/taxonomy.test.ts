/**
 * The categorizer's vocabulary is data (docs/categorizer.md). Runshape ships definitions for
 * roles (by lens) and traits, and rules that read them; a project overrides any of them by id
 * in runshape.json's "taxonomy" section, next to its zones, and the file is validated as one:
 * every problem in zones, regions and the taxonomy is reported at once, each with its path.
 */
import { describe, expect, test } from "vitest";

import { Taxonomy, TaxonomyError, ZoneRules, ZoneRulesError } from "../src";

/** A layered app whose services use CQRS, except the legacy region; DTOs belong at the edge. */
const PROJECT = {
  version: 3,
  style: "layered",
  zones: [{ match: "app.api.**", zone: "presentation", reason: "routes", by: "user" }],
  regions: [{ name: "legacy", match: "app.legacy.**", in: "business", style: "layered", reason: "old code, its own rules", by: "user", zones: [] }],
  taxonomy: {
    definitions: [{ id: "dto", expected_in: ["presentation"] }],
    roles: [{ match: "app.services.billing.Ledger", role: "aggregate-root", reason: "guards the balance", by: "user" }],
    rules: [
      // The example from docs/taxonomy.md: CQS mixing in a CQRS container, relaxed for handlers.
      { id: "cqrs-no-mixed-callable", match: "app.**", severity: "error", off_in: ["legacy"] },
      { id: "no-io-in-dtos", message: "a DTO doing I/O", when: ["role=dto"], flag: ["effect=reads-state|writes-state|external-io"], severity: "info" },
    ],
  },
};

describe("the taxonomy in runshape.json", () => {
  test("overrides apply by id, new rules join the built-in ones, and saving writes the section back as it was", () => {
    const rules = ZoneRules.parse(JSON.stringify(PROJECT));
    const { taxonomy } = rules;

    expect({
      dtoExpectedIn: taxonomy.definition("boundary", "dto")?.expected_in,
      dtoNamesKept: taxonomy.definition("boundary", "dto")?.names.slice(0, 3),
      declared: taxonomy.declaredFor(["app", "services", "billing", "Ledger"]).map((role) => `${role.role} (${role.by})`),
      rules: taxonomy.rules.map((rule) => `${rule.id}: ${rule.severity}${rule.match === null ? "" : ` in ${rule.match}`}${rule.off_in.length > 0 ? `, off in ${rule.off_in}` : ""}; styles ${rule.styles.length}`),
      cqrs: taxonomy.rules.find((rule) => rule.id === "cqrs-no-mixed-callable"),
    }).toEqual({
      dtoExpectedIn: ["presentation"],
      dtoNamesKept: ["*DTO", "*Dto", "*Schema"],
      declared: ["aggregate-root (user)"],
      rules: [
        "role-outside-expected-zone: warn; styles 5",
        "io-outside-allowed-zones: warn; styles 5",
        "cqrs-no-mixed-callable: error in app.**, off in legacy; styles 0",
        "no-io-in-dtos: info; styles 0",
      ],
      cqrs: {
        id: "cqrs-no-mixed-callable",
        message: "changes state and returns a value (CQS)",
        styles: [],
        match: "app.**",
        when: ["kind=callable"],
        flag: ["cqs=both"],
        unless: ["role=command-handler"],
        severity: "error",
        off_in: ["legacy"],
      },
    });
    // Adding a zone rule from the viewer rewrites the file: the taxonomy mustn't be lost.
    const saved = JSON.parse(rules.withRuleFor("app.db", "data", "persistence", "user").serialize());
    expect(saved.taxonomy).toEqual(PROJECT.taxonomy);
  });

  test("every problem at once, each with where it is: typos fail loudly instead of never matching", () => {
    const broken = {
      ...PROJECT,
      regions: [{ ...PROJECT.regions[0], taxonomy: {} }],
      zones: [{ match: "app.api.**", zone: "nowhere", reason: "routes" }],
      taxonomy: {
        definitions: [{ id: "dto", expected_in: ["edge-of-the-world"] }, { id: "saga", definition: "a long-running process" }, { id: "command", names: ["*Cmd"] }],
        roles: [{ match: "app.x", role: "aggregate", reason: "" }],
        rules: [
          { id: "cqrs-no-mixed-callable", severity: "fatal", off_in: ["legacy", "lagacy"], unless: ["role=comand-handler"] },
          { id: "mine", when: ["colour=red", "kind callable"] },
        ],
        lenses: [],
      },
    };

    let problems: string[] = [];
    try {
      ZoneRules.parse(JSON.stringify(broken));
    } catch (error) {
      problems = (error as ZoneRulesError).problems;
    }
    expect(problems).toEqual([
      "zones[0].zone must be one of presentation, business, data (the layered zones)",
      "regions[0].taxonomy: the taxonomy is declared once, at the top level",
      'taxonomy.lenses is not a part of the taxonomy: "definitions", "roles" or "rules"',
      "taxonomy.definitions[0].expected_in: edge-of-the-world is not a zone of any style (inbound-adapter, core, outbound-adapter, presentation, business, data, controller, model, view, viewmodel, presenter)",
      'taxonomy.definitions[1]: saga is not built in, so it needs a "lens"',
      'taxonomy.definitions[1]: saga is not built in, so it needs "on" (the kinds that carry it)',
      'taxonomy.definitions[2]: command is in lenses cqrs and cqs: say which with "lens"',
      "taxonomy.roles[0].reason must say why",
      "taxonomy.roles[0].role aggregate is not a role: define it in taxonomy.definitions first",
      "taxonomy.rules[0].severity must be one of error, warn, info, off",
      "taxonomy.rules[0].off_in: there is no region named lagacy",
      'taxonomy.rules[0].unless[0] "role=comand-handler": comand-handler is not role values (primary-port, secondary-port, primary-adapter, secondary-adapter, aggregate-root, entity, value-object, domain-service, factory, repository, domain-event, policy, command, command-handler, query-model, use-case, orchestrator, dto, mapper, config, controller, view, view-model, presenter, composition-root)',
      'taxonomy.rules[1]: mine is not built in, so it needs "flag" (the conditions that make a finding)',
      'taxonomy.rules[1]: mine is not built in, so it needs a "message"',
      'taxonomy.rules[1].when[0] "colour=red": colour is not an axis: kind, style, zone, role, zone-expected, zone-io, ports-and-adapters, tactical-ddd, cqrs, application, boundary, mvc-family, container, effect, io, cqs, failure, intent',
      'taxonomy.rules[1].when[1] "kind callable": write it "axis=value", "axis=a|b" or "axis!=value"',
    ]);
  });

  test("a file without a taxonomy gets the built-in one and saves without one", () => {
    const rules = ZoneRules.parse(JSON.stringify({ version: 2, style: "hexagonal", zones: [] }));

    expect({ rules: rules.taxonomy.rules.length, definitions: rules.taxonomy.definitions.length, saved: "taxonomy" in JSON.parse(rules.serialize()) }).toEqual({ rules: 3, definitions: 37, saved: false });
    expect(() => Taxonomy.parse({ rules: [{ id: "x" }] })).toThrow(TaxonomyError);
  });

  test("the blurb a model reads: each definition and what it's confused with, for the lenses asked", () => {
    expect(Taxonomy.builtIn().blurb(["ports-and-adapters"])).toMatchInlineSnapshot(`
      "ports-and-adapters:
      - primary-port: What the outside may ask of the core: a use-case interface. Not to be confused with: use-case: the implementation; the port is the interface it implements.
      - secondary-port: What the core needs from the outside: a store, a clock, a model. Not to be confused with: repository: the core's collection-like port is both.
      - primary-adapter: Turns an external request into a call on the core. Not to be confused with: secondary-adapter: that one is called by the core; this one calls the core.
      - secondary-adapter: Implements a secondary port against a real system (database, HTTP API, filesystem, queue, model provider). It knows the vendor's types and hides them from the core. Not to be confused with: repository: the interface is core, only the implementation is this; primary-adapter: this one is called by the core, it does not call the core."
    `);
  });
});
