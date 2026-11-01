/**
 * Which recorder records a project (PLAN.md Phase 7): runshape.json's `recorder` section says,
 * or the files at the project's root do; `--recorder` beats both. The CLI's composition root
 * calls this once, and builds that language's recorder from what it returns. A project it
 * can't place, or settings it can't use, fail with every reason at once, before anything runs.
 */
import { describe, expect, test } from "vitest";

import { chooseTestConfig, TestConfigError } from "../src";

const problemsOf = (run: () => unknown): string[] => {
  try {
    run();
    return [];
  } catch (error) {
    if (error instanceof TestConfigError) return error.problems;
    throw error;
  }
};

describe("chooseTestConfig", () => {
  test("detected from the root's files: the realworld apps are Python, go-shop Go, Runshape TypeScript", () => {
    const django = chooseTestConfig(undefined, ["manage.py", "pytest.ini", "requirements.txt", "README.md"]);
    const goShop = chooseTestConfig(undefined, ["go.mod", "cmd", "internal"]);
    const runshape = chooseTestConfig(undefined, ["package.json", "package-lock.json", "PLAN.md"]);

    expect([django, goShop, runshape].map((config) => `${config.language} (${config.chosenBy})`)).toEqual(["python (pytest.ini)", "go (go.mod)", "typescript (package.json)"]);
    expect(django).toEqual({ language: "python", chosenBy: "pytest.ini", source: [], tests: [], args: [], interpreter: null });
  });

  test("runshape.json's section names the language and how to run it; --recorder beats it", () => {
    // examples/record.sh's FastAPI options, as the recorder section carries them.
    const fastapi = { language: "python", source: ["app"], tests: ["tests"], args: ["-n0", "--no-cov", "-o", "runshape_app=app.main:app"], interpreter: ".venv/bin/python" };

    expect(chooseTestConfig(fastapi, ["package.json"])).toEqual({ ...fastapi, chosenBy: "runshape.json" });
    expect(chooseTestConfig({ language: "python" }, ["go.mod"], "go").language).toBe("go");
  });

  test("a root that says two languages, or none, asks for the setting rather than guessing", () => {
    expect([problemsOf(() => chooseTestConfig(undefined, ["package.json", "pyproject.toml"])), problemsOf(() => chooseTestConfig(undefined, ["README.md"]))]).toEqual([
      ["its root looks like more than one language, typescript (package.json), python (pyproject.toml): set recorder.language in runshape.json, or pass --recorder=<typescript|python|go>"],
      [
        "nothing at the project's root says its language (go.mod, pyproject.toml, pytest.ini, setup.py, setup.cfg, requirements.txt, manage.py, tox.ini, package.json): set recorder.language in runshape.json, or pass --recorder=<typescript|python|go>",
      ],
    ]);
  });

  test("every bad setting is reported at once: unknown names, wrong types, paths out of the project, settings the language can't take", () => {
    const section = { language: "go", sources: ["x"], tests: "./...", source: ["../elsewhere"], args: ["-v"], interpreter: "/usr/bin/python3" };

    expect(problemsOf(() => chooseTestConfig(section, []))).toEqual([
      "runshape.json's recorder.sources isn't a setting (language, source, tests, args, interpreter)",
      "recorder.tests must be a list of strings",
      'recorder.source "../elsewhere" must stay inside the project',
      'recorder.interpreter "/usr/bin/python3" must stay inside the project',
      "recorder.source doesn't apply to Go: the recorder instruments the whole module",
      "recorder.args only applies to Python (pytest's arguments)",
      "recorder.interpreter only applies to Python",
    ]);
    expect(problemsOf(() => chooseTestConfig({ language: "cobol" }, [], "rust"))).toEqual(["--recorder=rust isn't one of: typescript, python, go"]);
    // A folder or test that starts with "-" would reach pytest as an option (-p loads a plugin);
    // args are where options go, deliberately (examples/record.sh's -n0 --no-cov).
    expect(problemsOf(() => chooseTestConfig({ language: "python", source: ["-pevil"], tests: ["--rootdir=/"], args: ["-n0"] }, []))).toEqual([
      'recorder.source "-pevil" can\'t start with "-": options go in recorder.args',
      'recorder.tests "--rootdir=/" can\'t start with "-": options go in recorder.args',
    ]);
  });
});
