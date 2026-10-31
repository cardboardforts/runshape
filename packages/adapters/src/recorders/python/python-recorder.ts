// Records a Python project's pytest run on this machine with Runshape's recorder (recorder/),
// put on PYTHONPATH: nothing is installed into the project.
import { stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { Hashing, Recorder, RecordTarget, TestConfig } from "@runshape/kernel";

import { inCheckout, requireRecording, run, RUN_LOG } from "../host";
import { RecorderFiles, recorderSource } from "../recorder-source";

export const PYTHON_RECORDER: RecorderFiles = { directories: [join("recorder", "src")], skipped: new Set(["__pycache__"]), files: [] };
/** Where uv, poetry and `python -m venv` put a project's environment, by convention. */
const PROJECT_VENV_PYTHON = join(".venv", "bin", "python");
const SYSTEM_PYTHON = "python3";

/** The recorder's own runner: loads the plugin whether or not the project's environment has it. */
export function pytestArguments(config: TestConfig, outDirectory: string): string[] {
  // runshape_source is an ini option of type args: pytest splits it on spaces.
  const source = config.source.length > 0 ? ["-o", `runshape_source=${config.source.join(" ")}`] : [];
  return ["-m", "runshape_recorder.run", `--runshape-out=${outDirectory}`, "--runshape-run-name=run", ...source, ...config.tests, ...config.args];
}

export class PythonRecorder implements Recorder {
  readonly environment = "host";

  constructor(
    /** Runshape's checkout, where the recorder is. */
    private readonly home: string,
    /** The project's root. */
    private readonly root: string,
    private readonly config: TestConfig,
    private readonly hashing: Hashing,
  ) {}

  source(): Promise<string> {
    return recorderSource(this.hashing, this.home, PYTHON_RECORDER, this.config);
  }

  async record(target: RecordTarget, outDirectory: string): Promise<void> {
    // The working tree's environment, for a commit too: a checked-out commit has no .venv of its own.
    const python = await this.interpreter();
    await inCheckout(this.root, target, outDirectory, async (tree) => {
      const inherited = process.env.PYTHONPATH;
      const env = { ...process.env, PYTHONPATH: [join(this.home, "recorder", "src"), ...(inherited ? [inherited] : [])].join(delimiter) };
      const ran = await run(python, pytestArguments(this.config, outDirectory), { cwd: tree, env, log: join(outDirectory, RUN_LOG) });
      await requireRecording(outDirectory, "pytest", ran);
    });
  }

  private async interpreter(): Promise<string> {
    if (this.config.interpreter !== null) return join(this.root, this.config.interpreter);
    const venv = join(this.root, PROJECT_VENV_PYTHON);
    return (await stat(venv).then(() => true, () => false)) ? venv : SYSTEM_PYTHON;
  }
}
