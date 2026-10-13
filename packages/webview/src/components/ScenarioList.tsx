import { Change, Outcome, ScenarioSummary } from "@hexvis/core";

const OUTCOME_LABEL: Record<Outcome, string> = {
  [Outcome.Passed]: "passed",
  [Outcome.Failed]: "failed",
  [Outcome.Error]: "error",
  [Outcome.Skipped]: "skipped",
  [Outcome.ExpectedFailure]: "known bug (xfail)",
  [Outcome.UnexpectedPass]: "unexpectedly passed",
  [Outcome.Unknown]: "unknown",
};

interface Props {
  scenarios: ScenarioSummary[];
  selected: string | null;
  /** Set in compare mode: how each journey differs from the previous recording. */
  changes: Map<string, Change> | null;
  onSelect: (id: string | null) => void;
  onReplay: (id: string) => void;
}

/** Each scenario is a test, i.e. one named user behaviour. Selecting one lights up its path. */
export function ScenarioList({ scenarios, selected, changes, onSelect, onReplay }: Props) {
  if (scenarios.length === 0) {
    return <p className="muted">This run recorded no scenarios.</p>;
  }
  return (
    <ul className="scenarios" aria-label="Scenarios">
      {scenarios.map((scenario) => {
        const isSelected = scenario.id === selected;
        const change = changes?.get(scenario.id) ?? null;
        const classes = [isSelected ? "selected" : "", change === Change.Unchanged ? "unchanged" : ""].join(" ").trim();
        return (
          <li key={scenario.id} className={classes || undefined}>
            <button
              type="button"
              className="scenario"
              aria-pressed={isSelected}
              title={scenario.id}
              onClick={() => onSelect(isSelected ? null : scenario.id)}
            >
              <span className={`outcome outcome-${scenario.outcome}`} title={OUTCOME_LABEL[scenario.outcome]}>
                {OUTCOME_LABEL[scenario.outcome]}
              </span>
              <span className="scenario-name">
                {change !== null && change !== Change.Unchanged && <span className={`change-badge change-${change}`}>{change}</span>}
                {scenario.name}
              </span>
              {scenario.requests.length > 0 && (
                <span className="scenario-requests">{summarizeRequests(scenario.requests)}</span>
              )}
            </button>
            {isSelected && (
              <button type="button" className="replay-button" onClick={() => onReplay(scenario.id)}>
                ▶ Replay
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const MAX_REQUESTS_SHOWN = 3;

function summarizeRequests(requests: string[]): string {
  const shown = requests.slice(0, MAX_REQUESTS_SHOWN).join(" · ");
  const rest = requests.length - MAX_REQUESTS_SHOWN;
  return rest > 0 ? `${shown} · +${rest} more` : shown;
}
