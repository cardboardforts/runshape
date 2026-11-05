/**
 * runshape-arch/ is the out-of-the-box catalog, and the runshape-map skill's check-map script
 * reads a project's map against it. Two promises are held here.
 *
 * The catalog repeats what the code defines: until profiles.ts and taxonomy.ts read from it,
 * these tests are what stop the markdown and the code drifting apart.
 *
 * check-map is the deterministic half of the interview. A person names the systems, a model maps
 * words to folders, and this script says what nobody claimed. Leftovers are questions for the
 * person, not errors: only a map that can't be read or trusted exits 1. It's run as a real
 * process over real git repositories because that's how the skill runs it, from another repo.
 */
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { BUILT_IN_DEFINITIONS, PROFILES, ZoneRules } from "../src";

const run = promisify(execFile);
const REPO = resolve(__dirname, "../../..");
const CATALOG = join(REPO, "runshape-arch");
const CHECK_MAP = join(REPO, ".claude/skills/runshape-map/scripts/check-map.mjs");

const projects: string[] = [];
afterEach(async () => {
  for (const folder of projects.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function git(project: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: project });
  return stdout.trim();
}

/** A committed repository with these files, each holding `lines` lines. */
async function project(files: string[], lines = 10): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runshape-map-"));
  projects.push(root);
  await git(root, "init", "-q");
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), "line\n".repeat(lines));
  }
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "start");
  return root;
}

async function checkMap(root: string, map: unknown): Promise<{ exit: number; report: any }> {
  await writeFile(join(root, "runshape.json"), JSON.stringify({ version: 2, style: "hexagonal", zones: [], map }));
  await git(root, "add", "runshape.json");
  return checkMapAsIs(root);
}

async function checkMapAsIs(root: string): Promise<{ exit: number; report: any }> {
  try {
    const { stdout } = await run("node", [CHECK_MAP, "--project", root]);
    return { exit: 0, report: JSON.parse(stdout) };
  } catch (error) {
    const failed = error as { code: number; stdout: string };
    return { exit: failed.code, report: JSON.parse(failed.stdout) };
  }
}

const system = (name: string, more: object) => ({ name, description: `what ${name} is for`, by: "user", ...more });
const box = (name: string, paths: string[], more: object = {}) => system(name, { paths, pathsBy: "llm", state: "shape", style: "layered", ...more });

describe("check-map", () => {
  test("says what nobody claimed, what two systems claimed, and which systems hold no code", async () => {
    // The cardboard-genome case. Backend spans three folders and Frontend one, Auth names a
    // folder with nothing in it, the database lives outside the repo, and lab/ was forgotten.
    // The two systems both reaching shared/ is the question the person hasn't answered yet.
    const root = await project(["api/core/a.py", "api/core/b.py", "api/config/c.py", "fhir/d.yaml", "portal/patient/e.ts", "portal/shared/f.ts", "lab/src/g.py", "lab/h.py", "README.md"]);

    const { exit, report } = await checkMap(root, {
      version: 1,
      systems: [
        system("Backend", {
          state: "parts",
          systems: [box("Core", ["api/core/**"]), box("Auth", ["auth/**"]), box("FHIR", ["fhir/**"])],
        }),
        system("Frontend", {
          paths: ["portal/**"],
          pathsBy: "llm",
          state: "parts",
          systems: [box("Patient", ["portal/patient/**", "portal/shared/**"]), box("Design", ["portal/shared/**"])],
        }),
        system("Database", { paths: [], state: "shape", style: "layered" }),
      ],
      expects: [{ from: "Frontend/Patient", to: "Backend/FHIR", talks: false, reason: "portals go through the API", by: "user" }],
    });

    expect(report).toEqual({
      catalog: CATALOG,
      files: 9,
      problems: [],
      unclaimed: [{ within: null, files: 4, groups: ["README.md", "api/config/ (1 file)", "lab/ (2 files)"] }],
      claimedTwice: [{ file: "portal/shared/f.ts", systems: ["Frontend/Design", "Frontend/Patient"] }],
      noCode: ["Backend/Auth", "Database"],
      undecided: [],
      states: { parts: 2, shape: 6, dragons: 0, spaghetti: 0 },
      patterns: 0,
    });
    expect(exit, "leftovers are questions for the person, not failures").toBe(0);
  });

  test("code a parent claimed that none of its parts did is a question at that level", async () => {
    const root = await project(["portal/patient/a.ts", "portal/shared/b.ts", "portal/shared/c.ts"]);

    const { report } = await checkMap(root, {
      version: 1,
      systems: [system("Frontend", { paths: ["portal/**"], pathsBy: "llm", state: "parts", systems: [box("Patient", ["portal/patient/**"])] })],
    });

    expect(report.unclaimed).toEqual([{ within: "Frontend", files: 2, groups: ["portal/shared/ (2 files)"] }]);
    expect(report.claimedTwice).toEqual([]);
  });

  test("dragons and spaghetti are complete answers: their code is claimed and nothing is asked of them", async () => {
    // Three systems plus one giant dragon is an honest, complete map of a big repo.
    const root = await project(["billing/a.py", "legacy/b.py"]);

    const { exit, report } = await checkMap(root, {
      version: 1,
      systems: [
        system("Billing", { paths: ["billing/**"], pathsBy: "user", state: "dragons", label: "thar be dragons", marked: { who: "Sam", on: "2026-11-05" } }),
        system("Legacy", { paths: ["legacy/**"], pathsBy: "user", state: "spaghetti", marked: { who: "Sam", on: "2026-11-05" } }),
      ],
    });

    expect({ exit, problems: report.problems, unclaimed: report.unclaimed, states: report.states }).toEqual({
      exit: 0,
      problems: [],
      unclaimed: [],
      states: { parts: 0, shape: 0, dragons: 1, spaghetti: 1 },
    });
  });

  test("a map with mistakes reports every one, with where it is, and exits 1", async () => {
    const root = await project(["api/a.py"]);

    const { exit, report } = await checkMap(root, {
      version: 1,
      systems: [
        { name: "", state: "parts", by: "robot" },
        "not a system",
        system("Twin", { paths: ["api/**"], state: "shape", style: "triangle-of-doom", pathsBy: "guess" }),
        system("Twin", { paths: ["api/**"], state: "dragons", style: "layered", marked: { who: "Sam", on: "2026-13-45" } }),
        system("Zoned", { paths: ["api/**"], pathsBy: "user", state: "shape", style: "layered", zones: [{ paths: ["web/**"], zone: "basement", by: "user" }], roles: [{ role: "wizard", paths: ["api/**"], by: "llm" }] }),
        system("Odd", { paths: ["api/**"], pathsBy: "user", state: "maybe" }),
        system("A/B", { paths: [5, ""], state: "shape", style: "layered", systems: [box("Inner", ["api/**"])] }),
        system("Stringy", { paths: "api/**" }),
      ],
      expects: [{ from: "Twin", to: "Nowhere", talks: "sometimes", by: "user" }],
      exceptions: [{ claim: "", by: "user" }],
      patterns: [{ parts: [] }],
    });

    expect(report.problems).toEqual([
      "systems[0].name must be a non-empty string",
      "systems[0].description must say what it is for",
      'systems[0].by must be "user", "llm" or "detected"',
      "systems[1] must be an object",
      'systems[2] (Twin).pathsBy must be "user", "llm" or "detected"',
      'systems[2] (Twin).style "triangle-of-doom" is not in the catalog (container-presentational, feature-sliced, flux, hexagonal, layered, mvc, mvp, mvvm)',
      "systems[3] (Twin): the name is already used at this level",
      'systems[3] (Twin): "dragons" takes no style',
      "systems[3] (Twin).marked must say who and on (YYYY-MM-DD)",
      'systems[4] (Zoned).zones[0].zone "basement" is not a zone of layered (presentation, business, data)',
      "systems[4] (Zoned).zones[0].reason must say why",
      "systems[4] (Zoned).zones[0].paths match no code in this system",
      'systems[4] (Zoned).roles[0].role "wizard" is not in the catalog',
      "systems[4] (Zoned).roles[0].reason must say why",
      'systems[5] (Odd).state must be "parts", "shape", "dragons" or "spaghetti"',
      'systems[6] (A/B).name can\'t contain "/": a system\'s path joins names with it',
      "systems[6] (A/B).paths must be a list of non-empty globs",
      'systems[6] (A/B): "shape" stops the drill-down, so it has no systems: use "parts"',
      "systems[7] (Stringy).paths must be a list of non-empty globs",
      'expects[0].to "Nowhere" is not a system',
      "expects[0].talks must be true or false",
      "expects[0].reason must say why",
      "exceptions[0].claim must say what doesn't hold",
      "exceptions[0].reason must say why",
      "patterns[0].name must be a non-empty string",
      'patterns[0].by must be "user", "llm" or "detected"',
      "patterns[0].parts must list at least one part",
    ]);
    expect(exit).toBe(1);
  });

  test("a pattern instance may be freeform or from the catalog, and its line ranges are checked at their commit", async () => {
    // A range only means something at the commit it was tagged at, so the file may since have
    // moved or shrunk: everything here reads that commit, never the working tree. Following a
    // range forward is task 3's job (docs/tagged-diffs.md).
    const root = await project(["foo/window.py"], 50);
    const commit = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "foo/window.py"), "line\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "shrink it");

    const { exit, report } = await checkMap(root, {
      version: 1,
      systems: [],
      patterns: [
        {
          name: "Foo Sliding Window",
          catalog: "dsa-sliding-window",
          description: "the rolling rate over readings",
          by: "user",
          parts: [
            { part: "shrink", file: "foo/window.py", symbol: "Foo.advance", lines: [40, 47], commit },
            { part: "emit", file: "foo/window.py", symbol: "Foo.emit" },
          ],
        },
        { name: "How we retry here", catalog: null, by: "user", parts: [{ part: "the whole thing", file: "foo/window.py" }] },
      ],
    });
    expect({ exit, problems: report.problems, patterns: report.patterns }).toEqual({ exit: 0, problems: [], patterns: 2 });

    const broken = await checkMap(root, {
      version: 1,
      systems: [],
      patterns: [
        {
          name: "Broken",
          catalog: "dsa-sliding-doors",
          by: "user",
          parts: [
            { part: "no commit", file: "foo/window.py", lines: [1, 2] },
            { part: "backwards", file: "foo/window.py", lines: [9, 2], commit },
            { part: "too far", file: "foo/window.py", lines: [40, 51], commit },
            { part: "no such commit", file: "foo/window.py", lines: [1, 2], commit: "0000000000000000000000000000000000000000" },
            { part: "no such file then", file: "foo/gone.py", lines: [1, 2], commit },
            { file: "" },
          ],
        },
      ],
    });
    expect(broken.report.problems).toEqual([
      'patterns[0] (Broken).catalog "dsa-sliding-doors" is not in the catalog: use a catalog id, or null for a name of your own',
      "patterns[0] (Broken).parts[0].lines need the commit they were tagged at",
      "patterns[0] (Broken).parts[1].lines must be [first, last], counting from 1",
      "patterns[0] (Broken).parts[2].lines run past the 50 lines foo/window.py had at that commit",
      "patterns[0] (Broken).parts[3].commit 0000000000000000000000000000000000000000 has no foo/window.py",
      `patterns[0] (Broken).parts[4].commit ${commit} has no foo/gone.py`,
      "patterns[0] (Broken).parts[5].part must name the part",
      "patterns[0] (Broken).parts[5].file must be a path from the project root",
    ]);
  });

  test("a repository's runshape.json can't reach git's options: a commit is a hex sha or a problem", async () => {
    // check-map reads other people's repositories. Passed to git, this would write a file
    // outside the project, so nothing from the map may ever arrive at git as an option.
    const root = await project(["foo/window.py"]);
    const outside = join(root, "..", `pwned-${Date.now()}`);
    projects.push(`${outside}:foo`);

    const { exit, report } = await checkMap(root, {
      version: 1,
      patterns: [{ name: "Attack", by: "user", parts: [{ part: "p", file: "foo/window.py", lines: [1, 2], commit: `--output=${outside}` }] }],
    });

    expect({ exit, problems: report.problems }).toEqual({ exit: 1, problems: ["patterns[0] (Attack).parts[0].commit must be a commit's hex sha"] });
    await expect(access(`${outside}:foo`)).rejects.toThrow();
  });

  test("a section of the wrong type is reported, never skipped or crashed on", async () => {
    const root = await project(["api/a.py"]);

    const nonsense = await checkMap(root, { version: 1, systems: "x", expects: 5, exceptions: {}, patterns: {} });
    expect(nonsense.report.problems).toEqual(["systems must be a list", "expects must be a list", "exceptions must be a list", "patterns must be a list"]);

    expect((await checkMap(root, 5)).report.problems).toEqual(["map must be an object"]);

    await writeFile(join(root, "runshape.json"), "null");
    expect((await checkMapAsIs(root)).report.problems).toEqual(["runshape.json must be an object"]);
  });

  test("the skill can save between questions: an unanswered system is listed, not refused", async () => {
    // Step 3 saves and checks before step 4 asks what each system is. A model must never be
    // pushed to invent a state to get past the check. "parts" with nothing under it yet is
    // the person stopping there, which is theirs to decide.
    const root = await project(["api/a.py", "web/b.ts"]);

    const { exit, report } = await checkMap(root, {
      version: 1,
      systems: [system("API", { paths: ["api/**"], pathsBy: "llm" }), system("Web", { paths: ["web/**"], pathsBy: "llm", state: "parts" })],
    });

    expect({ exit, problems: report.problems, undecided: report.undecided }).toEqual({ exit: 0, problems: [], undecided: ["API", "Web"] });
  });

  test("paths take a bare folder, a file, and both wildcards, and punctuation means itself", async () => {
    const root = await project(["src/billing/handlers/pay.py", "src/users/handlers/add.py", "src/users/handlers/deep/x.py", "docs/a.md", "docs/more/b.md", "odd?name/c.txt", "root.txt", "rootXtxt"]);

    const { report } = await checkMap(root, {
      version: 1,
      systems: [
        system("Mid", { paths: ["src/**/handlers/*.py"] }),
        system("Folder", { paths: ["docs", "root.txt"] }),
        system("Punctuation", { paths: ["odd?name/**"] }),
      ],
    });

    expect({ problems: report.problems, unclaimed: report.unclaimed }).toEqual({
      problems: [],
      unclaimed: [{ within: null, files: 2, groups: ["rootXtxt", "src/users/handlers/deep/ (1 file)"] }],
    });
  });

  test("a project with no map yet is all unclaimed: the state the interview starts from", async () => {
    const root = await project(["api/a.py", "lab/b.py", "lab/c.py"]);

    expect(await checkMapAsIs(root)).toEqual({
      exit: 0,
      report: {
        catalog: CATALOG,
        files: 3,
        problems: [],
        unclaimed: [{ within: null, files: 3, groups: ["api/ (1 file)", "lab/ (2 files)"] }],
        claimedTwice: [],
        noCode: [],
        undecided: [],
        states: { parts: 0, shape: 0, dragons: 0, spaghetti: 0 },
        patterns: 0,
      },
    });
  });

  test("a runshape.json that won't parse, or a folder outside git, is a failure with a reason", async () => {
    const root = await project(["api/a.py"]);
    await writeFile(join(root, "runshape.json"), "{ not json");
    const unreadable = await checkMapAsIs(root);
    expect({ exit: unreadable.exit, problem: unreadable.report.problems[0].slice(0, 26) }).toEqual({ exit: 1, problem: "runshape.json is not JSON:" });

    const plain = await mkdtemp(join(tmpdir(), "runshape-map-"));
    projects.push(plain);
    const outside = await checkMapAsIs(plain);
    expect({ exit: outside.exit, problem: outside.report.problems[0].slice(0, 26) }).toEqual({ exit: 1, problem: "not a git repository: git " });
  });

  test("installed as a symlink into another project, it still finds the catalog", async () => {
    // How cardboard-genome gets it: ~/.claude/skills/runshape-map points back into this repo.
    const home = await mkdtemp(join(tmpdir(), "runshape-map-"));
    projects.push(home);
    await symlink(join(REPO, ".claude/skills/runshape-map"), join(home, "runshape-map"));

    const { stdout } = await run("node", [join(home, "runshape-map/scripts/check-map.mjs"), "where"]);

    expect(stdout.trim()).toBe(CATALOG);
  });
});

describe("the catalog repeats what the code defines", () => {
  const frontmatter = (text: string): Record<string, string> => {
    const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
    return Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
  };
  const entryIds = (text: string) => [...text.matchAll(/^### `([a-z0-9-]+)`/gm)].map((match) => match[1]!);
  const filesIn = async (folder: string) => (await readdir(join(CATALOG, folder))).filter((file) => file.endsWith(".md") && file !== "README.md");
  const read = (folder: string, file: string) => readFile(join(CATALOG, folder, file), "utf8");

  test("every style Runshape draws has a file with the same zones in the same drawing order", async () => {
    const drawn: Record<string, string[]> = {};
    for (const file of await filesIn("styles")) {
      const fields = frontmatter(await read("styles", file));
      if (fields.drawn === "true") drawn[fields.id!] = fields.zones!.split(",").map((zone) => zone.trim());
    }
    expect(drawn).toEqual(Object.fromEntries(PROFILES.map((profile) => [profile.style, profile.zones.map((zone) => zone.id)])));
  });

  test("every built-in role and trait is defined in the catalog, and no id is repeated within a family", async () => {
    const ids = new Set<string>();
    for (const folder of ["roles", "traits"]) {
      for (const file of await filesIn(folder)) {
        const here = entryIds(await read(folder, file));
        expect(new Set(here).size, `${folder}/${file} repeats an id`).toBe(here.length);
        here.forEach((id) => ids.add(id));
      }
    }
    expect(BUILT_IN_DEFINITIONS.map((definition) => definition.id).filter((id) => !ids.has(id))).toEqual([]);
  });

  test("every pattern entry says what it is, its parts, what must hold, how it breaks and how to see it", async () => {
    const seen: string[] = [];
    for (const file of await filesIn("patterns")) {
      const entries = (await read("patterns", file)).split(/^(?=### `)/m).slice(1);
      expect(entries.length, `${file} has no entries`).toBeGreaterThan(0);
      for (const entry of entries) {
        const [id] = entryIds(entry);
        seen.push(id!);
        const missing = ["**What:**", "**Parts:**", "**Invariants:**", "**Bugs:**", "**See it:**"].filter((field) => !entry.includes(field));
        expect(missing, `${id} is missing fields`).toEqual([]);
      }
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain("dsa-sliding-window");
  });

  test("every standard says how it's checked, and every cross-reference between entries resolves", async () => {
    const known = new Set<string>();
    const bodies: string[] = [];
    for (const folder of ["patterns", "standards", "roles", "traits"]) {
      for (const file of await filesIn(folder)) {
        const text = await read(folder, file);
        entryIds(text).forEach((id) => known.add(id));
        bodies.push(text);
      }
    }
    for (const file of await filesIn("standards")) {
      for (const entry of (await read("standards", file)).split(/^(?=### `)/m).slice(1)) {
        const missing = ["**Rule:**", "**Why:**", "**Check:**", "**Severity:**"].filter((field) => !entry.includes(field));
        expect(missing, `${entryIds(entry)[0]} is missing fields`).toEqual([]);
      }
    }
    const dangling = bodies.flatMap((text) => [...text.matchAll(/^\*\*(?:With|Conflicts):\*\* (.*)$/gm)].flatMap((line) => [...line[1]!.matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1]!))).filter((id) => !known.has(id));
    expect(dangling).toEqual([]);
  });

  test("the skill's map section survives Runshape reading and rewriting runshape.json", () => {
    // The viewer doesn't draw the map yet, but a zone saved from it must not lose the map.
    // No "style" at the top: the interview hasn't claimed one, and the loader doesn't need it.
    const map = { version: 1, systems: [{ name: "Core", description: "what it is for", by: "user", paths: ["api/**"], pathsBy: "llm", state: "shape", style: "layered" }], expects: [], exceptions: [], patterns: [] };

    const rules = ZoneRules.parse(JSON.stringify({ version: 2, zones: [], map }));

    expect(JSON.parse(rules.serialize()).map).toEqual(map);
  });
});
