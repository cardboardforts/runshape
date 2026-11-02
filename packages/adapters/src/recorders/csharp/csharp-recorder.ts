// Records a .NET project's tests on this machine with Runshape's recorder (recorder-cs/), which
// instruments a copy of the project: the project itself is only read.
import { join } from "node:path";

import { Hashing, Recorder, RecordTarget, TestConfig } from "@runshape/kernel";

import { inCheckout, requireRecording, run, RUN_LOG } from "../host";
import { RecorderFiles, recorderSource } from "../recorder-source";

export const CSHARP_RECORDER: RecorderFiles = { directories: ["recorder-cs/src"], skipped: new Set(["bin", "obj"]), files: ["recorder-cs/global.json", "recorder-cs/Directory.Build.props"] };

/** runshape-cs's arguments: the project, then what dotnet test runs (the root's solution when none). */
export function runshapeCsArguments(project: string, config: TestConfig, outDirectory: string): string[] {
  return ["record", "-out", outDirectory, "-run", "run", project, ...config.tests];
}

export class CSharpRecorder implements Recorder {
  readonly environment = "host";

  constructor(
    /** Runshape's checkout, where the recorder is. */
    private readonly home: string,
    /** The project's root: its solution or project file is there. */
    private readonly root: string,
    private readonly config: TestConfig,
    private readonly hashing: Hashing,
  ) {}

  source(): Promise<string> {
    return recorderSource(this.hashing, this.home, CSHARP_RECORDER, this.config);
  }

  async record(target: RecordTarget, outDirectory: string): Promise<void> {
    await inCheckout(this.root, target, outDirectory, async (tree) => {
      const recorder = join(this.home, "recorder-cs");
      const args = ["run", "--project", join(recorder, "src", "Runshape.Record"), "-c", "Release", "--", ...runshapeCsArguments(tree, this.config, outDirectory)];
      // From the recorder's folder: its global.json picks the SDK that builds it.
      const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", MSBUILDDISABLENODEREUSE: "1" };
      const ran = await run("dotnet", args, { cwd: recorder, env, log: join(outDirectory, RUN_LOG) });
      await requireRecording(outDirectory, "runshape-cs", ran);
    });
  }
}
