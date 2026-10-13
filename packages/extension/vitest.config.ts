import { defineConfig } from "vitest/config";

// Unit tests only; the VS Code end-to-end run is test/e2e/run.mjs (npm run test:e2e).
export default defineConfig({ test: { include: ["test/unit/**/*.test.ts"] } });
