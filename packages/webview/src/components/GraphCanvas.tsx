import { Background, Controls, ReactFlow } from "@xyflow/react";

import { Change, Layout, LayoutNode } from "@runshape/kernel";
import { Op, ReplayStep } from "@runshape/trace";

import { ComponentFlowNode, ComponentNode, Emphasis } from "./ComponentNode";
import { PulseEdge, PulseFlowEdge } from "./PulseEdge";

const nodeTypes = { component: ComponentNode };

const edgeTypes = { pulse: PulseEdge };

interface Props {
  /** Placed by the session: each box's flat position is drawn as given. */
  layout: Layout;
  /** Compare mode only: how each node and edge differs from the previous recording. */
  nodeChanges: Map<string, Change> | null;
  edgeChanges: Map<string, Change> | null;
  selectedScenario: string | null;
  step: ReplayStep | null;
  stepOp: Op | null;
  stepIndex: number;
  /** How long this step plays; its pulse takes as long to cross the edge. */
  stepMs: number;
  onOpenComponent: (node: LayoutNode) => void;
}

export function GraphCanvas({
  layout,
  nodeChanges,
  edgeChanges,
  selectedScenario,
  step,
  stepOp,
  stepIndex,
  stepMs,
  onOpenComponent,
}: Props) {
  const emphasisOf = (scenarioIds: string[]): Emphasis => {
    if (selectedScenario === null) return "normal";
    return scenarioIds.includes(selectedScenario) ? "highlighted" : "dimmed";
  };

  const nodes: ComponentFlowNode[] = layout.nodes.map((node) => ({
    id: node.id,
    type: "component",
    position: node.flat,
    data: {
      node,
      profile: layout.profile,
      vertical: layout.direction === "down",
      emphasis: emphasisOf(node.scenarioIds),
      active: step !== null && (step.from === node.id || step.to === node.id),
      change: nodeChanges?.get(node.id) ?? null,
      onOpen: onOpenComponent,
    },
    draggable: false,
    connectable: false,
  }));

  const edges: PulseFlowEdge[] = layout.edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    type: "pulse",
    data: {
      calls: edge.calls,
      emphasis: emphasisOf(edge.scenarioIds),
      change: edgeChanges?.get(edge.id) ?? null,
      violation: edge.violation,
      pulse: step !== null && step.edgeId === edge.id ? { key: stepIndex, kind: step.kind, op: stepOp, durationMs: stepMs } : null,
    },
  }));

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      minZoom={0.1}
      nodesConnectable={false}
      nodesDraggable={false}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
