import { BaseEdge, Edge, EdgeProps, getBezierPath } from "@xyflow/react";

import { Change, EdgeViolation, Op, StepKind } from "@hexvis/core";

import type { Emphasis } from "./ComponentNode";

export type Pulse = {
  /** Changes on every replay step so the animation restarts even on the same edge. */
  key: number;
  kind: StepKind;
  /** Replaying a change: a hop only the old code made, or only the new code makes. */
  op: Op | null;
};

export type PulseEdgeData = {
  calls: number;
  emphasis: Emphasis;
  change: Change | null;
  violation: EdgeViolation | null;
  pulse: Pulse | null;
};

const VIOLATION_TEXT: Record<EdgeViolation, string> = {
  [EdgeViolation.CallsIntoInboundAdapter]: "Calls back into a request handler: the dependency points outward",
  [EdgeViolation.SkipsCore]: "A request handler using an outbound adapter directly: no core in between",
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
  const violation = data?.violation ?? null;
  // Log scale: one call is a hairline, a thousand is thick but not a wall.
  const width = 1 + Math.log2(calls + 1) * 0.8;
  const travelsBackwards = pulse?.kind === StepKind.Return;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={`flow-edge emphasis-${emphasis}${change ? ` change-${change}` : ""}${violation ? " violation" : ""}`}
        style={{ strokeWidth: width }}
      />
      {violation && (
        <path d={path} className="violation-hit" fill="none">
          <title>{VIOLATION_TEXT[violation]}</title>
        </path>
      )}
      {pulse && (
        <circle key={pulse.key} r={5} className={`pulse pulse-${pulse.kind}${pulse.op && pulse.op !== Op.Same ? ` pulse-op-${pulse.op}` : ""}`}>
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
