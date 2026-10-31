/**
 * The arrangement file on disk: none until a person first moves a box; what's written is read
 * back whole; anything else wrong with it is an error, never "no arrangement" (which a save
 * would then overwrite).
 */
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { ArrangementFile } from "../src";

describe("ArrangementFile", () => {
  test("none at first; written, then read back; nothing left beside it", async () => {
    const root = mkdtempSync(join(tmpdir(), "runshape-arrangement-"));
    const file = new ArrangementFile(root);

    const before = await file.read();
    await file.write('{ "format": "runshape-arrangement" }\n');

    expect({ before, after: await file.read(), where: file.where, folder: readdirSync(join(root, ".runshape")) }).toEqual({
      before: null,
      after: '{ "format": "runshape-arrangement" }\n',
      where: ".runshape/arrangement.json",
      folder: ["arrangement.json"],
    });
  });

  test("a folder where the file should be is an error, not an empty arrangement", async () => {
    const root = mkdtempSync(join(tmpdir(), "runshape-arrangement-"));
    mkdirSync(join(root, ".runshape", "arrangement.json"), { recursive: true });

    await expect(new ArrangementFile(root).read()).rejects.toThrow(/EISDIR/);
  });
});
