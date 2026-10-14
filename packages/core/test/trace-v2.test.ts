/**
 * Trace format version 2 names code by segments ({namespace, container, name, kind, ownerType})
 * instead of Python's module and qualname, and says which language and runtime recorded it, so
 * recorders for other languages can write it. Version 1 (the Python recorder's) is still read.
 *
 * The same recording written both ways must draw the same: these tests rewrite real v1
 * recordings as v2 and compare what the views make of each.
 */
import { describe, expect, test } from "vitest";

import { Run } from "../src/model";
import { loadLatestRun, loadPreviousRun, TraceFiles } from "../src/trace/load";
import { pythonSymbol } from "../src/trace/parse";
import { ManifestDto, ScenarioDto } from "../src/trace/wire";
import { diffRuns } from "../src/views/run-diff";
import { buildSystemGraph } from "../src/views/system-graph";
import { FixtureApp, fixtureFiles } from "./fixtures";

/** A v1 trace directory, served as v2: what a recorder writing v2 would have produced. */
function asVersion2(v1: TraceFiles): TraceFiles {
  const symbolDto = (module: string, qualname: string) => {
    const { namespace, container, name, kind, ownerType } = pythonSymbol(module, qualname);
    return { namespace, container, name, kind, ownerType };
  };
  return {
    async readText(path) {
      const text = await v1.readText(path);
      if (path.endsWith("manifest.json")) {
        const { python, catalog, framework, ...rest } = JSON.parse(text) as ManifestDto & { python: string };
        return JSON.stringify({
          ...rest,
          version: 2,
          language: "python",
          runtime: python,
          catalog: catalog.map(({ module, qualname, ...fn }: any) => ({ ...fn, symbol: symbolDto(module, qualname) })),
          framework: framework && { ...framework, routes: framework.routes.map((route: any) => ({ ...route, handler: route.handler.split(".") })) },
        });
      }
      if (path.includes("/scenarios/")) {
        const scenario = JSON.parse(text) as ScenarioDto;
        return JSON.stringify({
          ...scenario,
          functions: scenario.functions.map(({ key, module, qualname, ...fn }: any) => ({ ...fn, symbol: symbolDto(module, qualname) })),
          events: scenario.events.map((event: any[]) => (event[0] === "O" ? [...event.slice(0, 3), event[3].split("."), event[4]] : event)),
        });
      }
      return text;
    },
  };
}

async function bothVersions(app: FixtureApp): Promise<{ v1: Run; v2: Run; v1Before: Run | null; v2Before: Run | null }> {
  const files = fixtureFiles(app);
  return {
    v1: await loadLatestRun(files),
    v2: await loadLatestRun(asVersion2(files)),
    v1Before: await loadPreviousRun(files),
    v2Before: await loadPreviousRun(asVersion2(files)),
  };
}

describe("trace format version 2", () => {
  test("a recording written as v2 draws exactly what its v1 form draws", async () => {
    for (const app of ["fastapi", "django"] as const) {
      const { v1, v2 } = await bothVersions(app);
      expect(v2.problems, app).toEqual([]);
      for (const grouping of [{ collapseMiddleware: false }, { collapseMiddleware: true }]) {
        expect(JSON.stringify(buildSystemGraph(v2, { grouping })), `${app} graph`).toBe(JSON.stringify(buildSystemGraph(v1, { grouping })));
      }
    }
  });

  test("and compares the same: the Django routing fix still changes one journey", async () => {
    const { v1, v2, v1Before, v2Before } = await bothVersions("django-feed-fix");

    expect(JSON.stringify(diffRuns(v2Before!, v2))).toBe(JSON.stringify(diffRuns(v1Before!, v1)));
  });

  test("the run says which language and runtime recorded it; v1 recordings are Python", async () => {
    const { v1, v2 } = await bothVersions("fastapi");

    expect([v1, v2].map((run) => `${run.language} ${run.runtime}`)).toEqual(["python 3.9.21", "python 3.9.21"]);
  });
});
