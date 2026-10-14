// Records a TypeScript project's vitest run in the runshape trace format (version 2).
//   RUNSHAPE_TARGET  the project root (default: this repository)
//   RUNSHAPE_INCLUDE comma-separated source directories to record (default: the src of core and
//                    of the packages it is built from, as far as the target has them)
//   RUNSHAPE_TESTS   comma-separated test globs (default: the tests of core and the packages it
//                    is built from, wherever a revision keeps them)
//   RUNSHAPE_OUT     the traces directory (default: <target>/.runshape/traces)
//   RUNSHAPE_RUN     the run's directory name (default: the time)
// npm run self-review sets these to record a base commit and the working tree.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { runshapeInstrument } from "./src/plugin";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.env.RUNSHAPE_TARGET ?? join(here, ".."));
const CORE_PACKAGES = ["core", "trace", "architecture", "views"];
const include = (process.env.RUNSHAPE_INCLUDE ?? CORE_PACKAGES.map((name) => `packages/${name}/src`).filter((dir) => existsSync(join(target, dir))).join(",")).split(",");
// @runshape/* resolves to the target's own packages: through node_modules, a base worktree
// would get the working tree's.
const packagesDirectory = join(target, "packages");
const alias = existsSync(packagesDirectory)
  ? Object.fromEntries(
      readdirSync(packagesDirectory)
        .filter((name) => existsSync(join(packagesDirectory, name, "src", "index.ts")))
        .map((name) => [`@runshape/${name}`, join(packagesDirectory, name, "src", "index.ts")]),
    )
  : {};
process.env.RUNSHAPE_TARGET = target;
process.env.RUNSHAPE_INCLUDE = include.join(",");
process.env.RUNSHAPE_OUT ??= join(target, ".runshape", "traces");

export default defineConfig({
  root: target,
  resolve: { alias },
  plugins: [runshapeInstrument(target, include)],
  test: {
    include: (process.env.RUNSHAPE_TESTS ?? CORE_PACKAGES.map((name) => `packages/${name}/test/**/*.test.ts`).join(",")).split(","),
    // Wraps each test's function, so its hooks are told apart from its body (src/runner.ts).
    runner: join(here, "src/runner.ts"),
    setupFiles: [join(here, "src/setup.ts")],
    globalSetup: [join(here, "src/global-setup.ts")],
    // One test file at a time, so scenario files are written in the order the tests ran.
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
