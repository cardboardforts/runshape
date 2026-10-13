import type { CSSProperties } from "react";

import { FunctionView, LineView, ScenarioPath } from "@hexvis/core";

import { wireColor } from "../wire-colors";

interface Props {
  view: FunctionView;
  selectedScenario: string | null;
  onSelectScenario: (id: string | null) => void;
  onOpenSource: (file: string, line: number) => void;
}

const MAX_WIRES = 24;

/**
 * The function's source with one vertical wire per test. A wire is lit on every line its
 * test executed, so where tests take different branches the bundle visibly splits; an
 * executable line with no wire is code no test reaches.
 */
export function FunctionPanel({ view, selectedScenario, onSelectScenario, onOpenSource }: Props) {
  const wires = view.scenarios.slice(0, MAX_WIRES);
  const hidden = view.scenarios.length - wires.length;
  const reached = view.executableLineCount - view.untestedLines.length;

  return (
    <section className="panel function-panel">
      <h2>{view.title}</h2>
      <p className="muted mono">
        {view.file}:{view.firstLine} · {reached}/{view.executableLineCount} lines reached by {view.scenarios.length} test
        {view.scenarios.length === 1 ? "" : "s"}
        {hidden > 0 ? ` (showing ${MAX_WIRES} wires)` : ""}
      </p>

      <div className="code" role="table" aria-label={`Source of ${view.title}`}>
        {view.lines.map((line, index) => (
          <div
            key={line.number}
            role="row"
            className={`code-line${line.executable && line.scenarioIds.length === 0 ? " untested" : ""}`}
          >
            <span role="cell" className="wires" aria-label={wireLabel(line)}>
              {wires.map((wire, wireIndex) => (
                <span
                  key={wire.scenarioId}
                  className={`wire${wire.scenarioId === selectedScenario ? " selected" : ""}`}
                  style={wireStyle(view.lines, index, wire, wireIndex)}
                />
              ))}
            </span>
            <button
              type="button"
              role="cell"
              className="line-number"
              title="Open in editor"
              onClick={() => onOpenSource(view.file, line.number)}
            >
              {line.number}
            </button>
            <span role="cell" className="hits">
              {line.executable ? line.scenarioIds.length || "✗" : ""}
            </span>
            <code role="cell" className="source">
              {line.text || " "}
            </code>
          </div>
        ))}
      </div>

      <h3>Tests through this function</h3>
      <ul className="legend">
        {wires.map((wire, wireIndex) => (
          <li key={wire.scenarioId}>
            <button
              type="button"
              className="link"
              aria-pressed={wire.scenarioId === selectedScenario}
              onClick={() => onSelectScenario(wire.scenarioId === selectedScenario ? null : wire.scenarioId)}
            >
              <span className="swatch" style={{ background: wireColor(wireIndex) }} />
              {wire.name}
            </button>
            <span className="muted">
              {" "}
              {wire.calls} call{wire.calls === 1 ? "" : "s"} · {wire.lines.length} lines
            </span>
          </li>
        ))}
      </ul>

      {view.samePathGroups.length > 0 && (
        <>
          <h3>Tests taking identical paths</h3>
          <p className="muted">
            Same lines, same function: each group may be one behaviour tested several times. Consolidate, or make each
            test reach something the others don't.
          </p>
          <ul>
            {view.samePathGroups.map((group) => (
              <li key={group.join("|")}>{group.map(shortName).join(", ")}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** A wire continues through blank and comment lines when its test ran the lines on both sides. */
function wireStyle(lines: LineView[], index: number, wire: ScenarioPath, wireIndex: number): CSSProperties {
  const line = lines[index];
  if (line === undefined) return {};
  const lit = line.executable
    ? line.scenarioIds.includes(wire.scenarioId)
    : reachedNearest(lines, index, -1, wire.scenarioId) && reachedNearest(lines, index, 1, wire.scenarioId);
  return lit ? { background: wireColor(wireIndex) } : {};
}

function reachedNearest(lines: LineView[], from: number, direction: 1 | -1, scenarioId: string): boolean {
  for (let i = from + direction; i >= 0 && i < lines.length; i += direction) {
    const line = lines[i];
    if (line?.executable) return line.scenarioIds.includes(scenarioId);
  }
  return false;
}

function wireLabel(line: LineView): string {
  if (!line.executable) return "";
  if (line.scenarioIds.length === 0) return "no test reaches this line";
  return `${line.scenarioIds.length} tests: ${line.scenarioIds.map(shortName).join(", ")}`;
}

function shortName(nodeid: string): string {
  return nodeid.split("::").pop() ?? nodeid;
}
