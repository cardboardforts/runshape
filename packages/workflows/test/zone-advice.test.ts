/**
 * "Suggest zone": the model proposes, a person accepts, only then does runshape.json change.
 * The advisor and the rule store are ports; these fakes stand in for VS Code's language
 * model API and the file write (with its confirmation dialog).
 */
import { describe, expect, test } from "vitest";

import { buildSystemGraph, HEXAGONAL, HexagonalZone, parseZoneAdvice, zoneAdvicePrompt, ZoneAdvisor, zoneFacts, ZoneRules } from "@runshape/architecture";

import { Phase, pythonSymbol } from "@runshape/kernel";
import { RuleChange, ViewerSession, ZoneRuleStore } from "../src/session";
import { buildComponentView } from "@runshape/visualizer";
import { loadFixtureRun } from "../../kernel/test/fixtures";

const USERS_REPOSITORY = "class:app.db.repositories.users.UsersRepository";
const GROUPING = { collapseMiddleware: true };

class ScriptedAdvisor implements ZoneAdvisor {
  readonly available = true;
  readonly prompts: string[] = [];
  constructor(private readonly answer: string) {}
  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.answer;
  }
}

class RecordingStore implements ZoneRuleStore {
  readonly asked: string[] = [];
  saved: ZoneRules | null = null;
  constructor(private readonly accept: boolean) {}
  async save(rules: ZoneRules, change: RuleChange): Promise<boolean> {
    this.asked.push(`${change.question} [${change.confirm}]\n${change.detail}`);
    if (this.accept) this.saved = rules;
    return this.accept;
  }
}

describe("zone facts and the model's answer", () => {
  test("the model is given the recorded evidence about the component", async () => {
    const run = await loadFixtureRun("fastapi");
    const graph = buildSystemGraph(run, { grouping: GROUPING });
    const node = graph.nodes.find((n) => n.id === USERS_REPOSITORY)!;

    expect(zoneFacts(graph, node, buildComponentView(run, USERS_REPOSITORY, GROUPING))).toMatchInlineSnapshot(`
      {
        "calledBy": [
          "app.db.repositories.profiles.ProfilesRepository (outbound-adapter)",
          "Client (tests) (edge)",
          "app.api.dependencies.authentication (inbound-adapter)",
          "app.api.dependencies.database (inbound-adapter)",
          "app.api.routes.authentication (inbound-adapter)",
          "app.services.authentication (core)",
        ],
        "calls": [
          "app.models.common.DateTimeModelMixin (core)",
          "app.models.domain.users.UserInDB (core)",
        ],
        "currentReason": "calls postgres directly",
        "currentZone": "outbound-adapter",
        "externalSystems": [
          "postgres",
        ],
        "functions": [
          "get_user_by_email",
          "get_user_by_username",
          "create_user",
          "update_user",
          "__init__ (from BaseRepository)",
          "connection (from BaseRepository)",
        ],
        "qualifiedName": "app.db.repositories.users.UsersRepository",
      }
    `);
  });

  test("the prompt names the recording's language and shows the source fenced in it", async () => {
    const run = await loadFixtureRun("fastapi");
    const graph = buildSystemGraph(run, { grouping: GROUPING });
    const facts = zoneFacts(graph, graph.nodes.find((n) => n.id === USERS_REPOSITORY)!, buildComponentView(run, USERS_REPOSITORY, GROUPING));

    const python = zoneAdvicePrompt(facts, ["class UsersRepository(BaseRepository):"], HEXAGONAL, run.language);
    const typescript = zoneAdvicePrompt(facts, ["export class ZoneRules {"], HEXAGONAL, "typescript");

    expect([python, typescript].map((prompt) => prompt.split("\n")[0])).toEqual([
      "You are reviewing a Python application against this architecture: Hexagonal (ports and adapters).",
      "You are reviewing a TypeScript application against this architecture: Hexagonal (ports and adapters).",
    ]);
    expect(typescript).toContain("```typescript\nexport class ZoneRules {\n```");
  });

  test("answers are accepted inside prose or code fences, and rejected when unusable", () => {
    expect(parseZoneAdvice('Sure!\n```json\n{"zone": "outbound-adapter", "reason": "Wraps SQL for users."}\n```', HEXAGONAL)).toEqual({
      zone: "outbound-adapter",
      reason: "Wraps SQL for users.",
      confidence: "low", // missing confidence is treated as low, never as high
    });
    expect(() => parseZoneAdvice('{"zone": "domain", "reason": ""}', HEXAGONAL)).toThrowErrorMatchingInlineSnapshot(`[Error: the model's answer was unusable: unknown zone "domain"; no reason given]`);
    expect(() => parseZoneAdvice("I think it's an adapter.", HEXAGONAL)).toThrowErrorMatchingInlineSnapshot(`[Error: the model did not answer with a JSON object]`);
  });
});

describe("the source the model is shown", () => {
  test("starts at the class statement, even when its bases span several lines", async () => {
    const run = await loadFixtureRun("fastapi");
    const advisor = new ScriptedAdvisor('{"zone": "outbound-adapter", "reason": "r"}');
    const lines = ["from x import y", "", "class UsersRepository(", "    BaseRepository,", "):", '    """Users."""', ""];
    // Pad so the first method sits where the recording says it does.
    const firstMethod = run.catalogFunction(pythonSymbol("app.db.repositories.users", "UsersRepository.get_user_by_email").key)!.firstLine;
    while (lines.length < firstMethod - 1) lines.push("");
    const sources = { readLines: async () => [...lines, ...Array(200).fill("    pass")] };

    await new ViewerSession(run, { sources, advisor }).handle({ type: "adviseZone", componentId: USERS_REPOSITORY, grouping: GROUPING });

    expect(advisor.prompts[0]).toContain("class UsersRepository(\n    BaseRepository,\n):");
  });
});

describe("suggest, then accept", () => {
  test("nothing changes until the proposal is accepted; then the graph shows who decided", async () => {
    const run = await loadFixtureRun("fastapi");
    const advisor = new ScriptedAdvisor('{"zone": "outbound-adapter", "reason": "Repository over the users table.", "confidence": "high"}');
    const declining = new RecordingStore(false);
    const accepting = new RecordingStore(true);
    const sources = { readLines: async () => null };

    const proposal = await new ViewerSession(run, { sources, advisor }).handle({ type: "adviseZone", componentId: USERS_REPOSITORY, grouping: GROUPING });
    const declined = await new ViewerSession(run, { sources, ruleStore: declining }).handle({
      type: "setZone", qualifiedName: "app.db.repositories.users.UsersRepository", zone: HexagonalZone.OutboundAdapter, reason: "Repository over the users table.", by: "llm",
    });
    const session = new ViewerSession(run, { sources, ruleStore: accepting });
    const accepted = await session.handle({
      type: "setZone", qualifiedName: "app.db.repositories.users.UsersRepository", zone: HexagonalZone.OutboundAdapter, reason: "Repository over the users table.", by: "llm",
    });
    const graph = await session.handle({ type: "graph", phases: [Phase.Call], grouping: GROUPING });

    expect(proposal).toEqual({
      type: "zoneAdvice",
      componentId: USERS_REPOSITORY,
      advice: { zone: "outbound-adapter", reason: "Repository over the users table.", confidence: "high" },
    });
    expect(declined).toBeNull();
    expect(declining.asked).toMatchInlineSnapshot(`
      [
        "Add this rule to runshape.json? [Add rule]
      {
        "match": "app.db.repositories.users.UsersRepository",
        "zone": "outbound-adapter",
        "reason": "Repository over the users table.",
        "by": "llm"
      }

      It goes first in runshape.json; the other 0 rule(s) are kept.",
      ]
    `);
    expect(accepted).toEqual({ type: "rulesChanged", count: 1, style: "hexagonal" });
    expect(accepting.saved?.serialize()).toMatchInlineSnapshot(`
      "{
        "version": 2,
        "style": "hexagonal",
        "zones": [
          {
            "match": "app.db.repositories.users.UsersRepository",
            "zone": "outbound-adapter",
            "reason": "Repository over the users table.",
            "by": "llm"
          }
        ]
      }
      "
    `);
    const node = graph?.type === "graph" ? graph.graph.nodes.find((n) => n.id === USERS_REPOSITORY) : undefined;
    expect(`${node?.zone} [${node?.zoneSource}] ${node?.zoneReason}`).toMatchInlineSnapshot(`"outbound-adapter [rule] proposed by a model, accepted in runshape.json (app.db.repositories.users.UsersRepository): Repository over the users table."`);
  });

  test("without a language model the viewer says so instead of failing", async () => {
    const run = await loadFixtureRun("fastapi");

    const response = await new ViewerSession(run, { sources: { readLines: async () => null } }).handle({
      type: "adviseZone", componentId: USERS_REPOSITORY, grouping: GROUPING,
    });

    expect(response).toMatchObject({ type: "zoneAdviceFailed", message: expect.stringContaining("No language model") });
  });
});

describe("saving rules safely", () => {
  test("while runshape.json can't be read, saving is refused instead of overwriting the file", async () => {
    const run = await loadFixtureRun("fastapi");
    const store = new RecordingStore(true);
    const session = new ViewerSession(run, { sources: { readLines: async () => null }, ruleStore: store, rulesProblem: "zones[3].zone must be one of …" });

    const response = await session.handle({ type: "setZone", qualifiedName: "app.x.Y", zone: HexagonalZone.Core, reason: "r", by: "user" });

    expect(response).toMatchObject({ type: "error", message: expect.stringContaining("Fix runshape.json before adding rules") });
    expect(store.asked).toEqual([]);
  });

  test("a malformed request from the view never reaches the confirmation", async () => {
    const run = await loadFixtureRun("fastapi");
    const store = new RecordingStore(true);
    const session = new ViewerSession(run, { sources: { readLines: async () => null }, ruleStore: store });

    const response = await session.handle({ type: "setZone", qualifiedName: "", zone: "domain", reason: " ", by: "robot" as "user" });

    expect(response).toEqual({ type: "error", message: 'Can\'t save that rule: no component name; unknown zone "domain" for the hexagonal style; no reason; unknown decider "robot"' });
    expect(store.asked).toEqual([]);
  });

  test("a failed model request ends the 'asking' state with a message", async () => {
    const run = await loadFixtureRun("fastapi");
    const failing: ZoneAdvisor = { available: true, complete: async () => Promise.reject(new Error("access denied by the user")) };

    const response = await new ViewerSession(run, { sources: { readLines: async () => null }, advisor: failing }).handle({
      type: "adviseZone", componentId: USERS_REPOSITORY, grouping: GROUPING,
    });

    expect(response).toEqual({ type: "zoneAdviceFailed", componentId: USERS_REPOSITORY, message: "The model request failed: access denied by the user" });
  });
});
