/**
 * The model step is optional (docs/categorizer.md). It's asked only about the leftovers, types
 * the detector gave no role, with the project's own definitions as its vocabulary. Its answer
 * becomes "judged" claims and, written to runshape.json, a proposal ("by": "llm") a person
 * approves in the diff. Nothing here calls a model: the prompt and the parsing are pure.
 */
import { describe, expect, test } from "vitest";

import { categorize, leftovers, parseRoleAdvice, roleAdvicePrompt, RoleAdviceError, ZoneRules } from "../src";
import { fixtureRuns } from "../../kernel/test/fixtures";

const RULES = {
  version: 2,
  style: "hexagonal",
  zones: [
    { match: "example\\.com.shop.internal.web.**", zone: "inbound-adapter", reason: "HTTP handlers", by: "user" },
    { match: "example\\.com.shop.internal.storage.**", zone: "outbound-adapter", reason: "stores orders", by: "user" },
    { match: "example\\.com.shop.internal.**", zone: "core", reason: "the shop's rules", by: "user" },
  ],
};

describe("role advice", () => {
  test("go-shop's leftovers are the core's two types; a model's answer is a proposal that reads back as judged", async () => {
    const run = await fixtureRuns("go-shop").latest();
    const rules = ZoneRules.parse(JSON.stringify(RULES));
    const remaining = leftovers(categorize(run, rules));
    const service = remaining.find((item) => item.name.endsWith("orders.Service"))!;
    const source = run.sources?.get("internal/orders/service.go") ?? null;

    const prompt = roleAdvicePrompt(service, rules.taxonomy, run.language, source);
    const advice = parseRoleAdvice(
      'Here you go: {"roles": [{"lens": "application", "role": "use-case", "reason": "Place runs one request end to end.", "confidence": "high"}]}',
      service,
      rules.taxonomy,
    );
    // The host writes the proposal to runshape.json; the next categorization reads it back.
    const proposed = ZoneRules.parse(rules.withRoles(advice.declarations).serialize());
    const after = categorize(run, proposed).items.find((item) => item.name === service.name)!;

    expect({
      leftovers: remaining.map((item) => item.name),
      promptAsks: prompt.split("\n").filter((line) => /^(Type|Zone|application:|- use-case|\{"roles")/.test(line)),
      claims: advice.claims,
      saved: JSON.parse(proposed.serialize()).taxonomy,
      afterwards: after.tags,
    }).toMatchInlineSnapshot(`
      {
        "afterwards": [
          {
            "by": "judged",
            "confidence": 0.8,
            "evidence": [
              "runshape.json (llm): proposed by a model: Place runs one request end to end.",
            ],
            "id": "use-case",
            "lens": "application",
          },
        ],
        "claims": [
          {
            "by": "judged",
            "confidence": 0.75,
            "evidence": [
              "a model: Place runs one request end to end.",
            ],
            "id": "use-case",
            "lens": "application",
          },
        ],
        "leftovers": [
          "example\\.com.shop.internal.orders.Order",
          "example\\.com.shop.internal.orders.Service",
        ],
        "promptAsks": [
          "application:",
          "- use-case: An application service: runs one request end to end through the domain and the ports. Not to be confused with: domain-service: decides; a use case sequences; orchestrator: sequences calls without deciding anything.",
          "Type: example\\.com.shop.internal.orders.Service",
          "Zone: core",
          "{"roles": [{"lens": "ports-and-adapters" | "tactical-ddd" | "cqrs" | "application" | "boundary", "role": "<a role id from that lens>", "reason": "<one sentence>", "confidence": "low" | "medium" | "high"}]}",
        ],
        "saved": {
          "roles": [
            {
              "by": "llm",
              "lens": "application",
              "match": "example\\.com.shop.internal.orders.Service",
              "reason": "proposed by a model: Place runs one request end to end.",
              "role": "use-case",
            },
          ],
        },
      }
    `);
  });

  test("an unusable answer is refused with every problem at once", async () => {
    const run = await fixtureRuns("go-shop").latest();
    const rules = ZoneRules.parse(JSON.stringify(RULES));
    const service = leftovers(categorize(run, rules)).find((item) => item.name.endsWith("orders.Service"))!;
    const answer = JSON.stringify({ roles: [{ lens: "mvc-family", role: "controller", reason: "x" }, { lens: "tactical-ddd", role: "aggregate", reason: "" }, { lens: "application", role: "use-case", reason: "y" }, { lens: "application", role: "orchestrator", reason: "z" }] });

    expect(() => parseRoleAdvice(answer, service, rules.taxonomy)).toThrow(RoleAdviceError);
    expect(() => parseRoleAdvice(answer, service, rules.taxonomy)).toThrowErrorMatchingInlineSnapshot(`[Error: the model's answer was unusable: roles[0].lens "mvc-family" isn't one the hexagonal style uses (ports-and-adapters, tactical-ddd, cqrs, application, boundary); roles[1].role "aggregate" isn't a tactical-ddd role; roles[1].reason is missing; roles[3]: a second role in application; one per lens]`);
    expect(() => parseRoleAdvice("I think it's a service.", service, rules.taxonomy)).toThrowErrorMatchingInlineSnapshot(`[Error: the model did not answer with a JSON object]`);
  });
});
