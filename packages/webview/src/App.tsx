import { useEffect, useMemo, useRef, useState } from "react";

import {
  CallStep,
  Change,
  ExecutionDiff,
  FunctionExecutionDiff,
  MergedReplayStep,
  Op,
  ComponentView,
  ComponentWiring,
  ObjectGraph,
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
import { AdviceState, RingControls } from "./components/RingControls";
import { FunctionPanel } from "./components/FunctionPanel";
import { GraphCanvas } from "./components/GraphCanvas";
import { ReplayBar } from "./components/ReplayBar";
import { ScenarioDiffPanel } from "./components/ScenarioDiffPanel";
import { FunctionExecutionPanel } from "./components/ExecutionDiffView";
import { ScenarioList } from "./components/ScenarioList";
import type { Host } from "./host";
import { layoutGraph, Positioned } from "./layout";
import { Scene3D } from "./three/Scene3D";

type Status =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "ready" };

interface Replay {
  scenarioId: string;
  steps: ReplayStep[];
  /** Set when replaying a change (before and after merged). */
  ops: Op[] | null;
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
  // Bumped per layout: the canvas remounts and fits the new layout instead of keeping a
  // viewport chosen for the previous one.
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail>({ component: null, fn: null });
  const [replay, setReplay] = useState<Replay | null>(null);
  const [compare, setCompare] = useState(false);
  const [threeD, setThreeD] = useState(false);
  const [wiring, setWiring] = useState<ComponentWiring[]>([]);
  const [objectGraph, setObjectGraph] = useState<ObjectGraph | null>(null);
  const [diff, setDiff] = useState<RunDiff | null>(null);
  const [execution, setExecution] = useState<{ diff: ExecutionDiff; replay: MergedReplayStep[] } | null>(null);
  const [executionFn, setExecutionFn] = useState<FunctionExecutionDiff | null>(null);
  const [advice, setAdvice] = useState<{ componentId: string; state: AdviceState }>({ componentId: "", state: { kind: "idle" } });
  const openComponentId = useRef<string | null>(null);
  // Kept apart from the summary, which only arrives when a recording loads.
  const [ruleCount, setRuleCount] = useState(0);
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
            setExecution(null);
            setExecutionFn(null);
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
          setRuleCount(response.summary.ringRules);
          setStatus(response.summary.scenarios.length === 0 ? { kind: "empty", message: "This recording has no scenarios." } : { kind: "ready" });
          break;
        case "graph":
          setGraph(response.graph);
          setWiring(response.wiring);
          break;
        case "objects":
          setObjectGraph(response.graph);
          break;
        case "component":
          openComponentId.current = response.view.id;
          setDetail({ component: response.view, fn: null });
          break;
        case "function":
          setDetail((current) => ({ component: current.component, fn: response.view }));
          break;
        case "diff":
          setDiff(response.diff);
          break;
        case "rulesChanged": {
          setRuleCount(response.count);
          // Rings changed: everything coloured by ring is stale.
          const { phases, grouping: currentGrouping, compare: comparing } = viewOptions.current;
          setAdvice({ componentId: "", state: { kind: "idle" } });
          host.post({ type: "graph", phases, grouping: currentGrouping });
          if (comparing) host.post({ type: "diff", phases, grouping: currentGrouping });
          if (openComponentId.current !== null) host.post({ type: "component", id: openComponentId.current, grouping: currentGrouping });
          break;
        }
        case "ringAdvice":
          setAdvice({ componentId: response.componentId, state: { kind: "proposed", advice: response.advice } });
          break;
        case "ringAdviceFailed":
          setAdvice({ componentId: response.componentId, state: { kind: "failed", message: response.message } });
          break;
        case "replay":
          setSelected(response.scenarioId);
          setReplay({ scenarioId: response.scenarioId, steps: response.steps, ops: null, index: 0, playing: response.steps.length > 0 });
          break;
        case "executionDiff":
          setExecution({ diff: response.diff, replay: response.replay });
          break;
        case "functionExecutionDiff":
          setExecutionFn(response.diff);
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
        if (cancelled) return;
        setPositions(laidOut);
        setLayoutVersion((version) => version + 1);
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
      if (selected !== null) requestExecution(selected);
    }
  };
  const requestExecution = (scenarioId: string) => {
    setExecution(null);
    setExecutionFn(null);
    host.post({ type: "executionDiff", scenarioId, phases, grouping });
  };
  const selectScenario = (scenarioId: string | null) => {
    setSelected(scenarioId);
    setObjectGraph(null);
    if (compare && scenarioId !== null) requestExecution(scenarioId);
    if (threeD && scenarioId !== null) host.post({ type: "objects", scenarioId });
  };
  const toggleThreeD = () => {
    const next = !threeD;
    setThreeD(next);
    if (next && selected !== null) host.post({ type: "objects", scenarioId: selected });
  };
  const openCall = (call: CallStep) =>
    selected !== null &&
    host.post({ type: "functionExecutionDiff", scenarioId: selected, module: call.module, qualname: call.qualname, phases });
  const replayChange = () =>
    execution &&
    selected !== null &&
    setReplay({
      scenarioId: selected,
      steps: execution.replay.map((merged) => merged.step),
      ops: execution.replay.map((merged) => merged.op),
      index: 0,
      playing: execution.replay.length > 0,
    });
  const nodeChanges = compare && diff ? new Map(diff.nodes.map((node) => [node.id, node.change])) : null;
  const edgeChanges = compare && diff ? new Map(diff.edges.map((edge) => [edge.id, edge.change])) : null;
  const scenarioChanges = compare && diff ? new Map(diff.scenarios.map((scenario) => [scenario.id, scenario.change])) : null;
  const componentNode = detail.component ? (displayed?.nodes.find((node) => node.id === detail.component?.id) ?? null) : null;
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
          <label className="toggle">
            <input type="checkbox" checked={threeD} onChange={toggleThreeD} /> 3D (hexagon floor)
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
          onSelect={selectScenario}
          onReplay={startReplay}
        />
        <Legend ruleCount={ruleCount} />
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
        {displayed !== null && displayed.nodes.length > 0 && threeD ? (
          <Scene3D
            graph={displayed}
            wiring={wiring}
            objects={objectGraph?.scenarioId === selected ? objectGraph : null}
            nodeChanges={nodeChanges}
            edgeChanges={edgeChanges}
            selectedScenario={selected}
            step={step}
            stepOp={replay?.ops?.[replay.index] ?? null}
            stepIndex={replay?.index ?? 0}
            onOpenComponent={openComponent}
          />
        ) : displayed === null || positions === null ? (
          <p className="muted centered">Laying out the system…</p>
        ) : displayed.nodes.length === 0 ? (
          <p className="muted centered">Nothing ran in the selected phases.</p>
        ) : (
          <GraphCanvas
            key={layoutVersion}
            graph={displayed}
            positions={positions}
            nodeChanges={nodeChanges}
            edgeChanges={edgeChanges}
            selectedScenario={selected}
            step={step}
            stepOp={replay?.ops?.[replay.index] ?? null}
            stepIndex={replay?.index ?? 0}
            onOpenComponent={openComponent}
          />
        )}
        {replay && (
          <ReplayBar
            scenarioName={replayName}
            steps={replay.steps}
            ops={replay.ops}
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
            <button
              type="button"
              className="link close"
              onClick={() => {
                openComponentId.current = null;
                setDetail({ component: null, fn: null });
              }}
            >
              Close ✕
            </button>
          </nav>
          {detail.fn ? (
            <FunctionPanel view={detail.fn} selectedScenario={selected} onSelectScenario={setSelected} onOpenSource={openSource} />
          ) : detail.component ? (
            <ComponentPanel
              view={detail.component}
              onOpenFunction={openFunction}
              relations={<Holdings componentId={detail.component.id} wiring={wiring} graph={displayed} />}
              ring={
                componentNode && (
                  <RingControls
                    // A new ring (after saving a rule) starts the form afresh.
                    key={`${componentNode.id}|${componentNode.ring}|${componentNode.ringReason}`}
                    node={componentNode}
                    canEdit={summary.canEditRules}
                    canAdvise={summary.canAdviseRings}
                    advice={advice.componentId === componentNode.id ? advice.state : { kind: "idle" }}
                    onSetRing={(ring, reason, by) =>
                      componentNode.qualifiedName !== null &&
                      host.post({ type: "setRing", qualifiedName: componentNode.qualifiedName, ring, reason, by })
                    }
                    onAskAdvice={() => {
                      setAdvice({ componentId: componentNode.id, state: { kind: "asking" } });
                      host.post({ type: "adviseRing", componentId: componentNode.id, grouping });
                    }}
                    onDismissAdvice={() => setAdvice({ componentId: "", state: { kind: "idle" } })}
                  />
                )
              }
            />
          ) : executionFn && selectedDiff ? (
            <>
              <button type="button" className="link" onClick={() => setExecutionFn(null)}>
                ← {selectedDiff.name}
              </button>
              <FunctionExecutionPanel diff={executionFn} />
            </>
          ) : selectedDiff ? (
            <ScenarioDiffPanel
              diff={selectedDiff}
              execution={execution?.diff.scenarioId === selectedDiff.id ? execution.diff : null}
              onOpenFunction={openFunction}
              onOpenCall={openCall}
              onReplayChange={replayChange}
            />
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

/** What this component's objects hold, and what holds them: the runtime wiring, by attribute. */
function Holdings({ componentId, wiring, graph }: { componentId: string; wiring: ComponentWiring[]; graph: SystemGraph | null }) {
  const label = (id: string) => graph?.nodes.find((node) => node.id === id)?.label ?? id.replace(/^class:/, "");
  const holds = wiring.filter((w) => w.from === componentId);
  const heldBy = wiring.filter((w) => w.to === componentId);
  if (holds.length + heldBy.length === 0) return null;
  return (
    <div className="holdings">
      {holds.length > 0 && (
        <p>
          <strong>Holds</strong>{" "}
          {holds.map((w) => `${label(w.to)} (via ${w.attributes.join(", ")})`).join(" · ")}
        </p>
      )}
      {heldBy.length > 0 && (
        <p>
          <strong>Held by</strong> {heldBy.map((w) => `${label(w.from)} (as ${w.attributes.join(", ")})`).join(" · ")}
        </p>
      )}
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

function Legend({ ruleCount }: { ruleCount: number }) {
  return (
    <section className="legend-rings" aria-label="Legend">
      <h2>
        Rings{" "}
        {ruleCount > 0
          ? `(${ruleCount} rule${ruleCount === 1 ? "" : "s"} in hexvis.json, the rest inferred)`
          : "(inferred from runtime behaviour)"}
      </h2>
      <ul>
        <li><span className="dot ring-edge" /> framework: entry, middleware, router</li>
        <li><span className="dot ring-inbound-adapter" /> inbound adapter: the framework hands it requests</li>
        <li><span className="dot ring-core" /> core: neither receives requests nor leaves the process</li>
        <li><span className="dot ring-outbound-adapter" /> outbound adapter: calls an external system</li>
        <li><span className="dot ring-test-double" /> test double: test code the app calls</li>
        <li><span className="dot ring-external" /> external system</li>
        <li><span className="line-violation" /> call against the onion (hover it)</li>
      </ul>
    </section>
  );
}
