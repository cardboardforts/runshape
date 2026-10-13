import { ArchitectureCandidate } from "@runshape/core";

interface Props {
  /** Null while the session is still ranking the styles. */
  candidates: ArchitectureCandidate[] | null;
  /** The style the canvas is drawn in, to mark the candidate being previewed. */
  drawnStyle: string;
  canAdopt: boolean;
  onPreview: (style: string) => void;
  onAdopt: (style: string) => void;
  onClose: () => void;
}

/** The styles ranked against the recording, with the evidence for each; preview or adopt one. */
export function ArchitecturePanel({ candidates, drawnStyle, canAdopt, onPreview, onAdopt, onClose }: Props) {
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
                  <button type="button" onClick={() => onAdopt(candidate.style)} title="Writes the style and its proposed rules to runshape.json, after you confirm">
                    Adopt…
                  </button>
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
