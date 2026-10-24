import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { TraceDirectory } from "@runshape/core";
import { NodeFiles } from "@runshape/infra";
import { reviewFromDirectory } from "../src/main";

const FIXTURES = join(import.meta.dirname, "..", "..", "core", "test", "fixtures");

describe("runshape-review-md", () => {
  test("reviews the latest recording against the previous one", async () => {
    const markdown = await reviewFromDirectory(join(FIXTURES, "fastapi-slug-refactor"));

    expect(markdown.split("\n").slice(0, 5)).toEqual([
      "## Behaviour changes (Runshape)",
      "",
      "4 tests ran on both the base and this branch.",
      "",
      "**2 tests still pass but now run differently** — the changes a green CI won't show you.",
    ]);
  });

  test("with a single recording it says how to make a base", async () => {
    await expect(reviewFromDirectory(join(FIXTURES, "django"))).rejects.toThrowError(/run runshape-review --base <ref>/);
  });
});

describe("a traces directory written by someone else", () => {
  // Recordings can come from anyone who can commit or open a PR. The CLI reads them the way it
  // reads its own: through NodeFiles, which refuses a path that climbs out of the directory.
  async function tracesWith(pointer: string, scenarioFile: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "runshape-cli-"));
    const traces = join(root, "traces");
    await mkdir(join(traces, "r1"), { recursive: true });
    await writeFile(join(root, "secret.json"), '{"token": "do-not-read"}');
    await writeFile(join(traces, "latest.json"), JSON.stringify({ run: pointer }));
    const manifest = { format: "runshape-trace", version: 1, createdAt: "2026-10-19T00:00:00Z", backend: "settrace", scenarios: [{ file: scenarioFile }] };
    await writeFile(join(traces, "r1", "manifest.json"), JSON.stringify(manifest));
    return traces;
  }

  test("a manifest naming a scenario outside the directory: skipped, never read, and said why", async () => {
    const run = await new TraceDirectory(new NodeFiles(await tracesWith("r1", "../../secret.json"))).latest();

    expect(run.scenarios).toEqual([]);
    expect(run.problems).toEqual(["skipped r1/../../secret.json: could not read r1/../../secret.json: refusing a path outside its directory: r1/../../secret.json"]);
  });

  test("a pointer naming a run outside the directory: the whole recording is refused", async () => {
    await expect(new TraceDirectory(new NodeFiles(await tracesWith("../", "s.json"))).latest()).rejects.toThrowError(
      "could not read ..//manifest.json: refusing a path outside its directory",
    );
  });
});
