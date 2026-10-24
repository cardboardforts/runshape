import type { ReactNode } from "react";

import { ComponentView, FunctionSummary } from "@runshape/trace";
import { formatMicros } from "@runshape/views";

interface Props {
  view: ComponentView;
  /** Where the component sits in the onion, and the controls to change that. */
  zone: ReactNode;
  /** Which objects this component's objects hold, and are held by. */
  relations: ReactNode;
  onOpenFunction: (fn: FunctionSummary) => void;
}

/** A component opened up: every function it has, and how much of each the tests reach. */
export function ComponentPanel({ view, zone, relations, onOpenFunction }: Props) {
  if (view.functions.length === 0) {
    return (
      <section className="panel">
        <h2>{view.label}</h2>
        {zone}
        <p className="muted">Framework code: recorded as a step in the request, not line by line.</p>
      </section>
    );
  }
  return (
    <section className="panel">
      <h2>{view.label}</h2>
      {view.qualifiedName && <p className="muted mono">{view.qualifiedName}</p>}
      {zone}
      {relations}
      <table className="functions">
        <thead>
          <tr>
            <th scope="col">Function</th>
            <th scope="col">Lines reached</th>
            <th scope="col">Tests</th>
            <th scope="col" title="Wall time over all calls, and in brackets its own share: total minus the project code it called. Tracing slows project code, so compare these with each other.">
              Time (self)
            </th>
          </tr>
        </thead>
        <tbody>
          {view.functions.map((fn) => (
            <tr key={fn.symbol.key} className={fn.calls === 0 ? "untested" : undefined}>
              <td>
                <button type="button" className="link" onClick={() => onOpenFunction(fn)}>
                  {fn.name}
                </button>
                {fn.inheritedFrom && <span className="muted"> from {fn.inheritedFrom}</span>}
              </td>
              <td>
                <CoverageBar covered={fn.coveredLines} total={fn.executableLines} />
              </td>
              <td className="number">{fn.scenarioIds.length}</td>
              <td className="number">
                {fn.calls === 0 ? "—" : (
                  <>
                    {formatMicros(fn.totalUs)} <span className="muted">({formatMicros(fn.selfUs)})</span>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function CoverageBar({ covered, total }: { covered: number; total: number }) {
  const percent = total === 0 ? 100 : Math.round((covered / total) * 100);
  return (
    <span className="coverage" title={`${covered} of ${total} executable lines`}>
      <span className="coverage-track">
        <span className="coverage-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="number">
        {covered}/{total}
      </span>
    </span>
  );
}
