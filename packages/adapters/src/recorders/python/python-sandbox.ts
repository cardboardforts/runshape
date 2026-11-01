// The Python recorder in the sandbox (recorder/sandbox/Dockerfile): pip installs the commit's
// requirements.txt as wheels only, from PyPI only, and pytest records it.
import { TestConfig } from "@runshape/kernel";

import { ContainerStep, readPlainFile, refuseCommitted, SandboxRecipe, SandboxRefusal } from "../docker-recorder";

const REQUIREMENTS = "requirements.txt";
/** Where the install puts the commit's environment, inside its folder: the record step reads it there. */
const VENV_NAME = ".runshape-venv";
const VENV = `/target/${VENV_NAME}`;
/** PyPI's index and the host its files come from: the only two the proxy lets through. */
const PYPI_INDEX = "https://pypi.org/simple/";
const PYPI_HOSTS = ["pypi.org:443", "files.pythonhosted.org:443"];
/**
 * A pinned requirement and nothing else: `name[extras]==version`, an environment marker, hashes.
 * Anything more (an option line naming another index or file, a URL, a path, `-e`) is somewhere
 * pip would fetch from, or build from source.
 */
const PINNED = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._, -]+\])?\s*==\s*[A-Za-z0-9.+!_-]+(\s*;[A-Za-z0-9_ .<>=!~'"(),]*)?(\s+--hash=sha256:[0-9a-f]{64})*$/;
/** How many refused lines a refusal names (by number: their text is the commit's, never echoed). */
const LINES_NAMED = 3;

export function pythonSandbox(config: TestConfig): SandboxRecipe {
  return {
    language: "python",
    image: "runshape-recorder-python",
    dockerfile: "recorder/sandbox/Dockerfile",
    imageSources: ["recorder/src", "recorder/sandbox", "recorder-ts/sandbox/registry-proxy.mjs", ".dockerignore"],
    registries: PYPI_HOSTS,
    async prepare(worktree: string): Promise<void> {
      // A committed venv would be used as it is: its pip, its .pth files, run at install with network.
      await refuseCommitted(worktree, [VENV_NAME]);
      await refuseUnpinnedRequirements(worktree);
    },
    install(proxy: string): ContainerStep {
      // Wheels only: an sdist runs its setup.py as it's built, which is the commit's code with a network.
      // -I, from /tmp: `-m` would put the working directory first on sys.path, and a committed
      // argparse.py or venv/ there would run instead of Python's own (second-model review).
      const pip = `${VENV}/bin/python -I -m pip install --no-input --disable-pip-version-check --no-cache-dir --only-binary=:all: --index-url ${PYPI_INDEX} -r /target/${REQUIREMENTS}`;
      return {
        // pip's own config files (user, global, site) could name another index: none is read.
        options: ["-e", "PIP_CONFIG_FILE=/dev/null", "-e", `HTTPS_PROXY=${proxy}`, "-e", `HTTP_PROXY=${proxy}`, "-e", `https_proxy=${proxy}`],
        workdir: "/tmp",
        // The image's pytest shows through (--system-site-packages) for requirements that don't pin one.
        command: ["sh", "-c", `python -I -m venv --system-site-packages ${VENV} && ${pip}`],
      };
    },
    record(): ContainerStep {
      // pytest's arguments as positional parameters: nothing from runshape.json is spliced into the line.
      const script = `${VENV}/bin/python -m runshape_recorder.run --runshape-out=/out --runshape-run-name=run -p no:cacheprovider "$@" > /out/run.log 2>&1 || true`;
      const source = config.source.length > 0 ? ["-o", `runshape_source=${config.source.join(" ")}`] : [];
      return {
        // The commit is read-only: no bytecode written beside it.
        options: ["-e", "PYTHONPATH=/runshape/recorder/src", "-e", "PYTHONDONTWRITEBYTECODE=1"],
        workdir: "/target",
        command: ["sh", "-c", script, "sh", ...source, ...config.tests, ...config.args],
      };
    },
  };
}

/** Every line of requirements.txt a pinned release from PyPI: nothing else is installed. */
export async function refuseUnpinnedRequirements(worktree: string): Promise<void> {
  const text = await readPlainFile(worktree, REQUIREMENTS, `the commit has no ${REQUIREMENTS}: its dependencies can't be installed as pinned (a lockfile of poetry's or uv's isn't read yet)`);
  // A trailing backslash continues a line (poetry export writes hashes so): numbered by where each starts.
  const refused: number[] = [];
  let logical = "";
  let startsAt = 0;
  text.split(/\r?\n/).forEach((line, index) => {
    if (logical === "") startsAt = index + 1;
    if (line.endsWith("\\")) {
      logical += `${line.slice(0, -1)} `;
      return;
    }
    const requirement = (logical + line).replace(/(^|\s)#.*$/, "").trim();
    logical = "";
    if (requirement !== "" && !PINNED.test(requirement)) refused.push(startsAt);
  });
  if (refused.length > 0) {
    const more = refused.length > LINES_NAMED ? ` and ${refused.length - LINES_NAMED} more` : "";
    throw new SandboxRefusal(`its ${REQUIREMENTS} has lines that aren't a pinned release (name==version), which could install from elsewhere or build from source: line ${refused.slice(0, LINES_NAMED).join(", ")}${more}`);
  }
}
