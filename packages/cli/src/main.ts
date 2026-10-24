// runshape-review-md [traces directory]: the behaviour review of the latest recording against
// the previous one (as runshape-review leaves them), as Markdown for a pull request comment.
import { resolve } from "node:path";

import { comparedGraphs } from "@runshape/architecture";
import { TraceDirectory } from "@runshape/core";
import { buildReview, reviewMarkdown } from "@runshape/trace";
import { NodeFiles } from "@runshape/infra";

const DEFAULT_TRACES = ".runshape/traces";

export async function reviewFromDirectory(tracesDirectory: string): Promise<string> {
  const runs = new TraceDirectory(new NodeFiles(tracesDirectory));
  const head = await runs.latest();
  const base = await runs.previous();
  if (base === null) {
    throw new Error(`${tracesDirectory} has only one recording; run runshape-review --base <ref> to record a base to compare with`);
  }
  return reviewMarkdown(buildReview(base, head, comparedGraphs(base, head)));
}

export async function main(argv: string[]): Promise<number> {
  const directory = resolve(argv[0] ?? DEFAULT_TRACES);
  try {
    process.stdout.write(await reviewFromDirectory(directory));
    return 0;
  } catch (error) {
    process.stderr.write(`runshape-review-md: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
