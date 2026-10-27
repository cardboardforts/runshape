/**
 * The CLI's logs: logfmt, one event per line, so a night's run can be grepped by its id
 * (`grep run=3f2a .runshape/logs/runshape.log`) or shipped to anything that reads logfmt.
 */
import { describe, expect, test } from "vitest";

import { LogfmtLogger } from "../src";

const NOW = new Date("2026-10-26T03:00:00Z");

describe("LogfmtLogger", () => {
  test("time, level, the context fields, the event, then its fields; context carries down through with()", () => {
    const lines: string[] = [];
    const run = new LogfmtLogger((line) => lines.push(line), () => NOW).with({ service: "runshape", run: "3f2a" });

    run.log("info", "command.start", { command: "review-requests" });
    run.with({ pr: 7 }).log("info", "pr.reviewed", { duration_ms: 812, explained: false, problem: null });

    expect(lines).toEqual([
      "ts=2026-10-26T03:00:00.000Z level=info service=runshape run=3f2a event=command.start command=review-requests",
      "ts=2026-10-26T03:00:00.000Z level=info service=runshape run=3f2a pr=7 event=pr.reviewed duration_ms=812 explained=false problem=",
    ]);
  });

  test("a value with spaces, quotes or newlines is quoted and escaped: a stack stays on its line", () => {
    const lines: string[] = [];
    const logger = new LogfmtLogger((line) => lines.push(line), () => NOW);

    logger.log("error", "pr.failed", { error: 'fetch "refs/pull/8/head" failed', stack: "Error: x\n    at f (a.ts:1)\r\nevent=forged", empty: "" });

    expect(lines).toEqual([
      'ts=2026-10-26T03:00:00.000Z level=error event=pr.failed error="fetch \\"refs/pull/8/head\\" failed" stack="Error: x\\n    at f (a.ts:1)\\r\\nevent=forged" empty=""',
    ]);
  });
});
