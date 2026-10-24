import { useState } from "react";

import { ZoneAdvice } from "@runshape/architecture";
import { ArchitectureProfile, GraphNode, Smell, ZoneSource } from "@runshape/trace";

import { zoneClass, zoneLabel } from "../zone-style";

export type AdviceState =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "proposed"; advice: ZoneAdvice }
  | { kind: "failed"; message: string };

interface Props {
  node: GraphNode;
  profile: ArchitectureProfile;
  canEdit: boolean;
  canAdvise: boolean;
  advice: AdviceState;
  onSetZone: (zone: string, reason: string, by: "user" | "llm") => void;
  onAskAdvice: () => void;
  onDismissAdvice: () => void;
}

export function smellText(profile: ArchitectureProfile, node: GraphNode, smell: Smell): string {
  switch (smell) {
    case Smell.TouchesExternal: {
      const allowed = profile.externalAccess.map((zone) => zoneLabel(profile, zone)).join(" or ");
      return `Talks to an external system directly, though ${profile.name} leaves that to the ${allowed} zone, not ${zoneLabel(profile, node.zone)}`;
    }
  }
}

/** Where this component sits, why, and how to change it — by hand or from a model's proposal. */
export function ZoneControls({ node, profile, canEdit, canAdvise, advice, onSetZone, onAskAdvice, onDismissAdvice }: Props) {
  const [zone, setZone] = useState<string>(profile.zones.some((option) => option.id === node.zone) ? node.zone : profile.zones[0]!.id);
  const [reason, setReason] = useState("");
  const placeable = node.qualifiedName !== null && node.zoneSource !== ZoneSource.Fixed;

  return (
    <div className="zone-controls">
      <p>
        <span className={`dot ${zoneClass(profile, node.zone)}`} /> <strong>{zoneLabel(profile, node.zone)}</strong>{" "}
        <span className="muted">
          ({node.zoneSource}) {node.zoneReason}
        </span>
      </p>
      {node.smells.map((smell) => (
        <p key={smell} className="smell-note">
          ⚠ {smellText(profile, node, smell)}
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
            <select value={zone} onChange={(event) => setZone(event.target.value)}>
              {profile.zones.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name.toLowerCase()}
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
                Proposed: <strong>{zoneLabel(profile, advice.advice.zone)}</strong> <span className="muted">({advice.advice.confidence} confidence)</span>
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
