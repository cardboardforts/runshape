// Runs the webview in a plain browser against the recorded example traces, with no VS Code:
// `npm run dev -w packages/webview` then open /demo/index.html?app=django (or fastapi, or
// django-feed-fix / fastapi-slug-refactor: two recordings, before and after a change, for
// compare mode). ?app=self:<label> opens Runshape's own tests as recorded by
// `npm run self-review` (.runshape/self/<label>), source included.
// Never part of the extension bundle.
import { createRoot } from "react-dom/client";

import "@xyflow/react/dist/style.css";
import "../src/styles.css";

import { loadLatestRun, loadPreviousRun, RuleChange, TraceFiles, UiRequest, UiResponse, ViewerSession } from "@runshape/core";

import { App } from "../src/App";
import type { Host } from "../src/host";

const traceFiles = import.meta.glob("../../core/test/fixtures/*/**/*.json", { query: "?raw", import: "default" });
const sourceFiles = import.meta.glob("../../core/test/fixtures/*/source/**/*.py", { query: "?raw", import: "default" });
const selfTraceFiles = import.meta.glob("../../../.runshape/self/*/**/*.json", { query: "?raw", import: "default" });
// Django's source isn't redistributed in fixtures (no upstream license); use a local checkout.
const exampleSources = import.meta.glob("../../../examples/django-realworld/conduit/**/*.py", {
  query: "?raw",
  import: "default",
});

function fixtureReader(app: string, files: Record<string, () => Promise<unknown>>, prefix: string) {
  return async (relativePath: string): Promise<string> => {
    const load = files[`../../core/test/fixtures/${app}/${prefix}${relativePath}`];
    if (load === undefined) throw new Error(`demo: no fixture file ${relativePath}`);
    return (await load()) as string;
  };
}

function selfReader(label: string) {
  return async (relativePath: string): Promise<string> => {
    const load = selfTraceFiles[`../../../.runshape/self/${label}/${relativePath}`];
    if (load === undefined) throw new Error(`demo: no self-review file ${relativePath} (run npm run self-review)`);
    return (await load()) as string;
  };
}

function demoHost(app: string): Host {
  const listeners = new Set<(response: UiResponse) => void>();
  const emit = (response: UiResponse) => listeners.forEach((listener) => listener(response));
  const selfLabel = app.startsWith("self:") ? app.slice("self:".length) : null;
  const traces: TraceFiles = { readText: selfLabel === null ? fixtureReader(app, traceFiles, "") : selfReader(selfLabel) };
  // Fixtures named "<app>-<change>" (django-feed-fix, fastapi-slug-refactor) share the app's source.
  const baseApp = app.split("-")[0] ?? app;
  const readFixtureSource = fixtureReader(baseApp, sourceFiles, "source/");
  const readSource = async (file: string): Promise<string> => {
    const local = exampleSources[`../../../examples/${baseApp}-realworld/${file}`];
    return local ? ((await local()) as string) : readFixtureSource(file);
  };
  const latest = loadLatestRun(traces);
  // Self-review recordings carry their source; the example apps' comes from fixtures or examples/.
  const sources = {
    readLines: async (file: string) =>
      (await latest).sources?.get(file) ?? readSource(file).then((text) => text.split("\n"), () => null),
  };
  // Rules live in memory here (nothing to write to); the confirm mirrors the extension's modal.
  const ruleStore = { save: async (_rules: unknown, change: RuleChange) => window.confirm(`${change.question}\n\n${change.detail}`) };
  const session = Promise.all([latest, loadPreviousRun(traces)]).then(
    ([run, baseline]) => new ViewerSession(run, { sources, baseline, ruleStore }),
  );

  return {
    post(request: UiRequest) {
      if (request.type === "openSource") {
        console.info(`demo: would open ${request.file}:${request.line}`);
        return;
      }
      session
        .then((s) => s.handle(request))
        .then((response) => response && emit(response))
        .catch((error: unknown) => emit({ type: "error", message: error instanceof Error ? error.message : String(error) }));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const app = new URLSearchParams(location.search).get("app") ?? "django";
const root = document.getElementById("root");
if (root === null) throw new Error("demo: #root element missing");
createRoot(root).render(<App host={demoHost(app)} />);
