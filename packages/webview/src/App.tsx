import { useEffect, useMemo, useRef, useState } from "react";

import {
  ArchitectureCandidate,
  ArchitectureProfile,
  ArchitectureStyle,
  PROFILES,
  describeGap,
  ReplayPace,
  stepDurationsMs,
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
  ReviewCategory,
  ReviewSummary,
  RunDiff,
  RunSummary,
  SystemGraph,
  Timeline,
  UiResponse,
} from "@runshape/core";

import { ComponentPanel } from "./components/ComponentPanel";
import { AdviceState, ZoneControls } from "./components/ZoneControls";
import { ArchitecturePanel, ModelAdvice } from "./components/ArchitecturePanel";
import { TimelinePanel } from "./components/TimelinePanel";
import { FunctionPanel } from "./components/FunctionPanel";
import { GraphCanvas } from "./components/GraphCanvas";
import { ReplayBar } from "./components/ReplayBar";
import { ScenarioDiffPanel } from "./components/ScenarioDiffPanel";
import { FunctionExecutionPanel } from "./components/ExecutionDiffView";
import { ScenarioList } from "./components/ScenarioList";
import type { Host } from "./host";
import { layoutGraph, Positioned } from "./layout";
import { zoneClass, zoneColor } from "./zone-style";
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
  const [pace, setPace] = useState(ReplayPace.Even);
  const [layoutFailure, setLayoutFailure] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [threeD, setThreeD] = useState(false);
  const [wiring, setWiring] = useState<ComponentWiring[]>([]);
  const [objectGraph, setObjectGraph] = useState<ObjectGraph | null>(null);
  const [diff, setDiff] = useState<RunDiff | null>(null);
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [execution, setExecution] = useState<{ diff: ExecutionDiff; replay: MergedReplayStep[] } | null>(null);
  const [executionFn, setExecutionFn] = useState<FunctionExecutionDiff | null>(null);
  const [advice, setAdvice] = useState<{ componentId: string; state: AdviceState }>({ componentId: "", state: { kind: "idle" } });
  const openComponentId = useRef<string | null>(null);
  // Kept apart from the summary, which only arrives when a recording loads.
  const [ruleCount, setRuleCount] = useState(0);
  // Read inside the host listener, which is subscribed once and would see stale state.
  const runLoaded = useRef(false);
  const loadFailed = useRef(false);
  // The style to draw in when it isn't runshape.json's own; never saved.
  const [drawStyle, setDrawStyle] = useState<string | undefined>(undefined);
  // Closed: null. Open: the ranked candidates, or null inside while the session ranks them.
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [detection, setDetection] = useState<{ candidates: ArchitectureCandidate[] | null } | null>(null);
  const [modelAdvice, setModelAdvice] = useState<ModelAdvice>({ kind: "idle" });
  const viewOptions = useRef<{ phases: Phase[]; grouping: Grouping; compare: boolean; style: string | undefined }>({
    phases: TEST_BODY_ONLY,
    grouping: INITIAL_GROUPING,
    compare: false,
    style: undefined,
  });
  viewOptions.current = { phases: includeSetup ? WITH_SETUP : TEST_BODY_ONLY, grouping, compare, style: drawStyle };

  // In compare mode the canvas shows the union of both recordings. Memoised only so the
  // layout effect below sees a stable object, not a new one every render.
  const displayed = useMemo<SystemGraph | null>(
    () => (compare && diff !== null ? { nodes: diff.nodes, edges: diff.edges, profile: diff.profile } : graph),
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
            setObjectGraph(null);
            const { phases, grouping: currentGrouping, compare: comparing, style } = viewOptions.current;
            host.post({ type: "graph", phases, grouping: currentGrouping, style });
            if (comparing && response.summary.baselineCreatedAt !== null) {
              host.post({ type: "diff", phases, grouping: currentGrouping, style });
            }
            if (response.summary.baselineCreatedAt === null) setCompare(false);
          }
          runLoaded.current = true;
          loadFailed.current = false;
          setSummary(response.summary);
          setRuleCount(response.summary.zoneRules);
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
          setReview(response.review);
          break;
        case "rulesChanged": {
          setRuleCount(response.count);
          // Adopting a style makes it the file's own: the default drawing, no preview left over.
          setSummary((current) => (current === null || current.style === response.style ? current : { ...current, style: response.style as ArchitectureStyle }));
          if (viewOptions.current.style === response.style) {
            setDrawStyle(undefined);
            viewOptions.current.style = undefined;
          }
          // Zones changed: everything coloured by zone is stale.
          const { phases, grouping: currentGrouping, compare: comparing, style } = viewOptions.current;
          setAdvice({ componentId: "", state: { kind: "idle" } });
          host.post({ type: "graph", phases, grouping: currentGrouping, style });
          if (comparing) host.post({ type: "diff", phases, grouping: currentGrouping, style });
          if (openComponentId.current !== null) host.post({ type: "component", id: openComponentId.current, grouping: currentGrouping });
          break;
        }
        case "timeline":
          setTimeline(response.timeline);
          break;
        case "architecture":
          setDetection({ candidates: response.candidates });
          break;
        case "architectureAdvice":
          setModelAdvice({ kind: "proposed", style: response.style, reason: response.reason, confidence: response.confidence, rules: response.rules });
          break;
        case "architectureAdviceFailed":
          setModelAdvice({ kind: "failed", message: response.message });
          break;
        case "zoneAdvice":
          setAdvice({ componentId: response.componentId, state: { kind: "proposed", advice: response.advice } });
          break;
        case "zoneAdviceFailed":
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
    setLayoutFailure(null);
    layoutGraph(displayed)
      .then((laidOut) => {
        if (cancelled) return;
        setPositions(laidOut);
        setLayoutVersion((version) => version + 1);
      })
      .catch((error: unknown) => {
        // Otherwise the canvas would say "Laying out…" for ever.
        if (!cancelled) setLayoutFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [displayed]);

  // Replay clock: each step lasts its own duration. A change replay interleaves two
  // recordings whose clocks don't compare, so it always plays evenly.
  const playing = replay?.playing ?? false;
  const replaySteps = replay?.steps ?? null;
  const effectivePace = replay?.ops ? ReplayPace.Even : pace;
  const stepMs = useMemo(() => (replaySteps ? stepDurationsMs(replaySteps, effectivePace) : []), [replaySteps, effectivePace]);
  const replayIndex = replay?.index ?? 0;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      setReplay((current) => {
        if (current === null) return null;
        const next = current.index + 1;
        if (next >= current.steps.length) return { ...current, playing: false };
        return { ...current, index: next };
      });
    }, stepMs[replayIndex] ?? 0);
    return () => window.clearTimeout(timer);
  }, [playing, replayIndex, stepMs]);

  // Memoised so the 3D scene's emphasis effect, which depends on them, doesn't rerun on every
  // render (each replay tick). Hooks, so above the early return.
  const nodeChanges = useMemo(() => (compare && diff ? new Map(diff.nodes.map((node) => [node.id, node.change])) : null), [compare, diff]);
  const edgeChanges = useMemo(() => (compare && diff ? new Map(diff.edges.map((edge) => [edge.id, edge.change])) : null), [compare, diff]);

  if (status.kind !== "ready" || summary === null) {
    return <StatusScreen status={status} onRetry={() => host.post({ type: "reload" })} />;
  }

  const step = replay ? (replay.steps[replay.index] ?? null) : null;
  const replayClock = replay !== null && replay.ops === null && replay.scenarioId === selected && step !== null;
  const replayName = replay ? (summary.scenarios.find((s) => s.id === replay.scenarioId)?.name ?? replay.scenarioId) : "";

  const phases = includeSetup ? WITH_SETUP : TEST_BODY_ONLY;
  // The graph and the replay must be cut into the same boxes, so changing either view
  // option drops a running replay rather than letting it pulse along edges that are gone.
  const requestViews = (nextPhases: Phase[], nextGrouping: Grouping, comparing: boolean, style = drawStyle) => {
    setReplay(null);
    host.post({ type: "graph", phases: nextPhases, grouping: nextGrouping, style });
    if (comparing) {
      // Every compare view depends on the options; none may outlive them.
      setDiff(null);
      setExecution(null);
      setExecutionFn(null);
      host.post({ type: "diff", phases: nextPhases, grouping: nextGrouping, style });
      if (selected !== null) host.post({ type: "executionDiff", scenarioId: selected, phases: nextPhases, grouping: nextGrouping });
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
  const changeStyle = (style: string) => {
    const next = style === summary.style ? undefined : style;
    setDrawStyle(next);
    requestViews(phases, grouping, compare, next);
  };
  const toggleCompare = () => {
    const next = !compare;
    setCompare(next);
    setReplay(null);
    if (next) {
      setDiff(null); // never show a diff computed for other view options
      host.post({ type: "diff", phases, grouping, style: drawStyle });
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
  const reviewCategories = compare && review ? new Map(review.items.map((item) => [item.scenarioId, item.category])) : null;
  const componentNode = detail.component ? (displayed?.nodes.find((node) => node.id === detail.component?.id) ?? null) : null;
  const selectedDiff = compare && diff ? (diff.scenarios.find((scenario) => scenario.id === selected) ?? null) : null;
  const openComponent = (node: GraphNode) => host.post({ type: "component", id: node.id, grouping });
  const openFunction = (fn: Pick<FunctionSummary, "module" | "qualname">) => host.post({ type: "function", module: fn.module, qualname: fn.qualname });
  const openSource = (file: string, line: number) => host.post({ type: "openSource", file, line });
  const startReplay = (scenarioId: string) => host.post({ type: "replay", scenarioId, phases, grouping });
  const openTimeline = (scenarioId: string) => {
    setDetail({ component: null, fn: null });
    host.post({ type: "timeline", scenarioId, phases, grouping });
  };
  // Shown only for the selected scenario: another selection leaves it behind.
  const shownTimeline = timeline !== null && timeline.scenarioId === selected ? timeline : null;
  const zoneColorOf = (componentId: string) => {
    const node = displayed?.nodes.find((candidate) => candidate.id === componentId);
    return node && displayed ? `#${zoneColor(displayed.profile, node.zone).toString(16).padStart(6, "0")}` : "#8a8f98";
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>Runshape</h1>
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
            <input type="checkbox" checked={threeD} onChange={toggleThreeD} /> 3D
          </label>
          <label className="style-picker">
            Draw as
            <select value={drawStyle ?? summary.style} onChange={(event) => changeStyle(event.target.value)}>
              {PROFILES.map((profile) => (
                <option key={profile.style} value={profile.style}>
                  {profile.name}
                  {profile.style === summary.style ? " — runshape.json" : ""}
                </option>
              ))}
            </select>
          </label>
          {detection === null ? (
            <button
              type="button"
              className="link"
              onClick={() => {
                setDetection({ candidates: null });
                host.post({ type: "detectArchitecture" });
              }}
            >
              Detect the shape from this recording…
            </button>
          ) : (
            <ArchitecturePanel
              candidates={detection.candidates}
              drawnStyle={drawStyle ?? summary.style}
              canAdopt={summary.canEditRules}
              canAsk={summary.canAdviseZones}
              advice={modelAdvice}
              onPreview={changeStyle}
              onAdopt={(style, from) => host.post({ type: "adoptArchitecture", style, from })}
              onAsk={() => {
                setModelAdvice({ kind: "asking" });
                host.post({ type: "adviseArchitecture" });
              }}
              onClose={() => setDetection(null)}
            />
          )}
          {summary.baselineCreatedAt !== null && (
            <label className="toggle">
              <input type="checkbox" checked={compare} onChange={toggleCompare} /> Compare with previous recording
            </label>
          )}
          {compare && diff && review && <DiffSummary diff={diff} review={review} />}
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
          review={reviewCategories}
          onSelect={selectScenario}
          onReplay={startReplay}
          onTimeline={openTimeline}
        />
        <Legend ruleCount={ruleCount} profile={displayed?.profile ?? null} />
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
            stepMs={stepMs[replayIndex] ?? 0}
            // Only the replayed scenario's own objects run on its clock (each test's times start
            // at zero); a change replay interleaves two recordings whose clocks don't mix.
            clockUs={replayClock ? step!.tUs : null}
            focusObject={replayClock ? (step!.objectId ?? null) : null}
            onOpenComponent={openComponent}
          />
        ) : displayed === null || positions === null ? (
          <p className={layoutFailure ? "centered" : "muted centered"} role={layoutFailure ? "alert" : "status"}>
            {layoutFailure ? `Couldn't lay this graph out in 2D (${layoutFailure}). The 3D view doesn't need this layout.` : "Laying out the system…"}
          </p>
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
            stepMs={stepMs[replayIndex] ?? 0}
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
            pace={effectivePace}
            paceFixed={replay.ops !== null}
            gap={describeGap(replay.steps, replay.index)}
            onPace={setPace}
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

      {(detail.component || detail.fn || shownTimeline || selectedDiff) && (
        <aside className="detail" aria-label="Details">
          <nav className="breadcrumbs">
            {detail.fn && detail.component && (
              <button type="button" className="link" onClick={() => setDetail({ component: detail.component, fn: null })}>
                ← {detail.component.label}
              </button>
            )}
            {detail.fn && !detail.component && shownTimeline && (
              <button type="button" className="link" onClick={() => setDetail({ component: null, fn: null })}>
                ← Timeline
              </button>
            )}
            <button
              type="button"
              className="link close"
              onClick={() => {
                openComponentId.current = null;
                setDetail({ component: null, fn: null });
                setTimeline(null);
              }}
            >
              Close ✕
            </button>
          </nav>
          {detail.fn ? (
            <FunctionPanel view={detail.fn} selectedScenario={selected} onSelectScenario={selectScenario} onOpenSource={openSource} />
          ) : detail.component ? (
            <ComponentPanel
              view={detail.component}
              onOpenFunction={openFunction}
              relations={<Holdings componentId={detail.component.id} wiring={wiring} graph={displayed} />}
              zone={
                componentNode &&
                displayed && (
                  <ZoneControls
                    // A new zone (after saving a rule) starts the form afresh.
                    key={`${componentNode.id}|${componentNode.zone}|${componentNode.zoneReason}`}
                    node={componentNode}
                    profile={displayed.profile}
                    // Rules are saved in runshape.json's style; drawn in another, the zones on offer aren't its.
                    canEdit={summary.canEditRules && displayed.profile.style === summary.style}
                    canAdvise={summary.canAdviseZones}
                    advice={advice.componentId === componentNode.id ? advice.state : { kind: "idle" }}
                    onSetZone={(zone, reason, by) =>
                      componentNode.qualifiedName !== null &&
                      host.post({ type: "setZone", qualifiedName: componentNode.qualifiedName, zone, reason, by })
                    }
                    onAskAdvice={() => {
                      setAdvice({ componentId: componentNode.id, state: { kind: "asking" } });
                      host.post({ type: "adviseZone", componentId: componentNode.id, grouping });
                    }}
                    onDismissAdvice={() => setAdvice({ componentId: "", state: { kind: "idle" } })}
                  />
                )
              }
            />
          ) : shownTimeline ? (
            <TimelinePanel
              key={shownTimeline.scenarioId}
              timeline={shownTimeline}
              scenarioName={summary.scenarios.find((s) => s.id === shownTimeline.scenarioId)?.name ?? shownTimeline.scenarioId}
              colorOf={zoneColorOf}
              onOpenFunction={(module, qualname) => openFunction({ module, qualname })}
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

function DiffSummary({ diff, review }: { diff: RunDiff; review: ReviewSummary }) {
  const added = diff.nodes.filter((node) => node.change === Change.Added).length;
  const removed = diff.nodes.filter((node) => node.change === Change.Removed).length;
  const counts = review.counts;
  const parts = [
    counts[ReviewCategory.NowFailing] ? `${counts[ReviewCategory.NowFailing]} now failing` : "",
    counts[ReviewCategory.SilentChange] ? `${counts[ReviewCategory.SilentChange]} still passing but run differently` : "",
    counts[ReviewCategory.NowPassing] ? `${counts[ReviewCategory.NowPassing]} now passing` : "",
    counts[ReviewCategory.NowSkipped] ? `${counts[ReviewCategory.NowSkipped]} no longer run` : "",
    counts[ReviewCategory.StillFailing] ? `${counts[ReviewCategory.StillFailing]} still failing` : "",
    counts[ReviewCategory.Added] ? `${counts[ReviewCategory.Added]} new` : "",
    counts[ReviewCategory.Removed] ? `${counts[ReviewCategory.Removed]} removed` : "",
  ].filter(Boolean);
  return (
    <p className="diff-summary">
      {parts.length === 0 ? "No test behaves differently." : parts.join(" · ")}
      {added + removed > 0 && ` · components +${added} −${removed}`}
      {diff.caveats.map((caveat) => (
        <span key={caveat} className="caveat">
          {caveat}
        </span>
      ))}
    </p>
  );
}

function Legend({ ruleCount, profile }: { ruleCount: number; profile: ArchitectureProfile | null }) {
  return (
    <section className="legend-zones" aria-label="Legend">
      <h2>
        Zones{" "}
        {ruleCount > 0
          ? `(${ruleCount} rule${ruleCount === 1 ? "" : "s"} in runshape.json, the rest inferred)`
          : "(inferred from runtime behaviour)"}
      </h2>
      <ul>
        <li><span className="dot zone-edge" /> framework: entry, middleware, router</li>
        {profile?.zones.map((zone) => (
          <li key={zone.id}>
            <span className={`dot ${zoneClass(profile, zone.id)}`} /> {zone.name.toLowerCase()}: {zone.meaning}
          </li>
        ))}
        <li><span className="dot zone-test-double" /> test double: test code the app calls</li>
        <li><span className="dot zone-external" /> external system</li>
        <li><span className="line-violation" /> call against {profile ? profile.name : "the architecture"} (hover it)</li>
      </ul>
    </section>
  );
}
