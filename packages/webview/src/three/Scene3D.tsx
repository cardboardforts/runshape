import { useEffect, useRef, useState } from "react";

import { Change, ComponentWiring, GraphNode, ObjectGraph, Op, ReplayStep, SystemGraph } from "@runshape/core";

import { Emphasis, HexScene } from "./hex-scene";
import { layoutHexagon } from "./hexagon-layout";

interface Props {
  graph: SystemGraph;
  wiring: ComponentWiring[];
  /** The selected test's objects, one cube each; null shows per-class counts instead. */
  objects: ObjectGraph | null;
  nodeChanges: Map<string, Change> | null;
  edgeChanges: Map<string, Change> | null;
  selectedScenario: string | null;
  step: ReplayStep | null;
  stepOp: Op | null;
  stepIndex: number;
  stepMs: number;
  onOpenComponent: (node: GraphNode) => void;
}

/** The 3D renderer: same inputs as the 2D graph canvas, drawn on a hexagon floor. */
export function Scene3D({ graph, wiring, objects, nodeChanges, edgeChanges, selectedScenario, step, stepOp, stepIndex, stepMs, onOpenComponent }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<HexScene | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The scene is created once; clicks must reach the latest callback, not the first one.
  const onOpen = useRef(onOpenComponent);
  onOpen.current = onOpenComponent;

  // WebGL is an external system: create it once, dispose it on unmount.
  useEffect(() => {
    if (container.current === null) return;
    const background = getComputedStyle(container.current).getPropertyValue("--bg").trim() || "#1e1e1e";
    let created: HexScene;
    try {
      created = new HexScene(container.current, (node) => onOpen.current(node), background);
    } catch (error) {
      // No WebGL (disabled GPU, remote session): say so instead of blanking the view.
      setFailure(error instanceof Error ? error.message : String(error));
      return;
    }
    scene.current = created;
    return () => {
      created.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.setGraph(graph, layoutHexagon(graph));
  }, [graph]);

  useEffect(() => {
    scene.current?.setObjects(wiring, objects);
  }, [graph, wiring, objects]);

  useEffect(() => {
    const emphasisOf = (scenarioIds: string[]): Emphasis => {
      if (selectedScenario === null) return "normal";
      return scenarioIds.includes(selectedScenario) ? "highlighted" : "dimmed";
    };
    const edgeScenarios = new Map(graph.edges.map((edge) => [edge.id, edge.scenarioIds]));
    const active = new Set(step ? [step.from, step.to] : []);
    scene.current?.setEmphasis(
      (node) => emphasisOf(node.scenarioIds),
      (edgeId) => emphasisOf(edgeScenarios.get(edgeId) ?? []),
      active,
      nodeChanges,
      edgeChanges,
    );
    // wiring/objects: setObjects rebuilds the cubes and lines, which then need their emphasis.
  }, [graph, wiring, objects, selectedScenario, step, nodeChanges, edgeChanges]);

  useEffect(() => {
    if (step) scene.current?.pulse(step.edgeId, step.kind, stepOp, stepMs);
    // stepIndex: the same edge twice in a row must still pulse twice. Not stepMs: switching
    // the pace mid-step must not fire the same pulse again.
  }, [step, stepOp, stepIndex]);

  return (
    <div ref={container} className="scene3d" aria-label="3D view of the system: drag to orbit, scroll to zoom">
      {failure && (
        <p className="centered" role="alert">
          The 3D view needs WebGL, which isn't available here ({failure}). Untick 3D to use the 2D view.
        </p>
      )}
    </div>
  );
}
