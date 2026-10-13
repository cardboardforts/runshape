/**
 * "Suggest ring": the model proposes, a person accepts, only then does hexvis.json change.
 * The advisor and the rule store are ports; these fakes stand in for VS Code's language
 * model API and the file write (with its confirmation dialog).
 */
import { describe, expect, test } from "vitest";

import { Phase } from "../src/model";
import { parseRingAdvice, RingAdvisor, ringFacts } from "../src/ring-advice";
import { DeclaredRing, RingRules } from "../src/rings";
import { RingRuleStore, ViewerSession } from "../src/session";
import { buildComponentView } from "../src/views/component-view";
import { buildSystemGraph } from "../src/views/system-graph";
import { loadFixtureRun } from "./fixtures";

const USERS_REPOSITORY = "class:app.db.repositories.users.UsersRepository";
const GROUPING = { collapseMiddleware: true };

class ScriptedAdvisor implements RingAdvisor {
  readonly available = true;
  readonly prompts: string[] = [];
  constructor(private readonly answer: string) {}
  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.answer;
  }
}

class RecordingStore implements RingRuleStore {
  readonly asked: string[] = [];
  saved: RingRules | null = null;
  constructor(private readonly accept: boolean) {}
  async save(rules: RingRules, change: string): Promise<boolean> {
    this.asked.push(change);
    if (this.accept) this.saved = rules;
    return this.accept;
  }
}

describe("ring facts and the model's answer", () => {
  test("the model is given the recorded evidence about the component", async () => {
    const run = await loadFixtureRun("fastapi");
    const graph = buildSystemGraph(run, { grouping: GROUPING });
    const node = graph.nodes.find((n) => n.id === USERS_REPOSITORY)!;

    expect(ringFacts(graph, node, buildComponentView(run, USERS_REPOSITORY, GROUPING))).toMatchInlineSnapshot(`
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
        "currentRing": "outbound-adapter",
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

  test("answers are accepted inside prose or code fences, and rejected when unusable", () => {
    expect(parseRingAdvice('Sure!\n```json\n{"ring": "outbound-adapter", "reason": "Wraps SQL for users."}\n```')).toEqual({
      ring: "outbound-adapter",
      reason: "Wraps SQL for users.",
      confidence: "low", // missing confidence is treated as low, never as high
    });
    expect(() => parseRingAdvice('{"ring": "domain", "reason": ""}')).toThrowErrorMatchingInlineSnapshot(`[Error: the model's answer was unusable: unknown ring "domain"; no reason given]`);
    expect(() => parseRingAdvice("I think it's an adapter.")).toThrowErrorMatchingInlineSnapshot(`[Error: the model did not answer with a JSON object]`);
  });
});

describe("suggest, then accept", () => {
  test("nothing changes until the proposal is accepted; then the graph shows who decided", async () => {
    const run = await loadFixtureRun("fastapi");
    const advisor = new ScriptedAdvisor('{"ring": "outbound-adapter", "reason": "Repository over the users table.", "confidence": "high"}');
    const declining = new RecordingStore(false);
    const accepting = new RecordingStore(true);
    const sources = { readLines: async () => null };

    const proposal = await new ViewerSession(run, { sources, advisor }).handle({ type: "adviseRing", componentId: USERS_REPOSITORY, grouping: GROUPING });
    const declined = await new ViewerSession(run, { sources, ruleStore: declining }).handle({
      type: "setRing", qualifiedName: "app.db.repositories.users.UsersRepository", ring: DeclaredRing.OutboundAdapter, reason: "Repository over the users table.", by: "llm",
    });
    const session = new ViewerSession(run, { sources, ruleStore: accepting });
    const accepted = await session.handle({
      type: "setRing", qualifiedName: "app.db.repositories.users.UsersRepository", ring: DeclaredRing.OutboundAdapter, reason: "Repository over the users table.", by: "llm",
    });
    const graph = await session.handle({ type: "graph", phases: [Phase.Call], grouping: GROUPING });

    expect(proposal).toEqual({
      type: "ringAdvice",
      componentId: USERS_REPOSITORY,
      advice: { ring: "outbound-adapter", reason: "Repository over the users table.", confidence: "high" },
    });
    expect(declined).toBeNull();
    expect(declining.asked).toEqual(["app.db.repositories.users.UsersRepository → outbound-adapter: Repository over the users table."]);
    expect(accepted).toEqual({ type: "rulesChanged", count: 1 });
    expect(accepting.saved?.serialize()).toMatchInlineSnapshot(`
      "{
        "version": 1,
        "rings": [
          {
            "match": "app.db.repositories.users.UsersRepository",
            "ring": "outbound-adapter",
            "reason": "Repository over the users table.",
            "by": "llm"
          }
        ]
      }
      "
    `);
    const node = graph?.type === "graph" ? graph.graph.nodes.find((n) => n.id === USERS_REPOSITORY) : undefined;
    expect(`${node?.ring} [${node?.ringSource}] ${node?.ringReason}`).toMatchInlineSnapshot(`"outbound-adapter [rule] proposed by a model, accepted in hexvis.json (app.db.repositories.users.UsersRepository): Repository over the users table."`);
  });

  test("without a language model the viewer says so instead of failing", async () => {
    const run = await loadFixtureRun("fastapi");

    const response = await new ViewerSession(run, { sources: { readLines: async () => null } }).handle({
      type: "adviseRing", componentId: USERS_REPOSITORY, grouping: GROUPING,
    });

    expect(response).toMatchObject({ type: "ringAdviceFailed", message: expect.stringContaining("No language model") });
  });
});
