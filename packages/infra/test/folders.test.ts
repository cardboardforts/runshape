/**
 * The folder operations the recording library is built on. A recording is ~100 MB written by
 * tests that may not be the person's own (a PR, an agent's branch), so each of these is about
 * what's left on disk when something goes wrong.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { assertPlainFiles, holdingLock, LockHeld, NotPlainFiles, removeAnyway, swapIntoPlace } from "../src";

/** No process has this id (Linux and macOS cap pids far below it). */
const DEAD_PID = 99_999_999;

function folder(): string {
  return mkdtempSync(join(tmpdir(), "runshape-folders-"));
}

describe("swapIntoPlace", () => {
  test("the finished folder takes the old one's place; with no old one, it just moves in; the old one is gone after", async () => {
    const root = folder();
    mkdirSync(join(root, ".incoming-a"));
    writeFileSync(join(root, ".incoming-a", "recording.json"), "new");
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "recording.json"), "old");
    mkdirSync(join(root, ".incoming-b"));

    await swapIntoPlace(join(root, ".incoming-a"), join(root, "a"), join(root, ".replaced-a"));
    await swapIntoPlace(join(root, ".incoming-b"), join(root, "b"), join(root, ".replaced-b"));

    expect({ left: readdirSync(root).sort(), a: readFileSync(join(root, "a", "recording.json"), "utf8") }).toEqual({ left: ["a", "b"], a: "new" });
  });

  test("when the finished folder can't move in, the old one is put back as it was", async () => {
    const root = folder();
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "recording.json"), "old");

    const failure = await swapIntoPlace(join(root, ".incoming-gone"), join(root, "a"), join(root, ".replaced-a")).catch((error: Error) => error.message);

    expect({ failed: /ENOENT/.test(failure ?? ""), left: readdirSync(root), a: readFileSync(join(root, "a", "recording.json"), "utf8") }).toEqual({ failed: true, left: ["a"], a: "old" });
  });
});

describe("holdingLock", () => {
  test("refuses while a live process holds it, takes over one a dead process left, and lets go after, even when the work fails", async () => {
    const root = folder();
    const lock = join(root, ".lock");

    writeFileSync(lock, String(process.pid)); // this very process: alive
    const refused = await holdingLock(lock, async () => "ran").catch((error: unknown) => error);
    writeFileSync(lock, String(DEAD_PID));
    const tookOver = await holdingLock(lock, async () => readFileSync(lock, "utf8"));
    const failed = await holdingLock(lock, async () => Promise.reject(new Error("the recorder failed"))).catch((error: Error) => error.message);

    expect({
      refused: refused instanceof LockHeld ? { holder: refused.holder, lockFile: refused.lockFile } : refused,
      heldAs: tookOver,
      failed,
      released: existsSync(lock),
    }).toEqual({ refused: { holder: process.pid, lockFile: lock }, heldAs: String(process.pid), failed: "the recorder failed", released: false });
  });
});

describe("assertPlainFiles and removeAnyway", () => {
  test("a link, too many bytes, or a folder made unreadable are each refused, saying which; removeAnyway still clears all of them", async () => {
    const reasons: Record<string, string> = {};
    const leftBehind: string[] = [];
    const cases: Record<string, (path: string) => void> = {
      plain: (path) => writeFileSync(join(path, "manifest.json"), "{}"),
      link: (path) => symlinkSync("/etc/hosts", join(path, "runshape.json")),
      big: (path) => writeFileSync(join(path, "scenario.json"), "x".repeat(2048)),
      unreadable: (path) => {
        mkdirSync(join(path, "locked", "inside"), { recursive: true });
        chmodSync(join(path, "locked"), 0o000);
      },
    };
    for (const [name, make] of Object.entries(cases)) {
      const path = folder();
      make(path);
      reasons[name] = await assertPlainFiles(path, 1024).then(
        () => "plain",
        (error: unknown) => (error instanceof NotPlainFiles ? `${error.reason}${error.reason === "not-a-file" ? ` ${error.detail}` : ""}` : String(error)),
      );
      await removeAnyway(path);
      if (existsSync(path)) leftBehind.push(name);
    }

    expect({ reasons, leftBehind }).toEqual({
      reasons: { plain: "plain", link: "not-a-file runshape.json", big: "too-big", unreadable: "unreadable" },
      leftBehind: [],
    });
    // The link was removed, never followed.
    expect(existsSync("/etc/hosts")).toBe(true);
  });
});
