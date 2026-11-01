// Records a Python project's pytest run on this machine with Runshape's recorder (recorder/),
// put on PYTHONPATH: nothing is installed into the project.
import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative } from "node:path";

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
    const named = this.config.interpreter ?? PROJECT_VENV_PYTHON;
    const path = join(this.root, named);
    if (this.config.interpreter === null && !(await stat(path).then(() => true, () => false))) return SYSTEM_PYTHON;
    const refuse = (why: string) => new Error(`the Python to record with (${named}) ${why}: that's the commit's code, not an environment of yours, so it isn't run here`);
    const resolved = await realpath(path).catch(() => {
      throw new Error(`the Python to record with (${named}) can't be found`);
    });
    const inProject = relative(await realpath(this.root), resolved);
    const isInProject = inProject !== "" && !inProject.startsWith("..") && !isAbsolute(inProject);
    // A committed one is a commit's code: a pull request checked out here could ship
    // .venv/bin/python, or .venv as a link to a committed folder, and recording main would run it.
    // Every folder on the way, as named and as resolved, case-insensitively (macOS's .Venv is .venv).
    for (const folder of [...pathPrefixes(named), ...(isInProject ? pathPrefixes(inProject) : [])]) {
      if (await this.tracked(folder)) throw refuse(`goes through ${folder}, which git tracks`);
    }
    if (isInProject && (await run("git", ["-C", this.root, "check-ignore", "-q", "--", inProject], { cwd: this.root })).code !== 0) {
      throw refuse(`is ${inProject}, inside the project but not ignored by git`);
    }
    return path;
  }

  /** Fails closed: anything git can't answer about counts as tracked. */
  private async tracked(path: string): Promise<boolean> {
    const listed = await run("git", ["-C", this.root, "ls-files", "-s", "--", `:(icase,literal)${path}`], { cwd: this.root });
    return listed.code !== 0 || listed.output.trim() !== "";
  }
}

/** "a/b/c" -> a, a/b, a/b/c. */
function pathPrefixes(path: string): string[] {
  const parts = path.split(/[\\/]/).filter((part) => part !== "" && part !== ".");
  return parts.map((_part, i) => parts.slice(0, i + 1).join("/"));
}
