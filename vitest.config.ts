import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tools/test-tmpdir.ts"],
    projects: ["packages/infra", "packages/architecture", "packages/trace", "packages/visualizer", "packages/kernel", "packages/explainer", "packages/workflows", "packages/extension", "packages/webview", "packages/cli", "packages/adapters", "recorder-ts"],
  },
});
