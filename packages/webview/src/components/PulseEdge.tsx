import { BaseEdge, Edge, EdgeProps, getBezierPath } from "@xyflow/react";

import { Change, StepKind } from "@hexvis/core";

import type { Emphasis } from "./ComponentNode";

export type Pulse = {
  /** Changes on every replay step so the animation restarts even on the same edge. */
  key: number;
  kind: StepKind;
};

export type PulseEdgeData = {
  calls: number;
  emphasis: Emphasis;
  change: Change | null;
  pulse: Pulse | null;
};

export type PulseFlowEdge = Edge<PulseEdgeData, "pulse">;

const PULSE_DURATION = "0.45s";

/** An edge whose thickness grows with traffic, and that can carry a pulse of light. */
export function PulseEdge(props: EdgeProps<PulseFlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, id } = props;
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const calls = data?.calls ?? 1;
  const emphasis = data?.emphasis ?? "normal";
  const pulse = data?.pulse ?? null;
  const change = data?.change ?? null;
  // Log scale: one call is a hairline, a thousand is thick but not a wall.
  const width = 1 + Math.log2(calls + 1) * 0.8;
  const travelsBackwards = pulse?.kind === StepKind.Return;

  return (
    <>
      <BaseEdge id={id} path={path} className={`flow-edge emphasis-${emphasis}${change ? ` change-${change}` : ""}`} style={{ strokeWidth: width }} />
      {pulse && (
        <circle key={pulse.key} r={5} className={`pulse pulse-${pulse.kind}`}>
          <animateMotion
            dur={PULSE_DURATION}
            repeatCount="1"
            fill="freeze"
            path={path}
            keyPoints={travelsBackwards ? "1;0" : "0;1"}
            keyTimes="0;1"
            calcMode="linear"
          />
        </circle>
      )}
    </>
  );
}
