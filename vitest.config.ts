import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { projects: ["packages/core", "packages/extension", "packages/webview", "packages/cli"] },
});
