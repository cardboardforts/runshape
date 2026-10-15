import { spawn } from "node:child_process";
import { join } from "node:path";

import { Recorder, RecordTarget } from "./recordings";

/** Records with the TypeScript recorder's script (recorder-ts/record-tree.sh), its output passed through. */
export class ShellRecorder implements Recorder {
  constructor(private readonly root: string) {}

  record(target: RecordTarget, outDirectory: string): Promise<void> {
    const args = [join(this.root, "recorder-ts", "record-tree.sh"), target.kind === "working" ? "--working" : target.commit, outDirectory];
    return new Promise((resolve, reject) => {
      const child = spawn("sh", args, { cwd: this.root, stdio: ["ignore", "inherit", "inherit"] });
      child.on("error", reject);
      child.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(signal ? `stopped by ${signal}` : `record-tree.sh exited with ${code}`))));
    });
  }
}
