/**
 * Which version of the recorder made a recording (ShellRecorder.source): a hash of its source
 * and the lockfile its dependencies come from. A base recorded by another version is recorded
 * again before a comparison (recordings.test.ts), so what counts as "another version" matters:
 * its own tests and installed packages don't change what it records.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { nodeHashing } from "@runshape/infra";
import { ShellRecorder } from "../src/recorders/shell-recorder";

describe("ShellRecorder.source", () => {
  test("changes with the recorder's source or the lockfile; not with its tests or node_modules", async () => {
    const root = mkdtempSync(join(tmpdir(), "runshape-recorder-"));
    const write = (path: string, text: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write("package-lock.json", "{}");
    write("recorder-ts/src/runtime.ts", "export {};");
    const recorder = new ShellRecorder(root, nodeHashing);
    const source = () => recorder.source();

    const first = await source();
    write("recorder-ts/test/runtime.test.ts", "a test");
    write("recorder-ts/node_modules/dep/index.js", "a dependency");
    const afterTests = await source();
    write("recorder-ts/src/runtime.ts", "export const changed = true;");
    const afterSource = await source();
    write("package-lock.json", '{"lockfileVersion": 3}');
    const afterLockfile = await source();

    expect({
      digits: first.length,
      testsChangeIt: afterTests !== first,
      sourceChangesIt: afterSource !== afterTests,
      lockfileChangesIt: afterLockfile !== afterSource,
    }).toEqual({ digits: 16, testsChangeIt: false, sourceChangesIt: true, lockfileChangesIt: true });
  });
});
