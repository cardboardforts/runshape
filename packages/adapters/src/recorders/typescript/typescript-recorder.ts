import { spawn } from "node:child_process";
import { join } from "node:path";

import { Hashing, Recorder, RecordTarget, TestConfig } from "@runshape/kernel";

import { RecorderFiles, recorderSource } from "../recorder-source";

/** The recorder's own source, and the lockfile its dependencies come from; its tests and dependencies don't change what it records. */
export const TYPESCRIPT_RECORDER: RecorderFiles = { directories: ["recorder-ts"], skipped: new Set(["node_modules", "test"]), files: ["package-lock.json"] };

/**
 * What the TypeScript recorder's vitest config reads (recorder-ts/vitest.record.config.ts):
 * nothing when the project sets nothing, so Runshape records its own packages as it always has.
 */
export function vitestEnvironment(config: TestConfig): Record<string, string> {
  return {
    ...(config.source.length > 0 ? { RUNSHAPE_INCLUDE: config.source.join(",") } : {}),
    ...(config.tests.length > 0 ? { RUNSHAPE_TESTS: config.tests.join(",") } : {}),
  };
}

/** Records with the TypeScript recorder's script (recorder-ts/record-tree.sh), its output passed through. */
export class TypeScriptRecorder implements Recorder {
  readonly environment = "host";

  constructor(
    /** Runshape's checkout, where the recorder and its vitest are. */
    private readonly home: string,
    /** The project's root. */
    private readonly root: string,
    private readonly config: TestConfig,
    private readonly hashing: Hashing,
  ) {}

  source(): Promise<string> {
    return recorderSource(this.hashing, this.home, TYPESCRIPT_RECORDER, this.config);
  }

  record(target: RecordTarget, outDirectory: string): Promise<void> {
    const args = [join(this.home, "recorder-ts", "record-tree.sh"), target.kind === "working" ? "--working" : target.commit, outDirectory];
    return new Promise((resolve, reject) => {
      const child = spawn("sh", args, { cwd: this.root, env: { ...process.env, ...vitestEnvironment(this.config) }, stdio: ["ignore", "inherit", "inherit"] });
      child.on("error", reject);
      child.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(signal ? `stopped by ${signal}` : `record-tree.sh exited with ${code}`))));
    });
  }
}
