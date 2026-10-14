// vitest globalSetup: makes the run directory before the tests, writes the manifest after.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { instrument } from "./instrument";
import type { ScenarioDto } from "./runtime";

export default function setup(): () => void {
  const root = process.env.RUNSHAPE_TARGET!;
  const out = process.env.RUNSHAPE_OUT!;
  const run = process.env.RUNSHAPE_RUN ?? new Date().toISOString().replace(/[:.]/g, "-");
  const include = (process.env.RUNSHAPE_INCLUDE ?? "").split(",").filter(Boolean);
  const runDirectory = join(out, run);
  rmSync(runDirectory, { recursive: true, force: true });
  mkdirSync(join(runDirectory, "scenarios"), { recursive: true });
  process.env.RUNSHAPE_RUN_DIR = runDirectory;
  const createdAt = new Date().toISOString();

  return () => {
    const catalog = [];
    const sources: Record<string, string[]> = {};
    const catalogProblems: { file: string; reason: string }[] = [];
    for (const directory of include) {
      for (const file of sourceFiles(join(root, directory))) {
        const relativeFile = relative(root, file).split(sep).join("/");
        const text = readFileSync(file, "utf8");
        sources[relativeFile] = text.split("\n");
        try {
          for (const { symbol, firstLine, lastLine, lines } of instrument(relativeFile, text).functions) {
            catalog.push({ file: relativeFile, symbol, firstLine, lastLine, lines });
          }
        } catch (error) {
          catalogProblems.push({ file: relativeFile, reason: String(error) });
        }
      }
    }
    const scenarioFiles = readdirSync(join(runDirectory, "scenarios")).sort((a, b) => (BigInt(a.slice(0, -5)) < BigInt(b.slice(0, -5)) ? -1 : 1));
    const scenarios = scenarioFiles.map((name) => {
      const scenario = JSON.parse(readFileSync(join(runDirectory, "scenarios", name), "utf8")) as ScenarioDto;
      return {
        nodeid: scenario.nodeid,
        file: `scenarios/${name}`,
        outcome: scenario.outcome,
        durationUs: scenario.durationUs,
        eventCount: scenario.events.length,
        recorderErrors: scenario.recorderErrors.length,
      };
    });
    const manifest = {
      format: "runshape-trace",
      version: 2,
      createdAt,
      language: "typescript",
      runtime: `node ${process.versions.node}`,
      recorder: "recorder-ts 0.1.0",
      backend: "instrument",
      root,
      framework: null,
      catalog,
      sources,
      catalogProblems,
      sessionProblems: [],
      scenarios,
    };
    writeFileSync(join(runDirectory, "manifest.json"), JSON.stringify(manifest));
  };
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files.sort();
}
