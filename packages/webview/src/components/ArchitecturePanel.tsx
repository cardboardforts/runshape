import { ArchitectureCandidate, StyleChoice } from "@runshape/kernel";

export type ModelAdvice =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "proposed"; style: string; reason: string; confidence: string; rules: { match: string; zone: string }[] }
  | { kind: "failed"; message: string };

interface Props {
  /** Null while the session is still ranking the styles. */
  candidates: ArchitectureCandidate[] | null;
  /** The style the canvas is drawn in, to mark the candidate being previewed. */
  drawnStyle: string;
  /** Every style, to name the one a model proposes. */
  styles: StyleChoice[];
  canAdopt: boolean;
  canAsk: boolean;
  advice: ModelAdvice;
  onPreview: (style: string) => void;
  onAdopt: (style: string, from: "detected" | "model") => void;
  onAsk: () => void;
  onClose: () => void;
}

/** The styles ranked against the recording, with the evidence for each; preview or adopt one. */
export function ArchitecturePanel({ candidates, drawnStyle, styles, canAdopt, canAsk, advice, onPreview, onAdopt, onAsk, onClose }: Props) {
  return (
    <section className="architecture-panel" aria-label="Detected architecture">
      <header>
        <h2>Which shape is this app?</h2>
        <button type="button" className="link" onClick={onClose} aria-label="Close detected architecture">
          ✕
        </button>
      </header>
      {candidates === null ? (
        <p className="muted" role="status">
          Ranking the styles…
        </p>
      ) : (
        <ol>
          {candidates.map((candidate) => (
            <li key={candidate.style} className={candidate.style === drawnStyle ? "drawn" : ""}>
              <p>
                <strong>{candidate.name}</strong>{" "}
                <meter min={0} max={1} value={candidate.score} title={`score ${candidate.score} (relative, for ranking)`} />
              </p>
              <ul className="evidence">
                {candidate.evidence.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="actions">
                <button type="button" onClick={() => onPreview(candidate.style)} disabled={candidate.style === drawnStyle}>
                  Preview
                </button>{" "}
                {canAdopt && (
                  <button type="button" onClick={() => onAdopt(candidate.style, "detected")} title="Writes the style and its proposed rules to runshape.json, after you confirm">
                    Adopt…
                  </button>
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
      {canAsk && <ModelOpinion styles={styles} advice={advice} drawnStyle={drawnStyle} canAdopt={canAdopt} onAsk={onAsk} onPreview={onPreview} onAdopt={onAdopt} />}
    </section>
  );
}

/** A second opinion from a language model, which can see past package names. */
function ModelOpinion({
  advice,
  drawnStyle,
  styles,
  canAdopt,
  onAsk,
  onPreview,
  onAdopt,
}: Pick<Props, "advice" | "drawnStyle" | "styles" | "canAdopt" | "onAsk" | "onPreview" | "onAdopt">) {
  if (advice.kind === "idle") {
    return (
      <button type="button" onClick={onAsk}>
        Ask the model
      </button>
    );
  }
  if (advice.kind === "asking") return <p className="muted" role="status">Asking the model…</p>;
  if (advice.kind === "failed") {
    return (
      <p role="alert">
        {advice.message}{" "}
        <button type="button" className="link" onClick={onAsk}>
          Ask again
        </button>
      </p>
    );
  }
  return (
    <div className="proposal" role="region" aria-label="Model proposal">
      <p>
        The model says <strong>{styles.find((choice) => choice.style === advice.style)?.name ?? advice.style}</strong> <span className="muted">({advice.confidence} confidence)</span>
      </p>
      <p>{advice.reason}</p>
      <ul className="evidence">
        {advice.rules.map((rule) => (
          <li key={rule.match} className="mono">
            {rule.match} → {rule.zone}
          </li>
        ))}
      </ul>
      <p className="actions">
        <button type="button" onClick={() => onPreview(advice.style)} disabled={advice.style === drawnStyle}>
          Preview
        </button>{" "}
        {canAdopt && (
          <button type="button" onClick={() => onAdopt(advice.style, "model")} title="Writes this style and these rules to runshape.json, after you confirm">
            Adopt…
          </button>
        )}
      </p>
    </div>
  );
}
