// A project's recorder, here and in the sandbox, from its TestConfig: one per language.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { chooseTestConfig, Hashing, Recorder, RecorderLanguage, RecordTarget, Repository, TEST_CONFIG_SECTION, TestConfig, TestConfigError } from "@runshape/kernel";

/** The project's settings file (the arch module's RULES_FILE; adapters don't import modules). */
const RULES_FILE = "runshape.json";

import { DockerRecorder, SandboxRecipe, sandboxVersion } from "./docker-recorder";
import { GoRecorder } from "./go/go-recorder";
import { goSandbox } from "./go/go-sandbox";
import { PythonRecorder } from "./python/python-recorder";
import { pythonSandbox } from "./python/python-sandbox";
import { TypeScriptRecorder } from "./typescript/typescript-recorder";
import { typescriptSandbox } from "./typescript/typescript-sandbox";

/** Where things are: Runshape's checkout (the recorders, and the git its images are built from) and the project. */
export interface RecorderPlaces {
  home: string;
  homeRepository: Repository;
  root: string;
  hashing: Hashing;
}

export interface ProjectRecorders {
  /** Records here: the working tree, and commits that are yours. */
  host: Recorder;
  /** Records commits in a container (--sandbox): made when first needed. */
  sandbox: () => Promise<Recorder>;
}

const HOST_RECORDERS: Record<RecorderLanguage, new (home: string, root: string, config: TestConfig, hashing: Hashing) => Recorder> = {
  typescript: TypeScriptRecorder,
  python: PythonRecorder,
  go: GoRecorder,
};

const SANDBOX_RECIPES: Record<RecorderLanguage, (config: TestConfig) => SandboxRecipe> = {
  typescript: typescriptSandbox,
  python: pythonSandbox,
  go: goSandbox,
};

export function projectRecorders(config: TestConfig, places: RecorderPlaces): ProjectRecorders {
  const recipe = SANDBOX_RECIPES[config.language](config);
  return {
    host: new HOST_RECORDERS[config.language](places.home, places.root, config, places.hashing),
    sandbox: async () => new DockerRecorder(places.home, places.root, recipe, await sandboxVersion(places.homeRepository, places.hashing, recipe)),
  };
}

/**
 * The project's TestConfig, from its working tree: runshape.json's recorder section, else the
 * files at its root (chooseTestConfig). TestConfigError says why it can't be told.
 */
export async function projectTestConfig(root: string, override: string | null): Promise<TestConfig> {
  const files = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const text = files.includes(RULES_FILE) ? await readFile(join(root, RULES_FILE), "utf8") : null;
  let section: unknown = undefined;
  if (text !== null) {
    try {
      section = (JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>)[TEST_CONFIG_SECTION];
    } catch (error) {
      throw new TestConfigError([`${RULES_FILE} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
    }
  }
  return chooseTestConfig(section, files, override);
}

/**
 * Stands in for a recorder when the project's TestConfig couldn't be chosen: commands that
 * don't record still work, and one that does says why it can't.
 */
export class UnchosenRecorder implements Recorder {
  readonly environment = "host";

  constructor(private readonly why: TestConfigError) {}

  async record(_target: RecordTarget, _outDirectory: string): Promise<void> {
    throw this.why;
  }

  async source(): Promise<string> {
    throw this.why;
  }
}
