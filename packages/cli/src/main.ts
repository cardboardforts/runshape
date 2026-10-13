// runshape-review-md [traces directory]: the behaviour review of the latest recording against
// the previous one (as runshape-review leaves them), as Markdown for a pull request comment.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildReview, loadLatestRun, loadPreviousRun, reviewMarkdown, TraceFiles } from "@runshape/core";

const DEFAULT_TRACES = ".runshape/traces";

export async function reviewFromDirectory(tracesDirectory: string): Promise<string> {
  const files: TraceFiles = { readText: (path) => readFile(join(tracesDirectory, path), "utf8") };
  const head = await loadLatestRun(files);
  const base = await loadPreviousRun(files);
  if (base === null) {
    throw new Error(`${tracesDirectory} has only one recording; run runshape-review --base <ref> to record a base to compare with`);
  }
  return reviewMarkdown(buildReview(base, head));
}

async function main(argv: string[]): Promise<number> {
  const directory = resolve(argv[0] ?? DEFAULT_TRACES);
  try {
    process.stdout.write(await reviewFromDirectory(directory));
    return 0;
  } catch (error) {
    process.stderr.write(`runshape-review-md: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1]?.endsWith("runshape-review-md.mjs")) {
  process.exitCode = await main(process.argv.slice(2));
}
