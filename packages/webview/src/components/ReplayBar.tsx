import { ReplayStep, StepKind } from "@hexvis/core";

interface Props {
  scenarioName: string;
  steps: ReplayStep[];
  index: number;
  playing: boolean;
  onPlayPause: () => void;
  onSeek: (index: number) => void;
  onClose: () => void;
}

const KIND_ARROW: Record<StepKind, string> = {
  [StepKind.Call]: "→",
  [StepKind.Return]: "←",
  [StepKind.External]: "⇢",
};

export function ReplayBar({ scenarioName, steps, index, playing, onPlayPause, onSeek, onClose }: Props) {
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
      {step && (
        <span className={`replay-label step-${step.kind}`} title={step.label}>
          {KIND_ARROW[step.kind]} {step.label}
        </span>
      )}
      <button type="button" onClick={onClose} aria-label="Close replay">
        ✕
      </button>
    </div>
  );
}
