/**
 * The arrangement file on disk: none until a person first moves a box; what's written is read
 * back whole; anything else wrong with it is an error, never "no arrangement" (which a save
 * would then overwrite).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { ArrangementFile, MAX_ARRANGEMENT_BYTES } from "../src";

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

  /**
   * A checkout or a copied .runshape can bring links: reading through one would show (and the
   * next save would replace) a file somewhere else entirely. None is followed.
   */
  test("a folder, a link, or a huge file where the arrangement should be is refused; a planted link beside it is replaced, not written through", async () => {
    const root = mkdtempSync(join(tmpdir(), "runshape-arrangement-"));
    const outside = join(root, "elsewhere.txt");
    writeFileSync(outside, "someone else's file");
    const runshape = join(root, ".runshape");
    const read = (setUp: () => void) => {
      rmSync(runshape, { recursive: true, force: true });
      mkdirSync(runshape);
      setUp();
      return new ArrangementFile(root).read().then(
        (text) => `read: ${text}`,
        (error: Error) => error.message.replace(root, "<root>"),
      );
    };

    const refused = [
      await read(() => mkdirSync(join(runshape, "arrangement.json"))),
      await read(() => symlinkSync(outside, join(runshape, "arrangement.json"))),
      await read(() => writeFileSync(join(runshape, "arrangement.json"), "x".repeat(MAX_ARRANGEMENT_BYTES + 1))),
    ];
    rmSync(runshape, { recursive: true, force: true });
    mkdirSync(runshape);
    symlinkSync(outside, join(runshape, "arrangement.json.writing"));
    await new ArrangementFile(root).write("mine\n");

    expect({ refused, outsideUntouched: readFileSync(outside, "utf8"), saved: readFileSync(join(runshape, "arrangement.json"), "utf8"), left: readdirSync(runshape) }).toEqual({
      refused: [
        ".runshape/arrangement.json isn't a plain file (a link or a folder): not read",
        ".runshape/arrangement.json isn't a plain file (a link or a folder): not read",
        `.runshape/arrangement.json is over ${MAX_ARRANGEMENT_BYTES} bytes: not read`,
      ],
      outsideUntouched: "someone else's file",
      saved: "mine\n",
      left: ["arrangement.json"],
    });
  });
});
