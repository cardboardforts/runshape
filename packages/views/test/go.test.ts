/**
 * A Go service, recorded by recorder-go (examples/go-shop, recorded into the go-shop fixture):
 * the viewer has no Go-specific code, so this is the trace format and the views working for a
 * language they weren't written against. Its e2e tests drive the real router in process, so a
 * request's whole path is in the recording.
 */
import { describe, expect, test } from "vitest";

import { Phase } from "@runshape/trace";
import { buildReplay, StepKind } from "../src";
import { buildSystemGraph } from "@runshape/architecture";
import { loadFixtureRun } from "../../trace/test/fixtures";

describe("a Go service", () => {
  test("its packages and types are the boxes, and the HTTP adapter calls the domain, which calls storage", async () => {
    const run = await loadFixtureRun("go-shop");
    const graph = buildSystemGraph(run, { grouping: { collapseMiddleware: true } });
    const label = new Map(graph.nodes.map((node) => [node.id, node.label]));

    expect(`${run.language} ${run.scenarios.length} tests, problems ${JSON.stringify(run.problems)}`).toBe("go 5 tests, problems []");
    expect(graph.edges.map((edge) => `${label.get(edge.from)} -> ${label.get(edge.to)}`).sort()).toEqual([
      "Client (tests) -> Handler",
      "Client (tests) -> Order",
      "Client (tests) -> internal.app",
      "Handler -> Order",
      "Handler -> Service",
      "Handler -> internal.web",
      "Service -> MemoryRepository",
      "Service -> Order",
      "internal.app -> internal.orders",
      "internal.app -> internal.storage",
      "internal.app -> internal.web",
      // writeJSON is a function of package web, not a Handler method: it sets the status.
      "internal.web -> statusRecorder",
    ]);
    // Go module paths hold dots: example.com is one segment, written escaped in Runshape's names.
    expect(graph.nodes.find((node) => node.label === "Service")?.qualifiedName).toBe("example\\.com.shop.internal.orders.Service");
    // The recorder read the routes from web.NewHandler's HandleFunc calls: their handlers' box
    // receives requests, as a FastAPI route's does.
    const handler = graph.nodes.find((node) => node.label === "Handler")!;
    expect(`${handler.zone}: ${handler.zoneReason}`).toBe("inbound-adapter: handles a route");
  });

  test("placing an order, replayed: the request, then the domain validating it and storage saving it", async () => {
    const run = await loadFixtureRun("go-shop");
    const scenario = run.scenarios.find((candidate) => candidate.name === "TestPlaceThenFetchAnOrder")!;

    const calls = buildReplay(scenario, [Phase.Call], { collapseMiddleware: true }).filter((step) => step.kind === StepKind.Call);

    expect(calls.map((step) => step.label).slice(0, 12)).toMatchInlineSnapshot(`
      [
        "New",
        "NewMemoryRepository",
        "NewService",
        "NewHandler",
        "POST /orders",
        "Service.Place",
        "Order.Problems",
        "MemoryRepository.Save",
        "writeJSON",
        "statusRecorder.WriteHeader",
        "GET /orders/ord-1",
        "Service.Get",
      ]
    `);
  });
});

describe("a Go program running", () => {
  // go-shop's real binary, recorded by `runshape-go run` while curl sent it a session: startup
  // is one scenario, each request another, rooted at its client (docs/ideas.md, idea 1).
  test("startup wires the app; each request is its own scenario", async () => {
    const run = await loadFixtureRun("go-shop-running");

    expect(run.scenarios.map((scenario) => `${scenario.name}: ${scenario.requests().map((span) => `${span.request?.method} ${span.request?.path}`).join(", ") || "-"}`)).toEqual([
      "startup: -",
      "GET /orders/warmup #1: GET /orders/warmup",
      "POST /orders #2: POST /orders",
      "GET /orders/ord-1 #3: GET /orders/ord-1",
      "POST /orders #4: POST /orders",
      "POST /orders #5: POST /orders",
      "GET /orders/ord-42 #6: GET /orders/ord-42",
    ]);
    const startup = buildReplay(run.scenarios[0]!, [Phase.Call], { collapseMiddleware: true });
    expect(startup.filter((step) => step.kind === StepKind.Call).map((step) => step.label)).toEqual(["main", "New", "NewMemoryRepository", "NewService", "NewHandler"]);
  });

  test("the refused order stops at the domain's rules: it never reaches storage", async () => {
    const run = await loadFixtureRun("go-shop-running");
    const calls = (name: string) =>
      buildReplay(run.scenarios.find((scenario) => scenario.name === name)!, [Phase.Call], { collapseMiddleware: true })
        .filter((step) => step.kind === StepKind.Call)
        .map((step) => step.label);

    expect({ placed: calls("POST /orders #2"), refused: calls("POST /orders #4"), malformed: calls("POST /orders #5") }).toEqual({
      placed: ["POST /orders", "Service.Place", "Order.Problems", "MemoryRepository.Save", "writeJSON", "statusRecorder.WriteHeader"],
      refused: ["POST /orders", "Service.Place", "Order.Problems", "writeJSON", "statusRecorder.WriteHeader"],
      malformed: ["POST /orders", "writeJSON", "statusRecorder.WriteHeader"],
    });
  });
});
