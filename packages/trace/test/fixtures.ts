import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadLatestRun, Run, TraceFiles } from "../src";

const FIXTURES = join(import.meta.dirname, "fixtures");

/** Real traces recorded from the example apps (see examples/record.sh), not hand-written. */
export type FixtureApp = "django" | "fastapi" | "django-feed-fix" | "fastapi-slug-refactor" | "go-shop";

export function fixtureFiles(app: FixtureApp): TraceFiles {
  return { readText: (relativePath) => readFile(join(FIXTURES, app, relativePath), "utf8") };
}

export function loadFixtureRun(app: FixtureApp): Promise<Run> {
  return loadLatestRun(fixtureFiles(app));
}
