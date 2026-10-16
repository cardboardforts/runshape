// Runs the webview in a plain browser, with no VS Code: `npm run dev -w packages/webview`, then
// /demo/index.html lists what there is to look at (RecordingsPage). Also by URL:
//   ?recording=<id>          one recording kept by `npm run runshape` (.runshape/recordings/<id>)
//   ?base=<id>&head=<id>     two of them, compared
//   ?app=<example>           a checked-in example (django, fastapi-slug-refactor, …)
//   ?app=self:<label>        a pair recorded by the old self-review (.runshape/self/<label>)
// Never part of the extension bundle.
import { createRoot } from "react-dom/client";

import "@xyflow/react/dist/style.css";
import "../src/styles.css";

import { loadLatestRun, loadPreviousRun, RuleChange, TraceFiles, UiRequest, UiResponse, ViewerSession, ZoneRules, ZoneRulesError } from "@runshape/core";

import { App } from "../src/App";
import type { Host } from "../src/host";
import { RecordingsPage } from "./RecordingsPage";
import "./recordings.css";

const traceFiles = import.meta.glob("../../trace/test/fixtures/*/**/*.json", { query: "?raw", import: "default" });
const sourceFiles = import.meta.glob("../../trace/test/fixtures/*/source/**/*.py", { query: "?raw", import: "default" });
const selfTraceFiles = import.meta.glob("../../../.runshape/self/*/**/*.json", { query: "?raw", import: "default" });
// Django's source isn't redistributed in fixtures (no upstream license); use a local checkout.
const exampleSources = import.meta.glob("../../../examples/django-realworld/conduit/**/*.py", {
  query: "?raw",
  import: "default",
});

function fixtureReader(app: string, files: Record<string, () => Promise<unknown>>, prefix: string) {
  return async (relativePath: string): Promise<string> => {
    const load = files[`../../trace/test/fixtures/${app}/${prefix}${relativePath}`];
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

/** Reads a recording kept in .runshape/recordings, through the dev server (vite.config.ts). */
async function libraryText(id: string, path: string): Promise<string> {
  const response = await fetch(`/__runshape/recordings/${encodeURIComponent(id)}/${path}`);
  if (!response.ok) throw new Error(`demo: no ${path} in recording ${id} (npm run runshape -- list)`);
  return response.text();
}

/**
 * One kept recording, or two as base and head: each is a traces directory of its own, so the
 * pair is presented as one, its latest run the head's and its previous run the base's.
 */
function libraryTraces(head: string, base: string | null): TraceFiles {
  const runOf = new Map<string, Promise<string>>();
  const runDirectory = (id: string) => {
    if (!runOf.has(id)) runOf.set(id, libraryText(id, "latest.json").then((text) => (JSON.parse(text) as { run: string }).run));
    return runOf.get(id)!;
  };
  return {
    async readText(path) {
      if (path === "latest.json") return JSON.stringify({ run: "head" });
      if (path === "previous.json") {
        if (base === null) throw new Error("demo: one recording, nothing to compare with");
        return JSON.stringify({ run: "base" });
      }
      const [side, ...rest] = path.split("/");
      const id = side === "head" ? head : side === "base" && base !== null ? base : null;
      if (id === null) throw new Error(`demo: no such file ${path}`);
      return libraryText(id, `${await runDirectory(id)}/${rest.join("/")}`);
    },
  };
}

/**
 * The rules a kept recording was made with: its commit's runshape.json, none if the commit had
 * none. Null when the recording predates kept zones, so nobody knows.
 */
async function recordingRules(id: string): Promise<ZoneRules | null> {
  let metadata: { architecture?: unknown };
  try {
    metadata = JSON.parse(await libraryText(id, "recording.json")) as { architecture?: unknown };
  } catch (error) {
    // The traces may still load: draw with no known rules rather than failing everything.
    console.warn(`demo: recording ${id} has no readable recording.json`, error);
    return null;
  }
  if (metadata.architecture === undefined) return null;
  const response = await fetch(`/__runshape/recordings/${encodeURIComponent(id)}/runshape.json`);
  if (!response.ok) return ZoneRules.none();
  try {
    return ZoneRules.parse((await response.text()).replace(/^\uFEFF/, ""));
  } catch (error) {
    // Recorded as invalid (recording.json says why): its zones were all inferred.
    if (error instanceof ZoneRulesError) return ZoneRules.none();
    throw error;
  }
}

function demoHost(params: URLSearchParams): Host {
  const app = params.get("app") ?? "django";
  const listeners = new Set<(response: UiResponse) => void>();
  const emit = (response: UiResponse) => listeners.forEach((listener) => listener(response));
  const selfLabel = app.startsWith("self:") ? app.slice("self:".length) : null;
  const pair = comparedPair(params);
  const single = params.get("recording");
  const traces: TraceFiles =
    pair !== null
      ? libraryTraces(pair.head, pair.base)
      : single !== null
        ? libraryTraces(single, null)
        : { readText: selfLabel === null ? fixtureReader(app, traceFiles, "") : selfReader(selfLabel) };
  // Fixtures named "<app>-<change>" (django-feed-fix, fastapi-slug-refactor) share the app's source.
  const baseApp = app.split("-")[0] ?? app;
  const readFixtureSource = fixtureReader(baseApp, sourceFiles, "source/");
  const readSource = async (file: string): Promise<string> => {
    const local = exampleSources[`../../../examples/${baseApp}-realworld/${file}`];
    return local ? ((await local()) as string) : readFixtureSource(file);
  };
  const latest = loadLatestRun(traces);
  // Runshape's own recordings carry their source; the example apps' comes from fixtures or examples/.
  const sources = {
    readLines: async (file: string) =>
      (await latest).sources?.get(file) ?? readSource(file).then((text) => text.split("\n"), () => null),
  };
  // Rules live in memory here (nothing to write to); the confirm mirrors the extension's modal.
  const ruleStore = { save: async (_rules: unknown, change: RuleChange) => window.confirm(`${change.question}\n\n${change.detail}`) };
  // A kept recording brings its commit's rules, so each side of a comparison is drawn with its own.
  const headId = pair?.head ?? single;
  const rules = headId === null ? Promise.resolve(null) : recordingRules(headId);
  const baselineRules = pair === null ? Promise.resolve(null) : recordingRules(pair.base);
  const session = Promise.all([latest, loadPreviousRun(traces), rules, baselineRules]).then(
    // Head's rules unknown: then neither side's are, or the base's would all read as removed.
    ([run, baseline, headRules, baseRules]) =>
      new ViewerSession(run, { sources, baseline, ruleStore, rules: headRules ?? undefined, baselineRules: headRules === null ? null : baseRules }),
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

/** ?base=…&head=…: both, or it isn't a comparison. */
function comparedPair(params: URLSearchParams): { base: string; head: string } | null {
  const base = params.get("base");
  const head = params.get("head");
  return base !== null && head !== null ? { base, head } : null;
}

/** What the URL asks to open; with nothing (or half a comparison) asked, the list of what there is. */
function Demo() {
  const params = new URLSearchParams(location.search);
  if (!params.has("app") && !params.has("recording") && comparedPair(params) === null) {
    const examples = Object.keys(traceFiles)
      .map((path) => path.match(/fixtures\/([^/]+)\/latest\.json$/)?.[1])
      .filter((name) => name !== undefined);
    const olderPairs = Object.keys(selfTraceFiles)
      .map((path) => path.match(/\.runshape\/self\/([^/]+)\/latest\.json$/)?.[1])
      .filter((label) => label !== undefined);
    return <RecordingsPage examples={examples} olderPairs={olderPairs} />;
  }
  return (
    <>
      <App host={demoHost(params)} />
      <a className="back-to-recordings" href="?">
        ← Recordings
      </a>
    </>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("demo: #root element missing");
createRoot(root).render(<Demo />);
