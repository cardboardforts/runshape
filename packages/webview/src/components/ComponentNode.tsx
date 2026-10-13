import { Handle, Node, NodeProps, Position } from "@xyflow/react";

import { Change, GraphNode, Zone } from "@hexvis/core";

import { SMELL_TEXT } from "./ZoneControls";

export type Emphasis = "normal" | "highlighted" | "dimmed";

export type ComponentNodeData = {
  node: GraphNode;
  emphasis: Emphasis;
  active: boolean;
  change: Change | null;
  onOpen: (node: GraphNode) => void;
};

export type ComponentFlowNode = Node<ComponentNodeData, "component">;

const ZONE_LABEL: Record<Zone, string> = {
  [Zone.Edge]: "framework",
  [Zone.InboundAdapter]: "inbound adapter",
  [Zone.Core]: "core",
  [Zone.OutboundAdapter]: "outbound adapter",
  [Zone.TestDouble]: "test double",
  [Zone.External]: "external system",
};

export function ComponentNode({ data }: NodeProps<ComponentFlowNode>) {
  const { node, emphasis, active, change, onOpen } = data;
  const smells = node.smells.map((smell) => SMELL_TEXT[smell]);
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button
        type="button"
        className={`component zone-${node.zone} emphasis-${emphasis}${active ? " active" : ""}${change ? ` change-${change}` : ""}`}
        title={[node.qualifiedName ?? node.label, `${node.zone}: ${node.zoneReason}`, ...smells, ...(change && change !== Change.Unchanged ? [`${change} since the previous recording`] : [])].join("\n")}
        onClick={() => onOpen(node)}
      >
        <span className="component-label">
          {smells.length > 0 && (
            <span className="smell" aria-label={smells.join("; ")}>
              ⚠{" "}
            </span>
          )}
          {node.label}
        </span>
        <span className="component-meta">
          {ZONE_LABEL[node.zone]} · {node.calls} call{node.calls === 1 ? "" : "s"}
          {node.instances > 0 ? ` · ${node.instances} obj` : ""}
        </span>
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}
