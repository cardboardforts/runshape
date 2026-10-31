import { useState } from "react";
import { Background, Controls, NodeChange, ReactFlow } from "@xyflow/react";

import { Change, FlatPoint, Layout, LayoutNode } from "@runshape/kernel";
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
  /** A box dropped somewhere else: kept there (saved by the session) from now on. */
  onMove: (node: LayoutNode, to: FlatPoint) => void;
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
  onMove,
}: Props) {
  // Only the box being dragged, while it's dragged: where it is comes from the layout otherwise.
  const [dragging, setDragging] = useState<{ id: string; at: FlatPoint } | null>(null);
  const followDrag = (changes: NodeChange<ComponentFlowNode>[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.dragging && change.position) setDragging({ id: change.id, at: change.position });
    }
  };
  const drop = (id: string) => {
    const node = layout.nodes.find((candidate) => candidate.id === id);
    if (node !== undefined && dragging !== null && dragging.id === id) onMove(node, dragging.at);
    setDragging(null);
  };

  const emphasisOf = (scenarioIds: string[]): Emphasis => {
    if (selectedScenario === null) return "normal";
    return scenarioIds.includes(selectedScenario) ? "highlighted" : "dimmed";
  };

  const nodes: ComponentFlowNode[] = layout.nodes.map((node) => ({
    id: node.id,
    type: "component",
    position: dragging?.id === node.id ? dragging.at : node.flat,
    data: {
      node,
      profile: layout.profile,
      vertical: layout.direction === "down",
      emphasis: emphasisOf(node.scenarioIds),
      active: step !== null && (step.from === node.id || step.to === node.id),
      change: nodeChanges?.get(node.id) ?? null,
      onOpen: onOpenComponent,
    },
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
      nodesDraggable
      onNodesChange={followDrag}
      onNodeDragStop={(_event, node) => drop(node.id)}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
