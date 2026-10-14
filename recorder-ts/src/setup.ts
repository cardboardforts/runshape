// vitest setupFiles: one scenario per test, written to the run directory global-setup made.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { beforeEach } from "vitest";

import { Recorder } from "./runtime";

const OUTCOMES: Record<string, string> = { pass: "passed", fail: "failed", skip: "skipped", todo: "skipped" };

const recorder = new Recorder();
(globalThis as { __runshape?: Recorder }).__runshape = recorder;

const runDirectory = process.env.RUNSHAPE_RUN_DIR;
const root = process.env.RUNSHAPE_TARGET;
if (!runDirectory || !root) throw new Error("runshape: RUNSHAPE_RUN_DIR and RUNSHAPE_TARGET are set by global-setup.ts");
const scenarios = join(runDirectory, "scenarios");
mkdirSync(scenarios, { recursive: true });

beforeEach((context) => {
  const task = context.task;
  const file = relative(root, task.file.filepath).split(sep).join("/");
  const path: string[] = [task.name];
  for (let suite = task.suite; suite !== undefined && suite.name !== "" && suite !== (task.file as unknown); suite = suite.suite) {
    path.unshift(suite.name);
  }
  recorder.startScenario(`${file}::${path.join(" > ")}`, file, path);
  context.onTestFinished(({ task: finished }) => {
    const scenario = recorder.finishScenario(OUTCOMES[finished.result?.state ?? ""] ?? "unknown");
    // hrtime orders scenarios by when they ran, across the test files vitest runs one by one.
    writeFileSync(join(scenarios, `${process.hrtime.bigint()}.json`), JSON.stringify(scenario));
  });
});
