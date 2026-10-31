/**
 * Which version of the recorder made a recording (TypeScriptRecorder.source): a hash of its
 * source, the lockfile its dependencies come from, and the project's TestConfig. A base recorded by another version is recorded
 * again before a comparison (recordings.test.ts), so what counts as "another version" matters:
 * its own tests and installed packages don't change what it records.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { nodeHashing } from "@runshape/infra";
import { TestConfig } from "@runshape/kernel";
import { TypeScriptRecorder } from "../src/recorders/typescript/typescript-recorder";

const RUNSHAPE: TestConfig = { language: "typescript", chosenBy: "package.json", source: [], tests: [], args: [], interpreter: null };

describe("TypeScriptRecorder.source", () => {
  test("changes with the recorder's source, the lockfile or how the project is recorded; not with its tests or node_modules, nor why the language was chosen", async () => {
    const root = mkdtempSync(join(tmpdir(), "runshape-recorder-"));
    const write = (path: string, text: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write("package-lock.json", "{}");
    write("recorder-ts/src/runtime.ts", "export {};");
    const source = (config = RUNSHAPE) => new TypeScriptRecorder(root, root, config, nodeHashing).source();

    const first = await source();
    write("recorder-ts/test/runtime.test.ts", "a test");
    write("recorder-ts/node_modules/dep/index.js", "a dependency");
    const afterTests = await source();
    write("recorder-ts/src/runtime.ts", "export const changed = true;");
    const afterSource = await source();
    write("package-lock.json", '{"lockfileVersion": 3}');
    const afterLockfile = await source();
    const declared = await source({ ...RUNSHAPE, chosenBy: "runshape.json" });
    const otherTests = await source({ ...RUNSHAPE, tests: ["packages/kernel/test/**/*.test.ts"] });

    expect({
      digits: first.length,
      testsChangeIt: afterTests !== first,
      sourceChangesIt: afterSource !== afterTests,
      lockfileChangesIt: afterLockfile !== afterSource,
      whyChangesIt: declared !== afterLockfile,
      otherTestsChangeIt: otherTests !== afterLockfile,
    }).toEqual({ digits: 16, testsChangeIt: false, sourceChangesIt: true, lockfileChangesIt: true, whyChangesIt: false, otherTestsChangeIt: true });
  });
});
