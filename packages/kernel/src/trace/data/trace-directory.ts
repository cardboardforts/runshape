import { RunSource } from "../model/run-source";
import { Run } from "../model/trace";
import { RunParser, TraceFormatError } from "./parse";
import { ManifestDto, ScenarioDto } from "./wire";

/**
 * Port: the text of a file, by path relative to a traces directory (.runshape/traces).
 * Declared here, where it's needed; infra's file stores fit it without importing trace.
 */
export interface TraceFiles {
  readText(relativePath: string): Promise<string>;
}

export const LATEST_POINTER = "latest.json";
export const PREVIOUS_POINTER = "previous.json";

/** Whichever recorder made it: each says how it's run (test-config.ts). */
const ANY_RECORDER = `record one with \`npm run runshape -- record working\`, which picks the project's recorder (Python: \`pytest --runshape\`; Go: \`npm run record-go -- <module>\`)`;

/**
 * A traces directory as the recorders write it (docs/trace-format.md): pointer files naming
 * the latest and previous run directories, each a manifest and one file per scenario.
 */
export class TraceDirectory implements RunSource {
  constructor(
    private readonly files: TraceFiles,
    /** What "no recording found" suggests: the project's own recorder's HOW_TO_RECORD, when it's known. */
    private readonly howToRecord: string = ANY_RECORDER,
  ) {}

  async latest(): Promise<Run> {
    let pointerText: string;
    try {
      pointerText = await this.files.readText(LATEST_POINTER);
    } catch (error) {
      throw new TraceFormatError([`no recording found (${describe(error)}); ${this.howToRecord}`]);
    }
    return this.load(runDirectoryIn(pointerText, LATEST_POINTER));
  }

  async previous(): Promise<Run | null> {
    let pointerText: string;
    try {
      pointerText = await this.files.readText(PREVIOUS_POINTER);
    } catch {
      return null;
    }
    return this.load(runDirectoryIn(pointerText, PREVIOUS_POINTER));
  }

  private async load(runDirectory: string): Promise<Run> {
    const manifest = await this.readJson<ManifestDto>(`${runDirectory}/manifest.json`);
    const parser = new RunParser(manifest);
    const unreadable: string[] = [];
    // One scenario's text and wire objects at a time: a big suite's run is hundreds of megabytes of JSON.
    for (const entry of manifest.scenarios ?? []) {
      const path = `${runDirectory}/${entry.file}`;
      let dto: ScenarioDto;
      try {
        dto = await this.readJson<ScenarioDto>(path);
      } catch (error) {
        unreadable.push(`skipped ${path}: ${describe(error)}`);
        continue;
      }
      parser.add(path, dto);
    }
    const run = parser.finish();
    run.problems.push(...unreadable);
    return run;
  }

  private async readJson<T>(path: string): Promise<T> {
    let text: string;
    try {
      text = await this.files.readText(path);
    } catch (error) {
      throw new TraceFormatError([`could not read ${path}: ${describe(error)}`]);
    }
    return parseJson<T>(text, path);
  }
}

function runDirectoryIn(pointerText: string, pointerFile: string): string {
  const pointer = parseJson<{ run?: unknown }>(pointerText, pointerFile);
  if (typeof pointer.run !== "string" || pointer.run === "") {
    throw new TraceFormatError([`${pointerFile} does not name a run directory`]);
  }
  return pointer.run;
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
