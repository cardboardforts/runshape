/**
 * Loading follows the service's error rules: a manifest we can't read is fatal (say exactly
 * why), while one bad scenario file is skipped and reported so the rest still show.
 */
import { describe, expect, test } from "vitest";

import { loadLatestRun, TraceFiles } from "@runshape/trace";
import { TraceFormatError } from "@runshape/trace";
import { fixtureFiles } from "../../trace/test/fixtures";

function filesWith(overrides: Record<string, string | Error>, fallback: TraceFiles): TraceFiles {
  return {
    async readText(path) {
      const override = overrides[path];
      if (override instanceof Error) throw override;
      return override ?? fallback.readText(path);
    },
  };
}

describe("loadLatestRun", () => {
  test("follows latest.json to the newest run and parses every scenario", async () => {
    const run = await loadLatestRun(fixtureFiles("django"));

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

    await expect(loadLatestRun(files)).rejects.toThrowError(TraceFormatError);
    await expect(loadLatestRun(files)).rejects.toThrowErrorMatchingInlineSnapshot(`
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

    const run = await loadLatestRun(files);

    expect(run.scenarios).toHaveLength(6);
    expect(run.problems).toMatchInlineSnapshot(`
      [
        "skipped run/scenarios/0001.json: run/scenarios/0001.json is not valid JSON: Expected property name or '}' in JSON at position 2 (line 1 column 3)",
        "skipped run/scenarios/0002.json: could not read run/scenarios/0002.json: EACCES: permission denied",
      ]
    `);
  });

  test("a missing traces folder explains what to run", async () => {
    const files: TraceFiles = { readText: async () => Promise.reject(new Error("ENOENT: no such file")) };

    await expect(loadLatestRun(files)).rejects.toThrowErrorMatchingInlineSnapshot(`
      [Error: not a readable runshape trace:
        - no recording found (ENOENT: no such file); record one by running your tests with \`pytest --runshape\` (see the Runshape README)]
    `);
  });
});
