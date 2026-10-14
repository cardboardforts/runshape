// vitest's runner, running each test's own function itself so the scenario knows where the body
// starts and ends: hooks before it (beforeEach) are setup, hooks after it (afterEach) teardown.
// vitest calls runTask exactly between the two (and TestRunner.setTestFn, which could wrap the
// function instead, is getFn in vitest 5: setting through it does nothing).
import { TestRunner, type RunnerTestCase } from "vitest";

import type { Recorder } from "./runtime";

const getTestFn = TestRunner.getTestFn as unknown as (test: RunnerTestCase) => (() => unknown) | undefined;

export default class RecordingRunner extends TestRunner {
  async runTask(test: RunnerTestCase): Promise<void> {
    const body = getTestFn(test);
    if (body === undefined) throw new Error(`runshape: no function for test ${test.name}`);
    const recorder = (globalThis as { __runshape?: Recorder }).__runshape;
    recorder?.phase("call");
    try {
      await body();
    } finally {
      recorder?.phase("teardown");
    }
  }
}
