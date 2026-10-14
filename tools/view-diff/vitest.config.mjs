import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Not a test suite: vitest is only how views.dump.ts gets TypeScript run with no build step.
export default {
  root: dirname(fileURLToPath(import.meta.url)),
  test: { include: ["*.dump.ts"], testTimeout: 300_000 },
};
