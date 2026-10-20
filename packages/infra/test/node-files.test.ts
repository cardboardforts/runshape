/**
 * The file stores are a trust boundary: the paths they're asked for come from trace files
 * (a manifest names its scenario files) and from the webview, and anyone who can commit to
 * the repository being viewed can write those.
 */
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
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

describe("NodeFiles writing", () => {
  test("writes make their folders (or makeFolder does), lists name what's there, removes take folders whole and refuse the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "runshape-infra-"));
    const files = new NodeFiles(root);

    await files.writeText("a..b/review.md", "## Behaviour changes\n");
    await files.writeText("a..b/review.json", "{}\n");
    await files.writeText("c..d/review.md", "## Behaviour changes\n");
    await files.makeFolder("empty/inside");
    const before = { root: (await files.list()).sort(), review: (await files.list("a..b")).sort(), missing: await files.list("nothing-here") };
    await files.remove("a..b");
    await files.remove("never-written");

    expect({ before, after: (await readdir(root)).sort(), text: await files.readText("c..d/review.md") }).toEqual({
      before: { root: ["a..b", "c..d", "empty"], review: ["review.json", "review.md"], missing: [] },
      after: ["c..d", "empty"],
      text: "## Behaviour changes\n",
    });
    // A folder named ".." is refused like any climb; "a..b" above is a name, not a climb.
    await expect(files.remove("")).rejects.toThrowError(/refusing to remove the whole of/);
    await expect(files.remove(".")).rejects.toThrowError(/refusing to remove the whole of/);
    await expect(files.writeText("../escaped.md", "x")).rejects.toThrowError(/refusing a path outside its directory/);
  });
});

describe("NodeFiles.readTextWithin (the demo's dev server)", () => {
  test("reads a file inside; refuses a climb, a link out (even one inside that points out), and a folder", async () => {
    const outside = await mkdtemp(join(tmpdir(), "runshape-outside-"));
    await writeFile(join(outside, "secret.json"), "{}");
    const root = await mkdtemp(join(tmpdir(), "runshape-infra-"));
    await mkdir(join(root, "r1"));
    await writeFile(join(root, "r1", "manifest.json"), '{"ok": true}');
    // What a sandboxed recording could leave: a link to a file outside the library.
    await symlink(join(outside, "secret.json"), join(root, "r1", "leak.json"));
    const files = new NodeFiles(root);

    const read = (path: string) => files.readTextWithin(path).then((text) => text, (error: Error) => error.message.split(":")[0]!);

    expect({
      inside: await read("r1/manifest.json"),
      climb: await read("../secret.json"),
      linkOut: await read("r1/leak.json"),
      folder: (await read("r1")).startsWith("EISDIR"),
    }).toEqual({ inside: '{"ok": true}', climb: "refusing a path outside its directory", linkOut: "refusing a link out of its directory", folder: true });
  });
});
