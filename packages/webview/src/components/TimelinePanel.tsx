import { useState } from "react";

import { formatMicros, Timeline, TimelineBar } from "@runshape/core";

interface Props {
  timeline: Timeline;
  scenarioName: string;
  /** The bar's colour: its component's zone. */
  colorOf: (componentId: string) => string;
  onOpenFunction: (module: string, qualname: string) => void;
}

const WIDTH = 560;
const ROW = 16;
const LABEL_MIN_WIDTH = 36;
/** Zooming to a bar leaves this share of it as margin on each side. */
const ZOOM_MARGIN = 0.04;

/**
 * The test as a flame chart: each call a bar under its caller, solid while running and faint
 * while a coroutine awaits. Click a bar to zoom to it and select it; then open its function.
 */
export function TimelinePanel({ timeline, scenarioName, colorOf, onOpenFunction }: Props) {
  const [range, setRange] = useState<[number, number]>([timeline.startUs, Math.max(timeline.endUs, timeline.startUs + 1)]);
  const [selected, setSelected] = useState<TimelineBar | null>(null);
  const [from, to] = range;
  const x = (tUs: number) => ((tUs - from) / (to - from)) * WIDTH;
  const visible = timeline.bars.filter((bar) => bar.endUs >= from && bar.startUs <= to);
  const height = Math.max(1, timeline.depth) * ROW + 18;
  const zoomTo = (bar: TimelineBar) => {
    const margin = Math.max(1, (bar.endUs - bar.startUs) * ZOOM_MARGIN);
    setRange([bar.startUs - margin, bar.endUs + margin]);
    setSelected(bar);
  };

  return (
    <section className="panel timeline-panel">
      <h2>{scenarioName}</h2>
      <p className="muted">
        {formatMicros(timeline.endUs - timeline.startUs)} · {timeline.bars.length} calls · {timeline.externals.length} external calls. Faint: awaiting. Times
        include tracing overhead.
      </p>
      <p>
        <button type="button" onClick={() => setRange([timeline.startUs, Math.max(timeline.endUs, timeline.startUs + 1)])} disabled={from === timeline.startUs}>
          Whole test
        </button>{" "}
        <span className="muted number">
          showing {formatMicros(from - timeline.startUs)} – {formatMicros(to - timeline.startUs)}
        </span>
      </p>
      <svg className="timeline" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={`Timeline of ${scenarioName}`}>
        {visible.map((bar) => {
          const left = Math.max(0, x(bar.startUs));
          const right = Math.min(WIDTH, x(bar.endUs));
          const width = Math.max(1, right - left);
          const y = bar.depth * ROW;
          const color = colorOf(bar.componentId);
          return (
            <g
              key={bar.spanId}
              className={`timeline-bar${selected?.spanId === bar.spanId ? " selected" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`${bar.label}, ${formatMicros(bar.endUs - bar.startUs)}`}
              onClick={() => zoomTo(bar)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") zoomTo(bar);
              }}
            >
              <title>
                {`${bar.label}\n${formatMicros(bar.endUs - bar.startUs)}${bar.runs.length > 1 ? `, ran in ${bar.runs.length} slices` : ""}`}
              </title>
              <rect x={left} y={y} width={width} height={ROW - 2} fill={color} opacity={0.18} />
              {bar.runs.map(([start, end]) => (
                <rect key={start} x={Math.max(0, x(start))} y={y} width={Math.max(0.5, Math.min(WIDTH, x(end)) - Math.max(0, x(start)))} height={ROW - 2} fill={color} opacity={0.75} />
              ))}
              {width > LABEL_MIN_WIDTH && (
                <text x={left + 3} y={y + ROW - 5} className="timeline-label">
                  {bar.label.split("\n")[0]!.slice(0, Math.floor(width / 6))}
                </text>
              )}
            </g>
          );
        })}
        {timeline.externals
          .filter((mark) => mark.tUs >= from && mark.tUs <= to)
          .map((mark, index) => (
            <g key={`${mark.tUs}-${index}`} className="timeline-external">
              <title>{mark.label}</title>
              <rect x={x(mark.tUs) - 1} y={mark.depth * ROW} width={2} height={ROW - 2} />
            </g>
          ))}
      </svg>
      {selected && (
        <p>
          <strong>{selected.label.split("\n")[0]}</strong> {formatMicros(selected.endUs - selected.startUs)}
          {selected.runs.length > 1 ? `, of which running ${formatMicros(selected.runs.reduce((sum, [s, e]) => sum + (e - s), 0))}` : ""}{" "}
          <button type="button" className="link" onClick={() => onOpenFunction(selected.module, selected.qualname)}>
            Open function
          </button>
        </p>
      )}
    </section>
  );
}
