import { defineConfig } from "vitest/config";

// test/sample-project is recorded by test/record.test.ts, not run as part of these tests.
export default defineConfig({ test: { exclude: ["**/node_modules/**", "test/sample-project/**"] } });
