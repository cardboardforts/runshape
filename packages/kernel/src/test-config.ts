// What a recorder is handed: which language's recorder runs the project's tests, and how. The
// recorders (recorder/, recorder-ts/, recorder-go/) are separate processes in their own
// languages; this is the contract on the way in, as the trace format is on the way out.

/** The languages with a recorder. Each value is the word runshape.json and --recorder use. */
export const RECORDER_LANGUAGES = ["typescript", "python", "go"] as const;
export type RecorderLanguage = (typeof RECORDER_LANGUAGES)[number];

/** The section of runshape.json that holds the recorder's settings. */
export const TEST_CONFIG_SECTION = "recorder";

/** How a project's tests are recorded. */
export interface TestConfig {
  language: RecorderLanguage;
  /** Why this language: "runshape.json", "--recorder", or the project file that gave it away ("go.mod"). */
  chosenBy: string;
  /** Folders holding the code to record, relative to the project: empty leaves it to the project's own settings. */
  source: string[];
  /** Which tests run: pytest's paths, Go's packages, vitest's globs. Empty: all of them. */
  tests: string[];
  /** More arguments for the test runner, as given (pytest's `-n0 --no-cov`). Python only. */
  args: string[];
  /** The Python that runs the tests, relative to the project; null: its .venv's, else python3. */
  interpreter: string | null;
}

/** How each recorder is run by hand, for "no recording found". */
export const HOW_TO_RECORD: Record<RecorderLanguage, string> = {
  typescript: "record one with `npm run runshape -- record working`",
  python: "record one by running your tests with `pytest --runshape` (or `npm run runshape -- record working`)",
  go: "record one with `npm run record-go -- <module>` (or `npm run runshape -- record working`)",
};

export class TestConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`can't tell how to record this project:\n  - ${problems.join("\n  - ")}`);
  }
}

/**
 * Which project files say which language, checked at the project's root. A file several
 * languages' projects carry (a Makefile, a Dockerfile) says nothing, so isn't here.
 */
const LANGUAGE_MARKERS: Record<RecorderLanguage, string[]> = {
  go: ["go.mod"],
  python: ["pyproject.toml", "pytest.ini", "setup.py", "setup.cfg", "requirements.txt", "manage.py", "tox.ini"],
  typescript: ["package.json"],
};

const SETTINGS = new Set(["language", "source", "tests", "args", "interpreter"]);

/**
 * The project's TestConfig: runshape.json's `recorder` section, else what its root's files say.
 * `override` (--recorder) picks the language over both. Every problem is reported at once.
 *
 * @param section runshape.json's `recorder` value; undefined when there's none.
 * @param rootFiles the names of the files at the project's root.
 */
export function chooseTestConfig(section: unknown, rootFiles: readonly string[], override: string | null = null): TestConfig {
  const problems: string[] = [];
  const settings = readSection(section, problems);
  let language: RecorderLanguage | null = null;
  let chosenBy = "";
  if (override !== null) {
    if (isLanguage(override)) [language, chosenBy] = [override, "--recorder"];
    else problems.push(`--recorder=${override} isn't one of: ${RECORDER_LANGUAGES.join(", ")}`);
  } else if (settings.language !== undefined) {
    if (isLanguage(settings.language)) [language, chosenBy] = [settings.language, "runshape.json"];
    else problems.push(`runshape.json's ${TEST_CONFIG_SECTION}.language "${String(settings.language)}" isn't one of: ${RECORDER_LANGUAGES.join(", ")}`);
  } else {
    const present = new Set(rootFiles);
    const found = RECORDER_LANGUAGES.map((candidate) => ({ candidate, files: LANGUAGE_MARKERS[candidate].filter((file) => present.has(file)) })).filter((entry) => entry.files.length > 0);
    const said = found.map((entry) => `${entry.candidate} (${entry.files.join(", ")})`).join(", ");
    if (found.length === 1) [language, chosenBy] = [found[0]!.candidate, found[0]!.files[0]!];
    else if (found.length === 0) problems.push(`nothing at the project's root says its language (${Object.values(LANGUAGE_MARKERS).flat().join(", ")}): set ${TEST_CONFIG_SECTION}.language in runshape.json, or pass --recorder=<${RECORDER_LANGUAGES.join("|")}>`);
    else problems.push(`its root looks like more than one language, ${said}: set ${TEST_CONFIG_SECTION}.language in runshape.json, or pass --recorder=<${RECORDER_LANGUAGES.join("|")}>`);
  }
  const source = stringList(settings, "source", problems);
  const tests = stringList(settings, "tests", problems);
  const args = stringList(settings, "args", problems);
  let interpreter: string | null = null;
  if (typeof settings.interpreter === "string" && settings.interpreter !== "") interpreter = settings.interpreter;
  else if (settings.interpreter !== undefined) problems.push(`${TEST_CONFIG_SECTION}.interpreter must be a path`);
  for (const [name, value] of [["source", source], ["tests", tests], ["interpreter", interpreter === null ? [] : [interpreter]]] as const) {
    for (const path of value) if (escapesProject(path)) problems.push(`${TEST_CONFIG_SECTION}.${name} "${path}" must stay inside the project`);
  }
  // What a language's recorder can't take: said, rather than silently dropped.
  if (language === "go" && source.length > 0) problems.push(`${TEST_CONFIG_SECTION}.source doesn't apply to Go: the recorder instruments the whole module`);
  if (language !== "python" && language !== null && args.length > 0) problems.push(`${TEST_CONFIG_SECTION}.args only applies to Python (pytest's arguments)`);
  if (language !== "python" && language !== null && interpreter !== null) problems.push(`${TEST_CONFIG_SECTION}.interpreter only applies to Python`);
  if (problems.length > 0 || language === null) throw new TestConfigError(problems);
  return { language, chosenBy, source, tests, args, interpreter };
}

function readSection(section: unknown, problems: string[]): Record<string, unknown> {
  if (section === undefined) return {};
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    problems.push(`runshape.json's ${TEST_CONFIG_SECTION} must be an object`);
    return {};
  }
  for (const key of Object.keys(section)) if (!SETTINGS.has(key)) problems.push(`runshape.json's ${TEST_CONFIG_SECTION}.${key} isn't a setting (${[...SETTINGS].join(", ")})`);
  return section as Record<string, unknown>;
}

function stringList(settings: Record<string, unknown>, name: string, problems: string[]): string[] {
  const value = settings[name];
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "")) return value as string[];
  problems.push(`${TEST_CONFIG_SECTION}.${name} must be a list of strings`);
  return [];
}

function isLanguage(value: unknown): value is RecorderLanguage {
  return (RECORDER_LANGUAGES as readonly unknown[]).includes(value);
}

/** An absolute path or one that climbs out: a recorder would read or run something outside the project. */
function escapesProject(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes("..");
}
