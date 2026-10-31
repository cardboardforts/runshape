/**
 * The model's view on the app's architecture: given the styles, the heuristic's ranking with
 * its evidence, and the package list, it picks a style and maps packages to its zones. Its
 * answer is validated as strictly as runshape.json: a wrong zone for the style is refused.
 */
import { describe, expect, test } from "vitest";

import { architecturePrompt, detectArchitecture, parseArchitectureAdvice, projectPackages } from "@runshape/architecture";

import { Phase } from "@runshape/kernel";
import { ViewerSession, ZoneRuleStore } from "../src/session";
import { loadFixtureRun } from "../../kernel/test/fixtures";

describe("architecture advice", () => {
  test("the model sees every style, the ranked evidence, and the packages", async () => {
    const run = await loadFixtureRun("fastapi");

    const prompt = architecturePrompt(detectArchitecture(run), projectPackages(run), run.language);

    expect(prompt.split("\n")[0]).toBe("You are deciding which architecture style a Python application follows, so a viewer can draw it.");
    expect(architecturePrompt([], [], "typescript").split("\n")[0]).toContain("a TypeScript application");
    // The middle of the prompt, where the evidence is; the frame is checked by the answer test.
    const lines = prompt.split("\n");
    const evidence = lines.findIndex((line) => line.startsWith("A heuristic ranked them"));
    expect(lines.slice(evidence, evidence + 9)).toMatchInlineSnapshot(`
      [
        "A heuristic ranked them from package names and from what the recorded tests did at runtime:",
        "- layered scored 0.96:",
        "    - Presentation: app.api, app.api.dependencies, app.api.routes",
        "    - Business: app.models.domain, app.services",
        "    - Data access: app.db, app.db.queries, app.db.repositories, app.models",
        "    - persistence sits behind repositories/gateways: ArticlesRepository, ProfilesRepository, TagsRepository and 1 more",
        "    - request handlers call persistence directly (4 call paths): a relaxed layering",
        "- hexagonal scored 0.77:",
        "    - Inbound adapters: app.api, app.api.routes",
      ]
    `);
    expect(prompt).toContain("- mvc (Model–View–Controller (incl. Django's MVT)): zones controller = receives the request, picks the model and the view;");
    expect(prompt).toContain("  app.db.repositories.users");
  });

  test("an answer in prose and fences is accepted; every problem in a bad one is reported", () => {
    const good = parseArchitectureAdvice(`Here you go:
\`\`\`json
{"style": "layered", "reason": "Routes call services, services call repositories.", "confidence": "high",
 "zones": [{"match": "app.models.domain.**", "zone": "business"}, {"match": "app.api.**", "zone": "presentation"}]}
\`\`\``);

    expect(good.rules.profile.style).toBe("layered");
    expect(good.rules.rules.map((rule) => `${rule.match} → ${rule.zone} (${rule.by})`)).toEqual(["app.models.domain.** → business (llm)", "app.api.** → presentation (llm)"]);
    expect(good.confidence).toBe("high");
    expect(() => parseArchitectureAdvice(`{"style": "layered", "zones": [{"match": "app.**", "zone": "core"}, {"zone": "data"}]}`)).toThrowError(
      `the model's answer was unusable: no reason given; zones[0].zone "core" isn't a layered zone; zones[1] has no match`,
    );
    expect(() => parseArchitectureAdvice(`{"style": "microservices", "reason": "r", "zones": []}`)).toThrowError(/unknown style "microservices"/);
  });
});

describe("asking, then adopting the model's proposal", () => {
  test("the session keeps the proposal; adopting writes it, and nothing the view could send instead", async () => {
    const run = await loadFixtureRun("fastapi");
    const answer = `{"style": "layered", "reason": "Routes, then services, then repositories.", "confidence": "medium",
      "zones": [{"match": "app.models.domain.**", "zone": "business"}, {"match": "app.db.**", "zone": "data"}, {"match": "app.api.**", "zone": "presentation"}]}`;
    const advisor = { available: true, complete: async () => answer };
    let saved: string | null = null;
    const store: ZoneRuleStore = { save: async (rules) => ((saved = rules.serialize()), true) };
    const session = new ViewerSession(run, { sources: { readLines: async () => null }, advisor, ruleStore: store });

    const tooEarly = await session.handle({ type: "adoptArchitecture", style: "layered", from: "model" });
    const advice = await session.handle({ type: "adviseArchitecture" });
    const wrongStyle = await session.handle({ type: "adoptArchitecture", style: "mvc", from: "model" });
    const adopted = await session.handle({ type: "adoptArchitecture", style: "layered", from: "model" });
    const graph = await session.handle({ type: "graph", phases: [Phase.Call], grouping: { collapseMiddleware: true } });

    expect(tooEarly).toEqual({ type: "error", message: "There is no model proposal for that style to adopt; ask the model again." });
    expect(advice).toEqual({
      type: "architectureAdvice",
      style: "layered",
      reason: "Routes, then services, then repositories.",
      confidence: "medium",
      rules: [
        { match: "app.models.domain.**", zone: "business" },
        { match: "app.db.**", zone: "data" },
        { match: "app.api.**", zone: "presentation" },
      ],
    });
    expect(wrongStyle?.type).toBe("error");
    expect(adopted).toEqual({ type: "rulesChanged", count: 3, style: "layered", modules: ["app.api", "app.core", "app.db", "app.main", "app.models", "app.services"] });
    expect(JSON.parse(saved!).zones.map((rule: { by: string }) => rule.by)).toEqual(["llm", "llm", "llm"]);
    const repository = graph?.type === "graph" ? graph.graph.nodes.find((n) => n.label === "UsersRepository") : undefined;
    expect(`${repository?.zone} (${repository?.zoneSource})`).toBe("data (rule)");
  });
});
