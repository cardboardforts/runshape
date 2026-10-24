import { Handle, Node, NodeProps, Position } from "@xyflow/react";

import { ArchitectureProfile, GraphNode } from "@runshape/core";
import { Change } from "@runshape/views";

import { zoneClass, zoneLabel } from "../zone-style";

import { smellText } from "./ZoneControls";

export type Emphasis = "normal" | "highlighted" | "dimmed";

export type ComponentNodeData = {
  node: GraphNode;
  profile: ArchitectureProfile;
  /** Edges enter at the top and leave at the bottom, for styles drawn top to bottom. */
  vertical: boolean;
  emphasis: Emphasis;
  active: boolean;
  change: Change | null;
  onOpen: (node: GraphNode) => void;
};

export type ComponentFlowNode = Node<ComponentNodeData, "component">;

export function ComponentNode({ data }: NodeProps<ComponentFlowNode>) {
  const { node, profile, vertical, emphasis, active, change, onOpen } = data;
  const smells = node.smells.map((smell) => smellText(profile, node, smell));
  return (
    <>
      <Handle type="target" position={vertical ? Position.Top : Position.Left} isConnectable={false} />
      <button
        type="button"
        className={`component ${zoneClass(profile, node.zone)} emphasis-${emphasis}${active ? " active" : ""}${change ? ` change-${change}` : ""}`}
        title={[node.qualifiedName ?? node.label, `${zoneLabel(profile, node.zone)}: ${node.zoneReason}`, ...smells, ...(change && change !== Change.Unchanged ? [`${change} since the previous recording`] : [])].join("\n")}
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
          {zoneLabel(profile, node.zone)} · {node.calls} call{node.calls === 1 ? "" : "s"}
          {node.instances > 0 ? ` · ${node.instances} obj` : ""}
        </span>
      </button>
      <Handle type="source" position={vertical ? Position.Bottom : Position.Right} isConnectable={false} />
    </>
  );
}
