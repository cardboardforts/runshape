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

  test("other control characters are escaped too: a tab, a terminal escape in a PR's title, a NUL, a line separator (second-model review)", () => {
    const lines: string[] = [];
    new LogfmtLogger((line) => lines.push(line), () => NOW).log("info", "pr.reviewed", { title: "a\tb", red: "\x1b[31mred", nul: "x\u0000y", ls: "p\u2028q", ok: "é" });

    expect(lines).toEqual(['ts=2026-10-26T03:00:00.000Z level=info event=pr.reviewed title="a\\tb" red="\\u001b[31mred" nul="x\\u0000y" ls="p\\u2028q" ok=é']);
  });

  test("credentials never reach the log: a URL's user and password, keys shaped like Anthropic's or GitHub's (second-model review)", () => {
    const lines: string[] = [];
    new LogfmtLogger((line) => lines.push(line), () => NOW).log("error", "pr.failed", {
      error: "git fetch https://me:ghp_abcdefghijklmnopqrstuvwxyz@github.com/x/y.git: denied",
      key: "sk-ant-api03-abcdefghijklmnop",
      token: "github_pat_11ABCDEFG0123456789",
    });

    expect(lines).toEqual([
      'ts=2026-10-26T03:00:00.000Z level=error event=pr.failed error="git fetch https://[redacted]@github.com/x/y.git: denied" key=sk-ant-[redacted] token=github_pat_[redacted]',
    ]);
  });

  test("a field can't overwrite the run's id or the event, and a key can't forge another field", () => {
    const lines: string[] = [];
    new LogfmtLogger((line) => lines.push(line), () => NOW).with({ run: "r1" }).log("info", "pr.reviewed", { run: "forged", event: "x", "a b=c": 1 });

    expect(lines).toEqual(["ts=2026-10-26T03:00:00.000Z level=info run=r1 event=pr.reviewed field.run=forged field.event=x a_b_c=1"]);
  });

  test("a write that fails is said once, and logging stops; the work it describes goes on", () => {
    const failures: string[] = [];
    const logger = new LogfmtLogger(() => { throw new Error("ENOSPC: no space left on device"); }, () => NOW, {}, (error) => failures.push(String(error))).with({ run: "r1" });

    logger.log("info", "command.start");
    logger.with({ pr: 7 }).log("error", "pr.failed", { error: "the real failure" });

    expect(failures).toEqual(["Error: ENOSPC: no space left on device"]);
  });
});
