// Asks a ViewerSession every UI request the viewer can make, for every fixture, and writes the
// responses: what the webview would show, as JSON. view-diff.sh runs this against two
// revisions of core so a refactor is reviewed by what the viewer shows, not just by its code.
//
// CORE_SRC picks the revision (a worktree's packages/kernel/src, or packages/core/src before the rename); FIXTURES stays the working
// tree's, so both revisions answer the same recordings.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

const CORE_SRC = required("CORE_SRC");
const FIXTURES = required("FIXTURES");
const OUT = required("DUMP_OUT");

const APPS = ["django", "fastapi", "django-feed-fix", "fastapi-slug-refactor"];
const PHASE_SETS = { call: ["call"], all: ["setup", "call", "teardown"] };
const GROUPINGS = { fine: { collapseMiddleware: false }, coarse: { collapseMiddleware: true } };

// Catalog entries named every way core has named them, so older revisions dump too.
const moduleOf = (fn: any): string => fn.symbol?.namespaceName?.text ?? fn.symbol?.dottedNamespace ?? fn.module;
const qualnameOf = (fn: any): string => fn.symbol?.localName?.text ?? fn.symbol?.dottedPath ?? fn.qualname;
/** Function requests in both shapes: Python names (before the protocol carried keys) and the key. */
const naming = (fn: any) => ({ module: moduleOf(fn), qualname: qualnameOf(fn), symbol: fn.symbol?.key });

/**
 * Answers in the shape both advice parsers accept, with the prompt it was given as the reason,
 * so the prompts (and the source they quote) land in the dump.
 */
const echoAdvisor = {
  available: true,
  complete: async (prompt: string) => JSON.stringify({ zone: "core", style: "hexagonal", confidence: "low", reason: prompt, zones: [{ match: "app.**", zone: "core" }] }),
};

test("dump every view", async () => {
  // Through the kernel's index, and the packages Phase 0b moved things to, where the revision has
  // them: modules move between packages, these indexes keep exporting them.
  const packages = join(CORE_SRC, "..", "..");
  const exported: Record<string, any> = { ...(await import(join(CORE_SRC, "index.ts"))) };
  for (const name of ["trace", "architecture", "workflows", "visualizer"]) {
    const index = join(packages, name, "src", "index.ts");
    if (existsSync(index)) Object.assign(exported, await import(index));
  }
  const { ViewerSession, PROFILES, TraceDirectory, loadLatestRun, loadPreviousRun } = exported;
  const phases = PHASE_SETS.call;
  const responses: Record<string, unknown> = {};

  for (const app of APPS) {
    const files = { readText: (path: string) => readFile(join(FIXTURES, app, path), "utf8") };
    // "<app>-<change>" fixtures share the app's source, as in the webview demo; django has none.
    const sourceRoot = join(FIXTURES, app.split("-")[0]!, "source");
    const sources = { readLines: (file: string) => readFile(join(sourceRoot, file), "utf8").then((text) => text.split("\n"), () => null) };
    // Runs loaded the way each revision loads them: a TraceDirectory, or the functions before it.
    const runs = TraceDirectory ? new TraceDirectory(files) : { latest: () => loadLatestRun(files), previous: () => loadPreviousRun(files) };
    const run = await runs.latest();
    const baseline = await runs.previous();
    const session = new ViewerSession(run, { sources, baseline, advisor: echoAdvisor, ruleStore: { save: async () => true } });
    const ask = async (label: string, request: unknown) => {
      try {
        responses[`${app} ${label}`] = await session.handle(request);
      } catch (error) {
        responses[`${app} ${label}`] = { threw: String(error) };
      }
    };

    for (const [name, grouping] of Object.entries(GROUPINGS)) {
      await ask(`graph ${name}`, { type: "graph", phases, grouping });
      await ask(`graph ${name} all-phases`, { type: "graph", phases: PHASE_SETS.all, grouping });
      // The canvas came as a graph before Phase 3, as a layout since: both list the boxes.
      const graph = responses[`${app} graph ${name}`] as { graph?: { nodes: { id: string }[] }; layout?: { nodes: { id: string }[] } };
      for (const node of graph.layout?.nodes ?? graph.graph?.nodes ?? []) {
        await ask(`component ${name} ${node.id}`, { type: "component", id: node.id, grouping });
        await ask(`adviseZone ${name} ${node.id}`, { type: "adviseZone", componentId: node.id, grouping });
      }
      for (const { style } of PROFILES) {
        await ask(`graph ${name} as ${style}`, { type: "graph", phases, grouping, style });
        if (baseline) await ask(`diff ${name} as ${style}`, { type: "diff", phases, grouping, style });
      }
      if (baseline) await ask(`diff ${name}`, { type: "diff", phases, grouping });
      for (const { nodeid } of run.scenarios) {
        await ask(`timeline ${name} all-phases ${nodeid}`, { type: "timeline", scenarioId: nodeid, phases: PHASE_SETS.all, grouping });
        await ask(`replay ${name} ${nodeid}`, { type: "replay", scenarioId: nodeid, phases, grouping });
        await ask(`timeline ${name} ${nodeid}`, { type: "timeline", scenarioId: nodeid, phases, grouping });
        if (baseline) await ask(`executionDiff ${name} ${nodeid}`, { type: "executionDiff", scenarioId: nodeid, phases, grouping });
      }
    }
    for (const fn of run.catalog) {
      const [module, qualname] = [moduleOf(fn), qualnameOf(fn)];
      await ask(`function ${module}:${qualname}`, { type: "function", ...naming(fn) });
      if (!baseline) continue;
      for (const { nodeid } of run.scenarios) {
        await ask(`functionExecutionDiff ${nodeid} ${module}:${qualname}`, { type: "functionExecutionDiff", scenarioId: nodeid, ...naming(fn), phases });
      }
    }
    await ask("function not in the catalog", { type: "function", module: "nowhere", qualname: "nothing", symbol: JSON.stringify([["nowhere"], [], "nothing"]) });
    for (const { nodeid } of run.scenarios) await ask(`objects ${nodeid}`, { type: "objects", scenarioId: nodeid });
    await ask("routes", { type: "routes", phases, compare: false });
    await ask("routes all-phases", { type: "routes", phases: PHASE_SETS.all, compare: false });
    if (baseline) await ask("routes compare", { type: "routes", phases, compare: true });
    await ask("detectArchitecture", { type: "detectArchitecture" });
    await ask("adviseArchitecture", { type: "adviseArchitecture" });
    await ask("adopt the model's proposal", { type: "adoptArchitecture", style: "hexagonal", from: "model" });
    // A person places one box by hand: an exact-name rule, first in the file.
    type Boxes = { nodes: { qualifiedName: string | null; zoneSource: string }[] };
    const fine = responses[`${app} graph fine`] as { graph?: Boxes; layout?: Boxes };
    const placeable = (fine.layout ?? fine.graph)?.nodes.find(
      (node) => node.qualifiedName !== null && node.zoneSource !== "fixed",
    );
    if (placeable) {
      await ask("setZone", { type: "setZone", qualifiedName: placeable.qualifiedName, zone: "core", reason: "placed by hand", by: "user" });
      await ask("graph after setZone", { type: "graph", phases, grouping: GROUPINGS.fine });
    }
    responses[`${app} summary`] = session.summary();

    // Zone rules, as a person adds them: adopt each detected style's proposal, then redraw.
    const ruled = new ViewerSession(run, { sources, baseline, ruleStore: { save: async () => true } });
    const detected = (await ruled.handle({ type: "detectArchitecture" })) as { candidates?: { style: string }[] };
    for (const { style } of detected.candidates ?? []) {
      responses[`${app} adopt ${style}`] = await ruled.handle({ type: "adoptArchitecture", style, from: "detected" });
      for (const [name, grouping] of Object.entries(GROUPINGS)) {
        responses[`${app} ruledGraph ${style} ${name}`] = await ruled.handle({ type: "graph", phases, grouping });
        if (baseline) responses[`${app} ruledDiff ${style} ${name}`] = await ruled.handle({ type: "diff", phases, grouping });
      }
    }
  }
  await writeFile(OUT, JSON.stringify(responses, null, 1));
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`views.dump.ts: set ${name} (run it through view-diff.sh)`);
  return value;
}
