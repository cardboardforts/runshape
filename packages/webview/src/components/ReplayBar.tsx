import { Op, ReplayPace, ReplayStep, StepKind } from "@runshape/views";

interface Props {
  scenarioName: string;
  steps: ReplayStep[];
  /** Replaying a change: whether each step is shared, old-only or new-only. */
  ops: Op[] | null;
  index: number;
  playing: boolean;
  pace: ReplayPace;
  /** Replaying a change: two recordings' clocks don't compare, so the pace is even. */
  paceFixed: boolean;
  /** The recorded time before the next hop. */
  gap: string;
  onPace: (pace: ReplayPace) => void;
  onPlayPause: () => void;
  onSeek: (index: number) => void;
  onClose: () => void;
}

const KIND_ARROW: Record<StepKind, string> = {
  [StepKind.Call]: "→",
  [StepKind.Return]: "←",
  [StepKind.External]: "⇢",
};

export function ReplayBar({ scenarioName, steps, ops, index, playing, pace, paceFixed, gap, onPace, onPlayPause, onSeek, onClose }: Props) {
  if (steps.length === 0) {
    return (
      <div className="replay-bar" role="region" aria-label="Replay">
        <span>{scenarioName}: no hops between components in this scenario.</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }
  const step = steps[index];
  return (
    <div className="replay-bar" role="region" aria-label="Replay">
      <button type="button" onClick={onPlayPause} aria-label={playing ? "Pause" : "Play"}>
        {playing ? "❚❚" : "▶"}
      </button>
      <input
        type="range"
        min={0}
        max={steps.length - 1}
        value={index}
        aria-label="Replay position"
        onChange={(event) => onSeek(Number(event.target.value))}
      />
      <span className="replay-count number">
        {index + 1}/{steps.length}
      </span>
      <label className="replay-pace" title="Recorded pace: each hop lasts as long as the app took before the next one (log scale; tracing slows project code, so read it as relative)">
        <input
          type="checkbox"
          checked={pace === ReplayPace.Recorded}
          disabled={paceFixed}
          onChange={(event) => onPace(event.target.checked ? ReplayPace.Recorded : ReplayPace.Even)}
        />{" "}
        recorded pace
      </label>
      {pace === ReplayPace.Recorded && <span className="replay-gap number" title="recorded time before the next hop">{gap}</span>}
      {step && (
        <span className={`replay-label step-${step.kind}${ops?.[index] ? ` op-${ops[index]}` : ""}`} title={step.label}>
          {ops?.[index] === Op.Removed ? "before only: " : ops?.[index] === Op.Added ? "after only: " : ""}
          {KIND_ARROW[step.kind]} {step.label}
        </span>
      )}
      <button type="button" onClick={onClose} aria-label="Close replay">
        ✕
      </button>
    </div>
  );
}
