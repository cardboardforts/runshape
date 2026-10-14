import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { projects: ["packages/trace", "packages/architecture", "packages/views", "packages/core", "packages/extension", "packages/webview", "packages/cli", "recorder-ts"] },
});
