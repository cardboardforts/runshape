import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { projects: ["packages/infra", "packages/architecture", "packages/views", "packages/visualizer", "packages/core", "packages/explainer", "packages/workflows", "packages/extension", "packages/webview", "packages/cli", "packages/library", "packages/adapters", "recorder-ts"] },
});
