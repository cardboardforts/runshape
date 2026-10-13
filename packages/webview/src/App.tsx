import { useEffect, useMemo, useRef, useState } from "react";

import {
  Change,
  ComponentView,
  FunctionSummary,
  FunctionView,
  GraphNode,
  Grouping,
  Phase,
  ReplayStep,
  RunDiff,
  RunSummary,
  SystemGraph,
  UiResponse,
} from "@hexvis/core";

import { ComponentPanel } from "./components/ComponentPanel";
import { FunctionPanel } from "./components/FunctionPanel";
import { GraphCanvas } from "./components/GraphCanvas";
import { ReplayBar } from "./components/ReplayBar";
import { ScenarioDiffPanel } from "./components/ScenarioDiffPanel";
import { ScenarioList } from "./components/ScenarioList";
import type { Host } from "./host";
import { layoutGraph, Positioned } from "./layout";

type Status =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "ready" };

interface Replay {
  scenarioId: string;
  steps: ReplayStep[];
  index: number;
  playing: boolean;
}

interface Detail {
  component: ComponentView | null;
  fn: FunctionView | null;
}

const STEP_INTERVAL_MS = 450;
const TEST_BODY_ONLY = [Phase.Call];
const WITH_SETUP = [Phase.Setup, Phase.Call];
const INITIAL_GROUPING: Grouping = { collapseMiddleware: true };

export function App({ host }: { host: Host }) {
  const [status, setStatus] = useState<Status>({ kind: "loading", message: "Loading the latest recording…" });
  const [notice, setNotice] = useState<string | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [includeSetup, setIncludeSetup] = useState(false);
  const [grouping, setGrouping] = useState<Grouping>(INITIAL_GROUPING);
  const [graph, setGraph] = useState<SystemGraph | null>(null);
  const [positions, setPositions] = useState<Map<string, Positioned> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail>({ component: null, fn: null });
  const [replay, setReplay] = useState<Replay | null>(null);
  const [compare, setCompare] = useState(false);
  const [diff, setDiff] = useState<RunDiff | null>(null);
  // Read inside the host listener, which is subscribed once and would see stale state.
  const runLoaded = useRef(false);
  const loadFailed = useRef(false);
  const viewOptions = useRef({ phases: TEST_BODY_ONLY, grouping: INITIAL_GROUPING, compare: false });
  viewOptions.current = { phases: includeSetup ? WITH_SETUP : TEST_BODY_ONLY, grouping, compare };

  // In compare mode the canvas shows the union of both recordings. Memoised only so the
  // layout effect below sees a stable object, not a new one every render.
  const displayed = useMemo<SystemGraph | null>(
    () => (compare && diff !== null ? { nodes: diff.nodes, edges: diff.edges } : graph),
    [compare, diff, graph],
  );

  // The host is the outside world: subscribe once, ask for the run and its graph.
  useEffect(() => {
    const unsubscribe = host.subscribe((response: UiResponse) => {
      switch (response.type) {
        case "loading":
          setStatus({ kind: "loading", message: response.message });
          break;
        case "empty":
          setStatus({ kind: "empty", message: response.message });
          break;
        case "error":
          // Before a run is loaded an error is the whole story; after, it's a notice.
          if (runLoaded.current) {
            setNotice(response.message);
          } else {
            loadFailed.current = true;
            setStatus({ kind: "error", message: response.message });
          }
          break;
        case "run":
          // Re-ask for the views after a reload, and also when the first load failed (the
          // panel opened before any recording existed): those first requests got errors.
          if (runLoaded.current || loadFailed.current) {
            // A new recording replaced the old one: scenario ids and views may all differ.
            setSelected(null);
            setDetail({ component: null, fn: null });
            setReplay(null);
            setDiff(null);
            const { phases, grouping: currentGrouping, compare: comparing } = viewOptions.current;
            host.post({ type: "graph", phases, grouping: currentGrouping });
            if (comparing && response.summary.baselineCreatedAt !== null) {
              host.post({ type: "diff", phases, grouping: currentGrouping });
            }
            if (response.summary.baselineCreatedAt === null) setCompare(false);
          }
          runLoaded.current = true;
          loadFailed.current = false;
          setSummary(response.summary);
          setStatus(response.summary.scenarios.length === 0 ? { kind: "empty", message: "This recording has no scenarios." } : { kind: "ready" });
          break;
        case "graph":
          setGraph(response.graph);
          break;
        case "component":
          setDetail({ component: response.view, fn: null });
          break;
        case "function":
          setDetail((current) => ({ component: current.component, fn: response.view }));
          break;
        case "diff":
          setDiff(response.diff);
          break;
        case "replay":
          setSelected(response.scenarioId);
          setReplay({ scenarioId: response.scenarioId, steps: response.steps, index: 0, playing: response.steps.length > 0 });
          break;
      }
    });
    host.post({ type: "ready" });
    host.post({ type: "graph", phases: TEST_BODY_ONLY, grouping: INITIAL_GROUPING });
    return unsubscribe;
  }, [host]);

  // ELK is an external layout engine: run it whenever the displayed graph changes.
  useEffect(() => {
    if (displayed === null) return;
    let cancelled = false;
    setPositions(null);
    layoutGraph(displayed)
      .then((laidOut) => {
        if (!cancelled) setPositions(laidOut);
      })
      .catch((error: unknown) => setNotice(`Layout failed: ${error instanceof Error ? error.message : String(error)}`));
    return () => {
      cancelled = true;
    };
  }, [displayed]);

  // Replay clock.
  const playing = replay?.playing ?? false;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setReplay((current) => {
        if (current === null) return null;
        const next = current.index + 1;
        if (next >= current.steps.length) return { ...current, playing: false };
        return { ...current, index: next };
      });
    }, STEP_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing]);

  if (status.kind !== "ready" || summary === null) {
    return <StatusScreen status={status} onRetry={() => host.post({ type: "reload" })} />;
  }

  const step = replay ? (replay.steps[replay.index] ?? null) : null;
  const replayName = replay ? (summary.scenarios.find((s) => s.id === replay.scenarioId)?.name ?? replay.scenarioId) : "";

  const phases = includeSetup ? WITH_SETUP : TEST_BODY_ONLY;
  // The graph and the replay must be cut into the same boxes, so changing either view
  // option drops a running replay rather than letting it pulse along edges that are gone.
  const requestViews = (nextPhases: Phase[], nextGrouping: Grouping, comparing: boolean) => {
    setReplay(null);
    host.post({ type: "graph", phases: nextPhases, grouping: nextGrouping });
    if (comparing) {
      setDiff(null);
      host.post({ type: "diff", phases: nextPhases, grouping: nextGrouping });
    }
  };
  const toggleSetup = () => {
    const next = !includeSetup;
    setIncludeSetup(next);
    requestViews(next ? WITH_SETUP : TEST_BODY_ONLY, grouping, compare);
  };
  const toggleMiddleware = () => {
    const next = { collapseMiddleware: !grouping.collapseMiddleware };
    setGrouping(next);
    requestViews(phases, next, compare);
  };
  const toggleCompare = () => {
    const next = !compare;
    setCompare(next);
    setReplay(null);
    if (next) {
      setDiff(null); // never show a diff computed for other view options
      host.post({ type: "diff", phases, grouping });
    }
  };
  const nodeChanges = compare && diff ? new Map(diff.nodes.map((node) => [node.id, node.change])) : null;
  const edgeChanges = compare && diff ? new Map(diff.edges.map((edge) => [edge.id, edge.change])) : null;
  const scenarioChanges = compare && diff ? new Map(diff.scenarios.map((scenario) => [scenario.id, scenario.change])) : null;
  const selectedDiff = compare && diff ? (diff.scenarios.find((scenario) => scenario.id === selected) ?? null) : null;
  const openComponent = (node: GraphNode) => host.post({ type: "component", id: node.id, grouping });
  const openFunction = (fn: Pick<FunctionSummary, "module" | "qualname">) => host.post({ type: "function", module: fn.module, qualname: fn.qualname });
  const openSource = (file: string, line: number) => host.post({ type: "openSource", file, line });
  const startReplay = (scenarioId: string) => host.post({ type: "replay", scenarioId, phases, grouping });

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>HexVis</h1>
          <p className="muted">
            {summary.framework ?? "no framework"} · Python {summary.python} · {summary.backend} · {summary.scenarios.length}{" "}
            scenarios
          </p>
          <label className="toggle">
            <input type="checkbox" checked={includeSetup} onChange={toggleSetup} /> Include setup (app startup, fixtures)
          </label>
          <label className="toggle">
            <input type="checkbox" checked={!grouping.collapseMiddleware} onChange={toggleMiddleware} /> Show each middleware
          </label>
          {summary.baselineCreatedAt !== null && (
            <label className="toggle">
              <input type="checkbox" checked={compare} onChange={toggleCompare} /> Compare with previous recording
            </label>
          )}
          {compare && diff && <DiffSummary diff={diff} />}
        </header>
        {summary.problems.length > 0 && (
          <details className="problems">
            <summary>
              {summary.problems.length} recording problem{summary.problems.length === 1 ? "" : "s"}
            </summary>
            <ul>
              {summary.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </details>
        )}
        <ScenarioList
          scenarios={summary.scenarios}
          selected={selected}
          changes={scenarioChanges}
          onSelect={setSelected}
          onReplay={startReplay}
        />
        <Legend />
      </aside>

      <main className="canvas">
        {notice && (
          <div className="notice" role="alert">
            {notice}
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
        {displayed === null || positions === null ? (
          <p className="muted centered">Laying out the system…</p>
        ) : displayed.nodes.length === 0 ? (
          <p className="muted centered">Nothing ran in the selected phases.</p>
        ) : (
          <GraphCanvas
            graph={displayed}
            positions={positions}
            nodeChanges={nodeChanges}
            edgeChanges={edgeChanges}
            selectedScenario={selected}
            step={step}
            stepIndex={replay?.index ?? 0}
            onOpenComponent={openComponent}
          />
        )}
        {replay && (
          <ReplayBar
            scenarioName={replayName}
            steps={replay.steps}
            index={replay.index}
            playing={replay.playing}
            onPlayPause={() =>
              setReplay((current) =>
                current === null
                  ? null
                  : { ...current, playing: !current.playing, index: current.index >= current.steps.length - 1 ? 0 : current.index },
              )
            }
            onSeek={(index) => setReplay((current) => (current === null ? null : { ...current, index, playing: false }))}
            onClose={() => setReplay(null)}
          />
        )}
      </main>

      {(detail.component || detail.fn || selectedDiff) && (
        <aside className="detail" aria-label="Details">
          <nav className="breadcrumbs">
            {detail.fn && detail.component && (
              <button type="button" className="link" onClick={() => setDetail({ component: detail.component, fn: null })}>
                ← {detail.component.label}
              </button>
            )}
            <button type="button" className="link close" onClick={() => setDetail({ component: null, fn: null })}>
              Close ✕
            </button>
          </nav>
          {detail.fn ? (
            <FunctionPanel view={detail.fn} selectedScenario={selected} onSelectScenario={setSelected} onOpenSource={openSource} />
          ) : detail.component ? (
            <ComponentPanel view={detail.component} onOpenFunction={openFunction} />
          ) : selectedDiff ? (
            <ScenarioDiffPanel diff={selectedDiff} onOpenFunction={openFunction} />
          ) : null}
        </aside>
      )}
    </div>
  );
}

function StatusScreen({ status, onRetry }: { status: Status; onRetry: () => void }) {
  if (status.kind === "loading") {
    return <p className="muted centered" role="status">{status.message}</p>;
  }
  return (
    <div className="centered status" role={status.kind === "error" ? "alert" : "status"}>
      <h1>{status.kind === "error" ? "Couldn't load the recording" : "Nothing to show yet"}</h1>
      <p>{status.kind === "ready" ? "" : status.message}</p>
      <button type="button" onClick={onRetry}>
        Reload
      </button>
    </div>
  );
}

function DiffSummary({ diff }: { diff: RunDiff }) {
  const changed = diff.scenarios.filter((scenario) => scenario.change !== Change.Unchanged).length;
  const added = diff.nodes.filter((node) => node.change === Change.Added).length;
  const removed = diff.nodes.filter((node) => node.change === Change.Removed).length;
  return (
    <p className="diff-summary">
      {changed === 0 ? "No journey behaves differently." : changed === 1 ? "1 journey behaves differently" : `${changed} journeys behave differently`}
      {added + removed > 0 && ` · components +${added} −${removed}`}
      {diff.caveats.map((caveat) => (
        <span key={caveat} className="caveat">
          {caveat}
        </span>
      ))}
    </p>
  );
}

function Legend() {
  return (
    <section className="legend-rings" aria-label="Legend">
      <h2>Rings (from runtime behaviour)</h2>
      <ul>
        <li><span className="dot ring-edge" /> framework: entry, middleware, router</li>
        <li><span className="dot ring-inbound-adapter" /> inbound adapter: the framework hands it requests</li>
        <li><span className="dot ring-core" /> core: neither receives requests nor leaves the process</li>
        <li><span className="dot ring-outbound-adapter" /> outbound adapter: calls an external system</li>
        <li><span className="dot ring-test-double" /> test double: test code the app calls</li>
        <li><span className="dot ring-external" /> external system</li>
      </ul>
    </section>
  );
}
