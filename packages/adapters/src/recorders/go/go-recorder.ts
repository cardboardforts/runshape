// Records a Go module's tests on this machine with Runshape's recorder (recorder-go/), which
// instruments a copy of the module: the project itself is only read.
import { join } from "node:path";

import { Hashing, Recorder, RecordTarget, TestConfig } from "@runshape/kernel";

import { inCheckout, requireRecording, run, RUN_LOG } from "../host";
import { RecorderFiles, recorderSource } from "../recorder-source";

export const GO_RECORDER: RecorderFiles = { directories: ["recorder-go"], skipped: new Set(["testdata", "sandbox"]), files: [] };

/** runshape-go's arguments: the module, then go test's package patterns (./... when none). */
export function runshapeGoArguments(module: string, config: TestConfig, outDirectory: string): string[] {
  return ["record", "-out", outDirectory, "-run", "run", module, ...config.tests];
}

export class GoRecorder implements Recorder {
  readonly environment = "host";

  constructor(
    /** Runshape's checkout, where the recorder is. */
    private readonly home: string,
    /** The project's root: the module's go.mod is there. */
    private readonly root: string,
    private readonly config: TestConfig,
    private readonly hashing: Hashing,
  ) {}

  source(): Promise<string> {
    return recorderSource(this.hashing, this.home, GO_RECORDER, this.config);
  }

  async record(target: RecordTarget, outDirectory: string): Promise<void> {
    await inCheckout(this.root, target, outDirectory, async (tree) => {
      const args = ["-C", join(this.home, "recorder-go"), "run", "./cmd/runshape-go", ...runshapeGoArguments(tree, this.config, outDirectory)];
      const ran = await run("go", args, { cwd: tree, log: join(outDirectory, RUN_LOG) });
      await requireRecording(outDirectory, "runshape-go", ran);
    });
  }
}
