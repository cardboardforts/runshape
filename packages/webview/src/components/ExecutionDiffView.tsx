
/** Unchanged calls kept around each change, so it's clear where in the flow it happened. */
const CONTEXT = 2;

type Row = { kind: "call"; step: CallStep; index: number } | { kind: "gap"; hidden: number; at: number };

/** Long runs of identical calls collapse to a "⋯ n unchanged" row, like a diff's context. */
function withContext(calls: CallStep[]): Row[] {
  const keep = calls.map(() => false);
  calls.forEach((call, index) => {
    if (call.op === Op.Same) return;
    for (let i = Math.max(0, index - CONTEXT); i <= Math.min(calls.length - 1, index + CONTEXT); i += 1) keep[i] = true;
  });
  const rows: Row[] = [];
  let hidden = 0;
  calls.forEach((call, index) => {
    if (keep[index]) {
      if (hidden > 0) rows.push({ kind: "gap", hidden, at: index });
      hidden = 0;
      rows.push({ kind: "call", step: call, index });
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) rows.push({ kind: "gap", hidden, at: calls.length });
  return rows;
}

const MARK: Record<Op, string> = { [Op.Same]: " ", [Op.Added]: "+", [Op.Removed]: "−" };

const TOO_DIFFERENT = "These two executions are too different to line up call by call, so this is shown as everything removed and everything added. It doesn't mean nothing stayed the same.";

export function ExecutionCalls({ diff, onOpenFunction }: { diff: ExecutionDiff; onOpenFunction: (call: CallStep) => void }) {
  if (!diff.complete) return <p role="note">{TOO_DIFFERENT}</p>;
  if (diff.added + diff.removed === 0) {
    return <p className="muted">The same calls, in the same order, as before.</p>;
  }
  return (
    <>
      <p className="muted">
        {diff.added} call{diff.added === 1 ? "" : "s"} added, {diff.removed} removed. ↪ = still runs, under a new caller.
      </p>
      <ol className="exec-calls" aria-label="Calls, before and after">
        {withContext(diff.calls).map((row) =>
          row.kind === "gap" ? (
            <li key={`gap-${row.at}`} className="muted gap">
              ⋯ {row.hidden} unchanged call{row.hidden === 1 ? "" : "s"}
            </li>
          ) : (
            <li key={row.index} className={`op-${row.step.op}`}>
              <span className="mark">{MARK[row.step.op]}</span>
              <span className="indent" style={{ width: `${row.step.depth * 12}px` }} />
              {row.step.reparented && <span title="Still runs, under a new caller">↪ </span>}
              <button type="button" className="link" onClick={() => onOpenFunction(row.step)}>
                {row.step.symbol.path}
              </button>
              {row.step.movedFrom !== null && <span className="muted"> moved from {row.step.movedFrom}</span>}
            </li>
          ),
        )}
      </ol>
    </>
  );
}

/** One function in one test: what it executed before and after, aligned by statement text. */
export function FunctionExecutionPanel({ diff }: { diff: FunctionExecutionDiff }) {
  return (
    <section className="panel">
      <h2>{diff.symbol.path}</h2>
      <p className="muted mono">
        {diff.symbol.namespace} · called {diff.callsBefore}× before, {diff.callsAfter}× after
      </p>
      <p className="muted">
        {diff.matchedBy === "text"
          ? "Statements are matched by their text, so moving the function or editing code above it doesn't count as a change."
          : "One of these recordings has no source snapshot, so statements are matched by line number: a moved function will look rewritten."}
      </p>
      {!diff.complete && <p role="note">{TOO_DIFFERENT}</p>}
      {diff.statements.length === 0 ? (
        <p className="muted">It ran no project lines in either recording.</p>
      ) : (
        <div className="code exec-statements" role="table" aria-label="Executed statements, before and after">
          <div role="row" className="exec-head muted">
            <span role="columnheader" />
            <span role="columnheader">before</span>
            <span role="columnheader">after</span>
            <span role="columnheader">statement executed</span>
          </div>
          {diff.statements.map((statement, index) => (
            <div role="row" key={index} className={`exec-row op-${statement.op}`}>
              <span role="cell" className="mark">
                {MARK[statement.op]}
              </span>
              <span role="cell" className="line-number">
                {statement.beforeLine ?? ""}
              </span>
              <span role="cell" className="line-number">
                {statement.afterLine ?? ""}
              </span>
              <code role="cell" className="source">
                {statement.text}
              </code>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}import { CallStep, ExecutionDiff, FunctionExecutionDiff, Op } from "@runshape/kernel";

