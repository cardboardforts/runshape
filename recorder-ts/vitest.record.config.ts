// Records a TypeScript project's vitest run in the runshape trace format (version 2).
//   RUNSHAPE_TARGET  the project root (default: this repository)
//   RUNSHAPE_INCLUDE comma-separated source directories to record (default: packages/core/src)
//   RUNSHAPE_TESTS   comma-separated test globs (default: packages/core/test/**/*.test.ts)
//   RUNSHAPE_OUT     the traces directory (default: <target>/.runshape/traces)
//   RUNSHAPE_RUN     the run's directory name (default: the time)
// npm run self-review sets these to record a base commit and the working tree.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { runshapeInstrument } from "./src/plugin";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.env.RUNSHAPE_TARGET ?? join(here, ".."));
const include = (process.env.RUNSHAPE_INCLUDE ?? "packages/core/src").split(",");
process.env.RUNSHAPE_TARGET = target;
process.env.RUNSHAPE_INCLUDE = include.join(",");
process.env.RUNSHAPE_OUT ??= join(target, ".runshape", "traces");

export default defineConfig({
  root: target,
  plugins: [runshapeInstrument(target, include)],
  test: {
    include: (process.env.RUNSHAPE_TESTS ?? "packages/core/test/**/*.test.ts").split(","),
    setupFiles: [join(here, "src/setup.ts")],
    globalSetup: [join(here, "src/global-setup.ts")],
    // One test file at a time, so scenario files are written in the order the tests ran.
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
