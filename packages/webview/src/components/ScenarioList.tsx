import { ScenarioSummary } from "@runshape/core";
import { Outcome } from "@runshape/trace";
import { REVIEW_ORDER, ReviewCategory } from "@runshape/views";

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
  /** Set in compare mode: what each test's change means for a reviewer. */
  review: Map<string, ReviewCategory> | null;
  onSelect: (id: string | null) => void;
  onReplay: (id: string) => void;
  onTimeline: (id: string) => void;
}

/** Each scenario is a test, i.e. one named user behaviour. Selecting one lights up its path. */
const REVIEW_BADGE: Record<ReviewCategory, string | null> = {
  [ReviewCategory.NowFailing]: "now failing",
  [ReviewCategory.SilentChange]: "green, runs differently",
  [ReviewCategory.NowPassing]: "now passing",
  [ReviewCategory.NowSkipped]: "no longer runs",
  [ReviewCategory.StillFailing]: "still failing",
  [ReviewCategory.Added]: "new test",
  [ReviewCategory.Removed]: "removed",
  [ReviewCategory.Unchanged]: null,
};

export function ScenarioList({ scenarios, selected, review, onSelect, onReplay, onTimeline }: Props) {
  if (scenarios.length === 0) {
    return <p className="muted">This run recorded no scenarios.</p>;
  }
  return (
    <ul className="scenarios" aria-label="Scenarios">
      {orderForReview(scenarios, review).map((scenario) => {
        const isSelected = scenario.id === selected;
        const category = review?.get(scenario.id) ?? null;
        const badge = category ? REVIEW_BADGE[category] : null;
        const classes = [isSelected ? "selected" : "", category === ReviewCategory.Unchanged ? "unchanged" : ""].join(" ").trim();
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
                {badge && <span className={`change-badge review-${category}`}>{badge}</span>}
                {scenario.name}
              </span>
              {scenario.requests.length > 0 && (
                <span className="scenario-requests">{summarizeRequests(scenario.requests)}</span>
              )}
            </button>
            {isSelected && (
              <span className="scenario-actions">
                <button type="button" className="replay-button" onClick={() => onReplay(scenario.id)}>
                  ▶ Replay
                </button>{" "}
                <button type="button" className="replay-button" onClick={() => onTimeline(scenario.id)}>
                  Timeline
                </button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** In compare mode, what needs a reviewer's eyes comes first; otherwise the recorded order. */
function orderForReview(scenarios: ScenarioSummary[], review: Map<string, ReviewCategory> | null): ScenarioSummary[] {
  if (review === null) return scenarios;
  const rank = (id: string) => REVIEW_ORDER.indexOf(review.get(id) ?? ReviewCategory.Unchanged);
  return [...scenarios].sort((a, b) => rank(a.id) - rank(b.id));
}

const MAX_REQUESTS_SHOWN = 3;

function summarizeRequests(requests: string[]): string {
  const shown = requests.slice(0, MAX_REQUESTS_SHOWN).join(" · ");
  const rest = requests.length - MAX_REQUESTS_SHOWN;
  return rest > 0 ? `${shown} · +${rest} more` : shown;
}
