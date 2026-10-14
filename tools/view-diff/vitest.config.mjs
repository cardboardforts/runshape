import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Not a test suite: vitest is only how views.dump.ts gets TypeScript run with no build step.
// @runshape/* resolves to the packages of the revision being dumped (CORE_SRC's), not to the
// working tree's through node_modules: otherwise a base worktree would run head's packages.
const packages = join(process.env.CORE_SRC ?? ".", "..", "..");
const alias = existsSync(packages)
  ? Object.fromEntries(
      readdirSync(packages)
        .filter((name) => existsSync(join(packages, name, "src", "index.ts")))
        .map((name) => [`@runshape/${name}`, join(packages, name, "src", "index.ts")]),
    )
  : {};

export default {
  root: dirname(fileURLToPath(import.meta.url)),
  resolve: { alias },
  test: { include: ["*.dump.ts"], testTimeout: 300_000 },
};
