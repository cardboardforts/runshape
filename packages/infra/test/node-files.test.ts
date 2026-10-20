/**
 * The file stores are a trust boundary: the paths they're asked for come from trace files
 * (a manifest names its scenario files) and from the webview, and anyone who can commit to
 * the repository being viewed can write those.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { NodeFiles, safeSegments } from "../src";

describe("safeSegments (path traversal)", () => {
  test("keeps relative paths, refuses anything that escapes the directory", () => {
    expect(safeSegments("app/api/routes/users.py")).toEqual(["app", "api", "routes", "users.py"]);
    expect(safeSegments("./app//main.py")).toEqual(["app", "main.py"]);

    for (const escaping of ["../secrets.env", "app/../../etc/passwd", "/etc/passwd", "C:\\Windows\\win.ini", "app\\..\\..\\x"]) {
      expect(() => safeSegments(escaping), escaping).toThrowError(/refusing a path outside its directory/);
    }
  });
});

describe("NodeFiles", () => {
  test("reads text under its root, and refuses a path that climbs out of it", async () => {
    const root = await mkdtemp(join(tmpdir(), "runshape-infra-"));
    await writeFile(join(root, "latest.json"), '{"run": "r1"}');
    const files = new NodeFiles(root);

    expect(await files.readText("latest.json")).toBe('{"run": "r1"}');
    // A manifest naming "../../.ssh/id_rsa" as a scenario file: refused before the disk is touched.
    await expect(files.readText("r1/../../outside.json")).rejects.toThrowError(/refusing a path outside its directory/);
    await expect(files.readText("missing.json")).rejects.toThrowError(/ENOENT/);
  });
});
