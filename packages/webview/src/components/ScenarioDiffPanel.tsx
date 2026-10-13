import { Change, FunctionChange, ScenarioDiff } from "@hexvis/core";

interface Props {
  diff: ScenarioDiff;
  onOpenFunction: (fn: FunctionChange) => void;
}

/** One journey, before and after the change: what it now does differently. */
export function ScenarioDiffPanel({ diff, onOpenFunction }: Props) {
  return (
    <section className="panel">
      <h2>{diff.name}</h2>
      <p className="muted">
        {diff.change === Change.Added && "New test: there's no earlier recording of this journey."}
        {diff.change === Change.Removed && "This test no longer exists."}
        {diff.change === Change.Unchanged && "Same flow, same queries, same lines as the previous recording."}
        {diff.change === Change.Changed && "Behaves differently from the previous recording."}
      </p>
      {diff.outcomeBefore !== diff.outcomeAfter && (
        <p>
          Outcome: <span className={`outcome outcome-${diff.outcomeBefore}`}>{diff.outcomeBefore ?? "—"}</span> →{" "}
          <span className={`outcome outcome-${diff.outcomeAfter}`}>{diff.outcomeAfter ?? "—"}</span>
        </p>
      )}
      <ChangeList title="Hops" added={diff.hopsAdded} removed={diff.hopsRemoved} />
      <ChangeList title="External calls" added={diff.statementsAdded} removed={diff.statementsRemoved} mono />
      {diff.functionsChanged.length > 0 && (
        <>
          <h3>Lines reached</h3>
          <ul className="diff-list">
            {diff.functionsChanged.map((fn) => (
              <li key={`${fn.module}:${fn.qualname}`}>
                <button type="button" className="link" onClick={() => onOpenFunction(fn)}>
                  {fn.qualname}
                </button>{" "}
                {fn.linesNowReached.length > 0 && <span className="added">+{fn.linesNowReached.length} now run</span>}{" "}
                {fn.linesNoLongerReached.length > 0 && <span className="removed">−{fn.linesNoLongerReached.length} no longer run</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ChangeList({ title, added, removed, mono = false }: { title: string; added: string[]; removed: string[]; mono?: boolean }) {
  if (added.length + removed.length === 0) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul className={`diff-list${mono ? " mono" : ""}`}>
        {added.map((item, index) => (
          <li key={`+${index}`} className="added" title={item}>
            + {item}
          </li>
        ))}
        {removed.map((item, index) => (
          <li key={`-${index}`} className="removed" title={item}>
            − {item}
          </li>
        ))}
      </ul>
    </>
  );
}
