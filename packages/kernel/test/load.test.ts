/**
 * Loading follows the service's error rules: a manifest we can't read is fatal (say exactly
 * why), while one bad scenario file is skipped and reported so the rest still show.
 */
import { describe, expect, test } from "vitest";

import { TraceDirectory, TraceFiles } from "../src";
import { HOW_TO_RECORD, TraceFormatError } from "../src";
import { fixtureFiles, fixtureRuns } from "./fixtures";

function filesWith(overrides: Record<string, string | Error>, fallback: TraceFiles): TraceFiles {
  return {
    async readText(path) {
      const override = overrides[path];
      if (override instanceof Error) throw override;
      return override ?? fallback.readText(path);
    },
  };
}

describe("TraceDirectory", () => {
  test("follows latest.json to the newest run and parses every scenario", async () => {
    const run = await fixtureRuns("django").latest();

    expect({
      backend: run.backend,
      framework: run.topology?.framework,
      scenarios: run.scenarios.map((s) => `${s.outcome} ${s.name}`),
      problems: run.problems,
    }).toMatchInlineSnapshot(`
      {
        "backend": "monitoring",
        "framework": "django",
        "problems": [],
        "scenarios": [
          "passed test_visitor_registers_an_account",
          "passed test_member_logs_in_and_reads_their_profile",
          "passed test_author_publishes_a_tagged_article",
          "passed test_reader_browses_articles_by_tag",
          "passed test_reader_favorites_and_comments_on_an_article",
          "passed test_reader_follows_an_author",
          "xfailed test_follower_sees_followed_authors_in_their_feed",
          "passed test_anonymous_visitor_cannot_publish",
        ],
      }
    `);
  });

  test("a manifest from an incompatible recorder fails with every reason at once", async () => {
    const django = fixtureFiles("django");
    const manifest = JSON.parse(await django.readText("run/manifest.json"));
    const files = filesWith(
      { "run/manifest.json": JSON.stringify({ ...manifest, format: "something-else", version: 99 }) },
      django,
    );

    await expect(new TraceDirectory(files).latest()).rejects.toThrowError(TraceFormatError);
    await expect(new TraceDirectory(files).latest()).rejects.toThrowErrorMatchingInlineSnapshot(`
      [Error: not a readable runshape trace:
        - format is "something-else", expected "runshape-trace"
        - version 99 is not supported (this viewer reads versions 1 and 2)]
    `);
  });

  test("an unreadable or corrupt scenario is skipped and reported; the others still load", async () => {
    const files = filesWith(
      {
        "run/scenarios/0001.json": "{ not json",
        "run/scenarios/0002.json": new Error("EACCES: permission denied"),
      },
      fixtureFiles("django"),
    );

    const run = await new TraceDirectory(files).latest();

    expect(run.scenarios).toHaveLength(6);
    expect(run.problems).toMatchInlineSnapshot(`
      [
        "skipped run/scenarios/0001.json: run/scenarios/0001.json is not valid JSON: Expected property name or '}' in JSON at position 2 (line 1 column 3)",
        "skipped run/scenarios/0002.json: could not read run/scenarios/0002.json: EACCES: permission denied",
      ]
    `);
  });

  /**
   * Recording Runshape's own suite gives 381 scenarios and four million spans; held as
   * written, that's over 3 GB and Node's default heap runs out. Every scenario names the
   * functions it called again, so the run keeps one CodeSymbol per function, and each scenario
   * file is read, parsed and let go before the next. A span keeps a list only when it has
   * something in it, so a leaf call's children are the one shared empty list.
   */
  test("a run keeps one copy of what its scenarios repeat", async () => {
    const run = await fixtureRuns("django").latest();
    const symbolsByKey = new Map<string, Set<unknown>>();
    let leaves = 0;
    const emptyChildLists = new Set<unknown>();
    for (const scenario of run.scenarios) {
      for (const span of scenario.spans) {
        const copies = symbolsByKey.get(span.fn.symbol.key) ?? new Set();
        copies.add(span.fn.symbol);
        symbolsByKey.set(span.fn.symbol.key, copies);
        if (span.children.length === 0) {
          leaves += 1;
          emptyChildLists.add(span.children);
        }
      }
    }
    const calledInSeveral = [...symbolsByKey.keys()].filter((key) => run.scenarios.filter((s) => s.spans.some((span) => span.fn.symbol.key === key)).length > 1);

    expect(calledInSeveral.length, "functions more than one scenario called").toBeGreaterThan(10);
    expect(calledInSeveral.filter((key) => symbolsByKey.get(key)!.size > 1), "functions with more than one CodeSymbol").toEqual([]);
    expect(run.catalog.every((fn) => !symbolsByKey.has(fn.symbol.key) || symbolsByKey.get(fn.symbol.key)!.has(fn.symbol)), "the catalog shares them too").toBe(true);
    expect({ leaves: leaves > 0, emptyChildLists: emptyChildLists.size }).toEqual({ leaves: true, emptyChildLists: 1 });
  });

  test("a missing traces folder explains what to run: the project's own recorder when it's known, else every one", async () => {
    const files: TraceFiles = { readText: async () => Promise.reject(new Error("ENOENT: no such file")) };
    const reason = (directory: TraceDirectory) => directory.latest().catch((error: Error) => error.message.split("\n").pop());

    expect([await reason(new TraceDirectory(files)), await reason(new TraceDirectory(files, HOW_TO_RECORD.go))]).toEqual([
      "  - no recording found (ENOENT: no such file); record one with `npm run runshape -- record working`, which picks the project's recorder (Python: `pytest --runshape`; Go: `npm run record-go -- <module>`)",
      "  - no recording found (ENOENT: no such file); record one with `npm run record-go -- <module>` (or `npm run runshape -- record working`)",
    ]);
  });
});
