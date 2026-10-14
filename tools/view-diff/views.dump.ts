// Asks a ViewerSession every UI request the viewer can make, for every fixture, and writes the
// responses: what the webview would show, as JSON. view-diff.sh runs this against two
// revisions of core so a refactor is reviewed by what the viewer shows, not just by its code.
//
// CORE_SRC picks the revision (a worktree's packages/core/src); FIXTURES stays the working
// tree's, so both revisions answer the same recordings.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

const CORE_SRC = required("CORE_SRC");
const FIXTURES = required("FIXTURES");
const OUT = required("DUMP_OUT");

const APPS = ["django", "fastapi", "django-feed-fix", "fastapi-slug-refactor"];
const GROUPINGS = { fine: { collapseMiddleware: false }, coarse: { collapseMiddleware: true } };

// Catalog entries named both ways (before and after CodeSymbol), so older revisions dump too.
const moduleOf = (fn: any): string => fn.symbol?.dottedNamespace ?? fn.module;
const qualnameOf = (fn: any): string => fn.symbol?.dottedPath ?? fn.qualname;

test("dump every view", async () => {
  const { ViewerSession, Phase } = await import(join(CORE_SRC, "index.ts"));
  const { loadLatestRun, loadPreviousRun } = await import(join(CORE_SRC, "trace/load.ts"));
  const phases = [Phase.Call];
  const noSources = { readLines: async () => null };
  const responses: Record<string, unknown> = {};

  for (const app of APPS) {
    const files = { readText: (path: string) => readFile(join(FIXTURES, app, path), "utf8") };
    const run = await loadLatestRun(files);
    const baseline = await loadPreviousRun(files);
    const session = new ViewerSession(run, { sources: noSources, baseline });
    const ask = async (label: string, request: unknown) => {
      try {
        responses[`${app} ${label}`] = await session.handle(request);
      } catch (error) {
        responses[`${app} ${label}`] = { threw: String(error) };
      }
    };

    for (const [name, grouping] of Object.entries(GROUPINGS)) {
      await ask(`graph ${name}`, { type: "graph", phases, grouping });
      const graph = responses[`${app} graph ${name}`] as { graph?: { nodes: { id: string }[] } };
      for (const node of graph.graph?.nodes ?? []) {
        await ask(`component ${name} ${node.id}`, { type: "component", id: node.id, grouping });
      }
      if (baseline) await ask(`diff ${name}`, { type: "diff", phases, grouping });
      for (const { nodeid } of run.scenarios) {
        await ask(`replay ${name} ${nodeid}`, { type: "replay", scenarioId: nodeid, phases, grouping });
        await ask(`timeline ${name} ${nodeid}`, { type: "timeline", scenarioId: nodeid, phases, grouping });
        if (baseline) await ask(`executionDiff ${name} ${nodeid}`, { type: "executionDiff", scenarioId: nodeid, phases, grouping });
      }
    }
    for (const fn of run.catalog) {
      const [module, qualname] = [moduleOf(fn), qualnameOf(fn)];
      await ask(`function ${module}:${qualname}`, { type: "function", module, qualname });
      if (!baseline) continue;
      for (const { nodeid } of run.scenarios) {
        await ask(`functionExecutionDiff ${nodeid} ${module}:${qualname}`, { type: "functionExecutionDiff", scenarioId: nodeid, module, qualname, phases });
      }
    }
    for (const { nodeid } of run.scenarios) await ask(`objects ${nodeid}`, { type: "objects", scenarioId: nodeid });
    await ask("detectArchitecture", { type: "detectArchitecture" });
    responses[`${app} summary`] = session.summary();
  }
  await writeFile(OUT, JSON.stringify(responses, null, 1));
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`views.dump.ts: set ${name} (run it through view-diff.sh)`);
  return value;
}
