import { Run } from "./model";
import { LoadedScenario, parseRun, TraceFormatError } from "./parse";
import { ManifestDto, ScenarioDto } from "./wire";

/** Port: read a text file, by path relative to a traces directory (.runshape/traces). */
export interface TraceFiles {
  readText(relativePath: string): Promise<string>;
}

export const LATEST_POINTER = "latest.json";
export const PREVIOUS_POINTER = "previous.json";

export const HOW_TO_RECORD = "record one by running your tests with `pytest --runshape` (see the Runshape README)";

export async function loadLatestRun(files: TraceFiles): Promise<Run> {
  let pointerText: string;
  try {
    pointerText = await files.readText(LATEST_POINTER);
  } catch (error) {
    throw new TraceFormatError([`no recording found (${describe(error)}); ${HOW_TO_RECORD}`]);
  }
  const pointer = parseJson<{ run?: unknown }>(pointerText, LATEST_POINTER);
  if (typeof pointer.run !== "string" || pointer.run === "") {
    throw new TraceFormatError([`${LATEST_POINTER} does not name a run directory`]);
  }
  return loadRun(files, pointer.run);
}

/** The run before the latest one, to compare against; null when there has been only one. */
export async function loadPreviousRun(files: TraceFiles): Promise<Run | null> {
  let pointerText: string;
  try {
    pointerText = await files.readText(PREVIOUS_POINTER);
  } catch {
    return null;
  }
  const pointer = parseJson<{ run?: unknown }>(pointerText, PREVIOUS_POINTER);
  if (typeof pointer.run !== "string" || pointer.run === "") {
    throw new TraceFormatError([`${PREVIOUS_POINTER} does not name a run directory`]);
  }
  return loadRun(files, pointer.run);
}

export async function loadRun(files: TraceFiles, runDirectory: string): Promise<Run> {
  const manifest = await readJson<ManifestDto>(files, `${runDirectory}/manifest.json`);
  const loaded: LoadedScenario[] = [];
  const unreadable: string[] = [];
  for (const entry of manifest.scenarios ?? []) {
    const path = `${runDirectory}/${entry.file}`;
    try {
      loaded.push({ file: path, dto: await readJson<ScenarioDto>(files, path) });
    } catch (error) {
      unreadable.push(`skipped ${path}: ${describe(error)}`);
    }
  }
  const run = parseRun(manifest, loaded);
  run.problems.push(...unreadable);
  return run;
}

async function readJson<T>(files: TraceFiles, path: string): Promise<T> {
  let text: string;
  try {
    text = await files.readText(path);
  } catch (error) {
    throw new TraceFormatError([`could not read ${path}: ${describe(error)}`]);
  }
  return parseJson<T>(text, path);
}

function parseJson<T>(text: string, path: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new TraceFormatError([`${path} is not valid JSON: ${describe(error)}`]);
  }
}

function describe(error: unknown): string {
  if (error instanceof TraceFormatError) return error.problems.join("; ");
  return error instanceof Error ? error.message : String(error);
}
