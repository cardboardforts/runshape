/**
 * The recorder end to end: vitest runs a small project through vitest.record.config.ts, and the
 * scenario it writes says which calls were the test and which were its hooks. A test's own
 * beforeEach is setup and its afterEach teardown, as pytest's fixtures are, so the viewer's
 * "test body only" view leaves them out.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import type { ScenarioDto } from "../src/runtime";

const HERE = import.meta.dirname;
const REPO = join(HERE, "..", "..");

test("a test's beforeEach is recorded as setup and its afterEach as teardown", () => {
  const out = mkdtempSync(join(tmpdir(), "runshape-record-"));
  try {
    execFileSync(process.execPath, [join(REPO, "node_modules", "vitest", "vitest.mjs"), "run", "--config", join(REPO, "recorder-ts", "vitest.record.config.ts")], {
      cwd: REPO,
      env: { ...process.env, RUNSHAPE_TARGET: join(HERE, "sample-project"), RUNSHAPE_INCLUDE: "src", RUNSHAPE_TESTS: "test/**/*.test.ts", RUNSHAPE_OUT: out, RUNSHAPE_RUN: "run" },
      stdio: "pipe",
    });
    const scenarios = join(out, "run", "scenarios");
    const scenario = JSON.parse(readFileSync(join(scenarios, readdirSync(scenarios)[0]!), "utf8")) as ScenarioDto;

    const timeline: string[] = [];
    for (const event of scenario.events) {
      if (event[0] === "P") timeline.push(`phase ${event[2]}`);
      if (event[0] === "S") {
        const { container, name } = scenario.functions[event[3]]!.symbol;
        timeline.push(`  ${[...container, name].join(".")}`);
      }
    }
    expect(timeline).toEqual([
      "phase setup",
      "  greets by name",
      "  Greeter.open",
      "phase call",
      "  Greeter.greet",
      "phase teardown",
      "  Greeter.close",
    ]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
