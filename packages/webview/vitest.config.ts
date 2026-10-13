import { defineConfig } from "vitest/config";

// Pure presentation logic only (layouts); rendering is checked in a browser via the demo.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node" } });
