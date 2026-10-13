import { CallStep, Change, ExecutionDiff, FunctionChange, ScenarioDiff } from "@runshape/core";

import { ExecutionCalls } from "./ExecutionDiffView";

interface Props {
  diff: ScenarioDiff;
  /** The call-by-call comparison, once it has arrived. */
  execution: ExecutionDiff | null;
  onOpenFunction: (fn: FunctionChange) => void;
  onOpenCall: (call: CallStep) => void;
  onReplayChange: () => void;
}

/** One journey, before and after the change: what it now does differently. */
export function ScenarioDiffPanel({ diff, execution, onOpenFunction, onOpenCall, onReplayChange }: Props) {
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
      {diff.change !== Change.Added && diff.change !== Change.Removed && (
        <>
          <h3>Execution</h3>
          {execution === null ? (
            <p className="muted" role="status">Comparing the two executions…</p>
          ) : (
            <>
              <button type="button" className="replay-change" onClick={onReplayChange}>
                ▶ Replay the change
              </button>
              <ExecutionCalls diff={execution} onOpenFunction={onOpenCall} />
            </>
          )}
        </>
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
