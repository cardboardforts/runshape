// Records a TypeScript project's vitest run in the runshape trace format (version 2).
//   RUNSHAPE_TARGET  the project root (default: this repository)
//   RUNSHAPE_INCLUDE comma-separated source directories to record (default: the src of each
//                    Node package, RECORDED_PACKAGES, as far as the target has them)
//   RUNSHAPE_TESTS   comma-separated test globs (default: those packages' tests, wherever a
//                    revision keeps them)
//   RUNSHAPE_OUT     the traces directory (default: <target>/.runshape/traces)
//   RUNSHAPE_RUN     the run's directory name (default: the time)
//   RUNSHAPE_CACHE   where Vite and vitest keep their caches (default: the target's node_modules);
//                    the sandbox mounts the target read-only and points this at /tmp
// npm run self-review sets these to record a base commit and the working tree.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { runshapeInstrument } from "./src/plugin";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.env.RUNSHAPE_TARGET ?? join(here, ".."));
// Every package that runs in Node, so a change to the CLI or the recordings library shows in
// Runshape's own reviews too; the webview and the extension need a browser and VS Code.
const RECORDED_PACKAGES = ["core", "trace", "infra", "architecture", "views", "library", "adapters", "cli"];
const include = (process.env.RUNSHAPE_INCLUDE ?? RECORDED_PACKAGES.map((name) => `packages/${name}/src`).filter((dir) => existsSync(join(target, dir))).join(",")).split(",");
// @runshape/* resolves to the target's own packages: through node_modules, a base worktree
// would get the working tree's.
const packagesDirectory = join(target, "packages");
// A package's name is its entry file; a path under it (a test helper another package's tests
// share) is that file in the package.
const alias = existsSync(packagesDirectory)
  ? [
      ...readdirSync(packagesDirectory)
        .filter((name) => existsSync(join(packagesDirectory, name, "src", "index.ts")))
        .map((name) => ({ find: new RegExp(`^@runshape/${name}$`), replacement: join(packagesDirectory, name, "src", "index.ts") })),
      { find: /^@runshape\/([^/]+)\/(.+)$/, replacement: `${packagesDirectory}/$1/$2` },
    ]
  : [];
process.env.RUNSHAPE_TARGET = target;
process.env.RUNSHAPE_INCLUDE = include.join(",");
process.env.RUNSHAPE_OUT ??= join(target, ".runshape", "traces");

const cache = process.env.RUNSHAPE_CACHE;

export default defineConfig({
  root: target,
  ...(cache ? { cacheDir: join(cache, "vite") } : {}),
  resolve: { alias },
  plugins: [runshapeInstrument(target, include)],
  test: {
    include: (process.env.RUNSHAPE_TESTS ?? RECORDED_PACKAGES.map((name) => `packages/${name}/test/**/*.test.ts`).join(",")).split(","),
    // Wraps each test's function, so its hooks are told apart from its body (src/runner.ts).
    runner: join(here, "src/runner.ts"),
    setupFiles: [join(here, "src/setup.ts")],
    globalSetup: [join(here, "src/global-setup.ts")],
    // One test file at a time, so scenario files are written in the order the tests ran.
    fileParallelism: false,
    testTimeout: 120_000,
    ...(cache ? { fsModuleCachePath: join(cache, "vitest") } : {}),
  },
});
