import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { byCodeUnit, Hashing, TestConfig, VERSION_DIGITS } from "@runshape/kernel";

/** What a recorder's version is made of, in Runshape's checkout. */
export interface RecorderFiles {
  /** Folders whose files are its source, relative to the checkout. */
  directories: string[];
  /** Names skipped at any depth: its tests and installed packages don't change what it records. */
  skipped: Set<string>;
  /** Single files that count too (a lockfile its dependencies come from). */
  files: string[];
}

/**
 * Which version of a recorder, run how, made a recording: its source, and the project's
 * TestConfig (other tests, or other pytest arguments, record something else). In code-unit
 * order: the same on every machine.
 */
export async function recorderSource(hashing: Hashing, home: string, recorder: RecorderFiles, config: TestConfig): Promise<string> {
  const hash = hashing.digest();
  for (const file of recorder.files) hash.update(await readFile(join(home, file)).catch(() => new Uint8Array(0))).update("\0");
  const walk = async (directory: string, relative: string): Promise<void> => {
    const entries = await readdir(join(directory, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => byCodeUnit(a.name, b.name))) {
      if (recorder.skipped.has(entry.name)) continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await walk(directory, path);
      else if (entry.isFile()) hash.update(path).update("\0").update(await readFile(join(directory, path))).update("\0");
    }
  };
  for (const directory of recorder.directories) await walk(join(home, directory), "");
  // chosenBy says why, not how: a project detected as Python records the same as one declared so.
  const { chosenBy: _why, ...how } = config;
  hash.update(JSON.stringify(how));
  return hash.hex().slice(0, VERSION_DIGITS);
}
