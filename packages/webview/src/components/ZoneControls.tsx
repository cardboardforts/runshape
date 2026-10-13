import { useState } from "react";

import { DeclaredZone, GraphNode, ZoneAdvice, ZoneSource, Smell } from "@runshape/core";

export type AdviceState =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "proposed"; advice: ZoneAdvice }
  | { kind: "failed"; message: string };

interface Props {
  node: GraphNode;
  canEdit: boolean;
  canAdvise: boolean;
  advice: AdviceState;
  onSetZone: (zone: DeclaredZone, reason: string, by: "user" | "llm") => void;
  onAskAdvice: () => void;
  onDismissAdvice: () => void;
}

const ZONE_NAMES: Record<DeclaredZone, string> = {
  [DeclaredZone.InboundAdapter]: "inbound adapter",
  [DeclaredZone.Core]: "core",
  [DeclaredZone.OutboundAdapter]: "outbound adapter",
};

export const SMELL_TEXT: Record<Smell, string> = {
  [Smell.HandlerTouchesExternal]: "Handles requests and talks to an external system directly, bypassing the core",
  [Smell.CoreTouchesExternal]: "Declared core, but talks to an external system itself: I/O inside the domain",
};

/** Where this component sits, why, and how to change it — by hand or from a model's proposal. */
export function ZoneControls({ node, canEdit, canAdvise, advice, onSetZone, onAskAdvice, onDismissAdvice }: Props) {
  const [zone, setZone] = useState<DeclaredZone>(DeclaredZone.Core);
  const [reason, setReason] = useState("");
  const placeable = node.qualifiedName !== null && node.zoneSource !== ZoneSource.Fixed;

  return (
    <div className="zone-controls">
      <p>
        <span className={`dot zone-${node.zone}`} /> <strong>{node.zone}</strong>{" "}
        <span className="muted">
          ({node.zoneSource}) {node.zoneReason}
        </span>
      </p>
      {node.smells.map((smell) => (
        <p key={smell} className="smell-note">
          ⚠ {SMELL_TEXT[smell]}
        </p>
      ))}

      {placeable && canEdit && (
        <form
          className="set-zone"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim() !== "") onSetZone(zone, reason.trim(), "user");
          }}
        >
          <label>
            Declare as{" "}
            <select value={zone} onChange={(event) => setZone(event.target.value as DeclaredZone)}>
              {Object.values(DeclaredZone).map((value) => (
                <option key={value} value={value}>
                  {ZONE_NAMES[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            because{" "}
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="the reason goes in runshape.json" required />
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
              Suggest a zone
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
                Proposed: <strong>{ZONE_NAMES[advice.advice.zone]}</strong> <span className="muted">({advice.advice.confidence} confidence)</span>
              </p>
              <p>{advice.advice.reason}</p>
              <button type="button" onClick={() => onSetZone(advice.advice.zone, advice.advice.reason, "llm")}>
                Accept into runshape.json
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
