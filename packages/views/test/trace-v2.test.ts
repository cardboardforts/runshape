/**
 * Trace format version 2 names code by segments ({namespace, container, name, kind, ownerType})
 * instead of Python's module and qualname, and says which language and runtime recorded it, so
 * recorders for other languages can write it. Version 1 (the Python recorder's) is still read.
 *
 * The same recording written both ways must draw the same: these tests rewrite real v1
 * recordings as v2 and compare what the views make of each.
 */
import { describe, expect, test } from "vitest";

import { Run } from "@runshape/trace";
import { TraceDirectory, TraceFiles } from "@runshape/trace";
import { pythonSymbol } from "@runshape/trace";
import { ManifestDto, ScenarioDto } from "@runshape/trace";
import { diffRuns } from "../src";
import { buildSystemGraph } from "../src";
import { FixtureApp, fixtureFiles, fixtureRuns } from "../../trace/test/fixtures";

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
    v1: await new TraceDirectory(files).latest(),
    v2: await new TraceDirectory(asVersion2(files)).latest(),
    v1Before: await new TraceDirectory(files).previous(),
    v2Before: await new TraceDirectory(asVersion2(files)).previous(),
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

  test("version 2 input is checked like any other: the manifest is fatal, a bad entry is skipped and named", async () => {
    // A recording is written by whatever recorder, or whoever, committed it (docs/design.md).
    const tampered = (edit: (path: string, data: any) => void): TraceFiles => {
      const v2 = asVersion2(fixtureFiles("fastapi"));
      return {
        async readText(path) {
          const data = JSON.parse(await v2.readText(path));
          edit(path, data);
          return JSON.stringify(data);
        },
      };
    };
    const firstScenario = (path: string) => path.endsWith("/scenarios/0003.json");

    await expect(new TraceDirectory(tampered((path, data) => path.endsWith("manifest.json") && delete data.language)).latest()).rejects.toThrowError(
      /version 2 says which language recorded it: "language" is missing/,
    );
    const badCatalog = await new TraceDirectory(
      tampered((path, data) => {
        if (path.endsWith("manifest.json")) data.catalog[0].symbol.kind = "lambda";
      }),
    ).latest();
    const badScenario = await new TraceDirectory(
      tampered((path, data) => {
        if (path.includes("/scenarios/") && firstScenario(path)) data.functions[0].symbol.namespace = "app.main";
      }),
    ).latest();
    const pythonNamesInV2 = await new TraceDirectory(
      tampered((path, data) => {
        if (path.includes("/scenarios/") && firstScenario(path)) data.functions[0] = { ...data.functions[0], symbol: undefined, module: "app.main", qualname: "f" };
      }),
    ).latest();

    expect([badCatalog, badScenario, pythonNamesInV2].map((run) => run.problems.map((problem) => problem.replace(/^.*\/scenarios\//, "scenarios/")))).toEqual([
      [expect.stringMatching(/^catalog entry 0 \(app\/.*\) skipped: symbol kind "lambda" is not one of function, method, constructor, initializer, nested$/)],
      ["scenarios/0003.json: skipped, function 0: symbol namespace is not a list of strings"],
      ["scenarios/0003.json: skipped, function 0: version 2 names code by symbol, not module and qualname"],
    ]);
    expect(badCatalog.catalog.length).toBe((await fixtureRuns("fastapi").latest()).catalog.length - 1);
  });

  test("the run says which language and runtime recorded it; v1 recordings are Python", async () => {
    const { v1, v2 } = await bothVersions("fastapi");

    expect([v1, v2].map((run) => `${run.language} ${run.runtime}`)).toEqual(["python 3.9.21", "python 3.9.21"]);
  });
});
