import { useState } from "react";

import { DeclaredRing, GraphNode, RingAdvice, RingSource, Smell } from "@hexvis/core";

export type AdviceState =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "proposed"; advice: RingAdvice }
  | { kind: "failed"; message: string };

interface Props {
  node: GraphNode;
  canEdit: boolean;
  canAdvise: boolean;
  advice: AdviceState;
  onSetRing: (ring: DeclaredRing, reason: string, by: "user" | "llm") => void;
  onAskAdvice: () => void;
  onDismissAdvice: () => void;
}

const RING_NAMES: Record<DeclaredRing, string> = {
  [DeclaredRing.InboundAdapter]: "inbound adapter",
  [DeclaredRing.Core]: "core",
  [DeclaredRing.OutboundAdapter]: "outbound adapter",
};

export const SMELL_TEXT: Record<Smell, string> = {
  [Smell.HandlerTouchesExternal]: "Handles requests and talks to an external system directly, bypassing the core",
  [Smell.CoreTouchesExternal]: "Declared core, but talks to an external system itself: I/O inside the domain",
};

/** Where this component sits, why, and how to change it — by hand or from a model's proposal. */
export function RingControls({ node, canEdit, canAdvise, advice, onSetRing, onAskAdvice, onDismissAdvice }: Props) {
  const [ring, setRing] = useState<DeclaredRing>(DeclaredRing.Core);
  const [reason, setReason] = useState("");
  const placeable = node.qualifiedName !== null && node.ringSource !== RingSource.Fixed;

  return (
    <div className="ring-controls">
      <p>
        <span className={`dot ring-${node.ring}`} /> <strong>{node.ring}</strong>{" "}
        <span className="muted">
          ({node.ringSource}) {node.ringReason}
        </span>
      </p>
      {node.smells.map((smell) => (
        <p key={smell} className="smell-note">
          ⚠ {SMELL_TEXT[smell]}
        </p>
      ))}

      {placeable && canEdit && (
        <form
          className="set-ring"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim() !== "") onSetRing(ring, reason.trim(), "user");
          }}
        >
          <label>
            Declare as{" "}
            <select value={ring} onChange={(event) => setRing(event.target.value as DeclaredRing)}>
              {Object.values(DeclaredRing).map((value) => (
                <option key={value} value={value}>
                  {RING_NAMES[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            because{" "}
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="the reason goes in hexvis.json" required />
          </label>
          <button type="submit" disabled={reason.trim() === ""}>
            Save rule
          </button>
        </form>
      )}

      {placeable && canEdit && canAdvise && (
        <div className="advice">
          {advice.kind === "idle" && (
            <button type="button" onClick={onAskAdvice}>
              Suggest a ring
            </button>
          )}
          {advice.kind === "asking" && <p className="muted" role="status">Asking the model…</p>}
          {advice.kind === "failed" && (
            <p role="alert">
              {advice.message}{" "}
              <button type="button" className="link" onClick={onDismissAdvice}>
                Dismiss
              </button>
            </p>
          )}
          {advice.kind === "proposed" && (
            <div className="proposal" role="region" aria-label="Model proposal">
              <p>
                Proposed: <strong>{RING_NAMES[advice.advice.ring]}</strong> <span className="muted">({advice.advice.confidence} confidence)</span>
              </p>
              <p>{advice.advice.reason}</p>
              <button type="button" onClick={() => onSetRing(advice.advice.ring, advice.advice.reason, "llm")}>
                Accept into hexvis.json
              </button>{" "}
              <button type="button" className="link" onClick={onDismissAdvice}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
