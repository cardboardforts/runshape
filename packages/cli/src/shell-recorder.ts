import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { byCodeUnit } from "@runshape/core";

import { Hashing, Recorder, RecordTarget } from "./ports";

/** The recorder's own source; its tests and dependencies don't change what it records. */
const RECORDER_DIRECTORY = "recorder-ts";
const RECORDER_SOURCE_SKIPPED = new Set(["node_modules", "test"]);
/** Enough of the hash to tell two versions apart. */
const SOURCE_DIGITS = 16;

/** Records with the TypeScript recorder's script (recorder-ts/record-tree.sh), its output passed through. */
export class ShellRecorder implements Recorder {
  readonly environment = "host";

  constructor(
    private readonly root: string,
    private readonly hashing: Hashing,
  ) {}

  /**
   * The recorder as it is now: its source, and the lockfile its dependencies come from. In
   * code-unit order: the same on every machine.
   */
  async source(): Promise<string> {
    const hash = this.hashing.digest();
    hash.update(await readFile(join(this.root, "package-lock.json")).catch(() => new Uint8Array(0))).update("\0");
    const directory = join(this.root, RECORDER_DIRECTORY);
    const walk = async (relative: string): Promise<void> => {
      const entries = await readdir(join(directory, relative), { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => byCodeUnit(a.name, b.name))) {
        if (RECORDER_SOURCE_SKIPPED.has(entry.name)) continue;
        const path = join(relative, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) hash.update(path).update("\0").update(await readFile(join(directory, path))).update("\0");
      }
    };
    await walk("");
    return hash.hex().slice(0, SOURCE_DIGITS);
  }

  record(target: RecordTarget, outDirectory: string): Promise<void> {
    const args = [join(this.root, "recorder-ts", "record-tree.sh"), target.kind === "working" ? "--working" : target.commit, outDirectory];
    return new Promise((resolve, reject) => {
      const child = spawn("sh", args, { cwd: this.root, stdio: ["ignore", "inherit", "inherit"] });
      child.on("error", reject);
      child.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(signal ? `stopped by ${signal}` : `record-tree.sh exited with ${code}`))));
    });
  }
}
