/**
 * A guide to each source folder, from the recording (docs/ideas.md, idea 6): what the folder is
 * in the architecture, what's in each file, and the questions writing that down raises. "This
 * file doesn't fit here", "this one holds two kinds of code", "nothing runs this one". The
 * guides become the folders' READMEs, so browsing the repository explains it; the questions
 * are where a refactoring decision is waiting.
 *
 * Mechanical: placements, the catalog and what the tests called. Prose about the folder, if
 * any, comes from a model and is kept apart.
 */
import { describe, expect, test } from "vitest";

import { Run } from "@runshape/trace";
import { ZoneRules } from "@runshape/architecture";
import { buildFolderGuides, buildPlacements, FolderGuide } from "../src";
import { loadFixtureRun } from "../../trace/test/fixtures";

function render(guides: FolderGuide[], only: string): string[] {
  const guide = guides.find((g) => g.folder === only)!;
  return [
    `${guide.folder}: ${guide.zone ?? "no zone"}`,
    ...guide.files.map((f) => `  ${f.name}${f.seen ? "" : " (not seen running)"}: ${f.zones.join("+") || "-"}; classes ${f.classes.map((c) => `${c.name}[${c.zone}]`).join(", ") || "-"}; ${f.functionCount} functions, entry points ${f.functions.map((fn) => `${fn.name}×${fn.calls}`).join(", ") || "-"}`),
    ...guide.questions.map((q) => `  ? ${q}`),
  ];
}

describe("buildFolderGuides", () => {
  test("a folder of route modules: its files, their zones, the functions the tests called most, and the file nothing ran", async () => {
    const run = await loadFixtureRun("fastapi");
    const snapshot = buildPlacements(run, ZoneRules.none());
    const onDisk = [...new Set(run.catalog.map((fn) => fn.file)), "app/services/unused.py"];

    const guides = buildFolderGuides(run, snapshot, onDisk);

    expect(guides.map((g) => g.folder)).toMatchInlineSnapshot(`
      [
        "app",
        "app/api/dependencies",
        "app/api/errors",
        "app/api/routes",
        "app/api/routes/articles",
        "app/core",
        "app/core/settings",
        "app/db",
        "app/db/queries",
        "app/db/repositories",
        "app/models",
        "app/models/domain",
        "app/services",
      ]
    `);
    expect(render(guides, "app/services")).toMatchInlineSnapshot(`
      [
        "app/services: core",
        "  articles.py: core; classes -; 3 functions, entry points check_article_exists×2, get_slug_for_article×2",
        "  authentication.py: core; classes -; 2 functions, entry points check_email_is_taken×1, check_username_is_taken×1",
        "  comments.py (not seen running): -; classes -; 1 functions, entry points -",
        "  jwt.py: core; classes -; 3 functions, entry points create_access_token_for_user×4, get_username_from_token×3",
        "  security.py: core; classes -; 3 functions, entry points generate_salt×9, get_password_hash×9, verify_password×1",
        "  unused.py (not seen running): -; classes -; 0 functions, entry points -",
        "  ? comments.py wasn't seen running in the recorded tests: untested, or no longer used?",
        "  ? unused.py wasn't seen running in the recorded tests: untested, or no longer used?",
      ]
    `);
  });

  test("a file the recording read but found no functions in (types, re-exports, a script's top level) raises no question", async () => {
    const run = await loadFixtureRun("go-shop");
    const declarations = new Run(run.root, run.createdAt, run.language, run.runtime, run.backend, run.topology, run.catalog, run.scenarios, run.problems, run.recorderVersion, new Map([...(run.sources ?? []), ["internal/web/types.go", ["package web", "", "type Status int"]]]));
    const onDisk = [...new Set(run.catalog.map((fn) => fn.file)), "internal/web/types.go", "internal/web/never_loaded.go"];

    const web = buildFolderGuides(declarations, buildPlacements(declarations, ZoneRules.none()), onDisk).find((g) => g.folder === "internal/web")!;

    expect({
      files: web.files.map((f) => `${f.name}: ${f.seen ? "ran" : f.declarationsOnly ? "declarations only" : "not seen running"}`),
      questions: web.questions.filter((q) => !q.startsWith("handler.go")),
    }).toEqual({
      files: ["handler.go: ran", "never_loaded.go: not seen running", "types.go: declarations only"],
      questions: ["never_loaded.go wasn't seen running in the recorded tests: untested, or no longer used?"],
    });
  });

  test("a Go package is a folder: its files share the package's place", async () => {
    const run = await loadFixtureRun("go-shop");
    const guides = buildFolderGuides(run, buildPlacements(run, ZoneRules.none()), [...new Set(run.catalog.map((fn) => fn.file))]);

    expect(render(guides, "internal/web")).toMatchInlineSnapshot(`
      [
        "internal/web: inbound-adapter",
        "  handler.go: inbound-adapter+core; classes Handler[inbound-adapter], statusRecorder[core]; 6 functions, entry points Handler.ServeHTTP×5, NewHandler×4",
        "  ? handler.go holds more than one kind of code: Inbound adapters (Handler) and Core (statusRecorder). Split it?",
      ]
    `);
  });
});
