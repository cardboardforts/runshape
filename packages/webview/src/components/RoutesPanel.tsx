import { FunctionRef } from "@runshape/kernel";
import { Change, Op, RouteMap, RouteMapDiff, RouteVariant, VariantStep } from "@runshape/trace";

interface Props {
  routes: RouteMap;
  /** Set in compare mode: each route's variants marked new, gone or changed. */
  diff: RouteMapDiff | null;
  selected: string | null;
  onSelect: (scenarioId: string) => void;
  onReplay: (scenarioId: string) => void;
  onOpenFunction: (symbol: FunctionRef) => void;
}

/** A route row and its variants: the same shape whether or not it's being compared. */
interface RouteRow {
  id: string;
  label: string;
  routed: boolean;
  change: Change | null;
  variants: VariantRow[];
}

interface VariantRow {
  variant: RouteVariant;
  change: Change | null;
  before: number;
  after: number;
  nowCalls: string[];
  noLongerCalls: string[];
  path: { op: Op; step: VariantStep }[];
}

const CHANGE_ORDER = [Change.Changed, Change.Added, Change.Removed, Change.Unchanged];

/**
 * Requests by route, and each route's requests by the way they went through the code. A
 * variant is told by how it differs from the route's main path, so a refused order reads as
 * "skips MemoryRepository.Save" rather than as a sixth copy of a call tree.
 */
export function RoutesPanel({ routes, diff, selected, onSelect, onReplay, onOpenFunction }: Props) {
  const rows = diff ? rowsFromDiff(diff) : rowsFromMap(routes);
  if (rows.length === 0) {
    return <p className="muted">No requests were sent in this recording{routes.scenariosWithoutRequests > 0 ? " (its scenarios call the code directly)" : ""}.</p>;
  }
  return (
    <div className="routes">
      <ul aria-label="Routes">
        {rows.map((route) => (
          <li key={route.id} className={route.change === Change.Unchanged ? "unchanged" : undefined}>
            <h3 className="route-label">
              {route.change && route.change !== Change.Unchanged && <span className={`change-badge change-${route.change}`}>{route.change}</span>}
              {route.label}
              {!route.routed && <span className="muted"> (no route matched)</span>}
            </h3>
            <ul className="variants" aria-label={`Ways through ${route.label}`}>
              {route.variants.map((row) => (
                <Variant key={`${row.change}:${row.variant.key}`} row={row} selected={selected} onSelect={onSelect} onReplay={onReplay} onOpenFunction={onOpenFunction} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {routes.scenariosWithoutRequests > 0 && (
        <p className="muted">
          {routes.scenariosWithoutRequests} scenario{routes.scenariosWithoutRequests === 1 ? "" : "s"} sent no request (startup, background work, unit tests): see Tests.
        </p>
      )}
    </div>
  );
}

const MAX_REQUESTS_SHOWN = 4;

function Variant({ row, selected, onSelect, onReplay, onOpenFunction }: { row: VariantRow; selected: string | null } & Pick<Props, "onSelect" | "onReplay" | "onOpenFunction">) {
  const { variant, change } = row;
  // A gone variant's requests are the earlier recording's: nothing in this one to light up.
  const selectable = change !== Change.Removed;
  const shown = variant.requests.slice(0, MAX_REQUESTS_SHOWN);
  const first = variant.requests[0];
  return (
    <li className={`variant${first !== undefined && first.scenarioId === selected ? " selected" : ""}`}>
      <div className="variant-head">
        {change && change !== Change.Unchanged && <span className={`change-badge change-${change}`}>{change === Change.Changed ? "changed" : change === Change.Added ? "new" : "gone"}</span>}
        <span className="variant-count" title="requests that took this way">
          ×{change === null ? variant.requests.length : change === Change.Removed ? row.before : row.after}
          {change !== null && row.before !== row.after && change !== Change.Added && change !== Change.Removed && <span className="muted"> (was {row.before})</span>}
        </span>
        <span className="variant-how">{describe(row)}</span>
      </div>
      <div className="variant-requests">
        {shown.map((request, i) =>
          selectable ? (
            <button
              type="button"
              key={`${request.scenarioId}:${i}`}
              className={`link request-chip${request.scenarioId === selected ? " selected" : ""}`}
              title={`${request.scenarioName} (${request.outcome})`}
              onClick={() => onSelect(request.scenarioId)}
            >
              {request.line}
            </button>
          ) : (
            <span key={`${request.scenarioId}:${i}`} className="request-chip muted" title={request.scenarioName}>
              {request.line}
            </span>
          ),
        )}
        {variant.requests.length > MAX_REQUESTS_SHOWN && <span className="muted"> +{variant.requests.length - MAX_REQUESTS_SHOWN} more</span>}
        {selectable && first !== undefined && (
          <button type="button" className="replay-button" onClick={() => onReplay(first.scenarioId)}>
            ▶ Replay
          </button>
        )}
      </div>
      <details className="variant-path" open={change === Change.Changed}>
        <summary>
          {variant.reachedHandler ? "Path" : "What ran instead"} ({variant.steps.length} step{variant.steps.length === 1 ? "" : "s"}
          {change === Change.Changed ? `, ${row.path.filter((entry) => entry.op !== Op.Same).length} changed` : ""})
        </summary>
        <ol>
          {(change === Change.Changed ? hunks(row.path) : row.path).map((entry, i) =>
            "skipped" in entry ? (
              <li key={i} className="muted path-gap">
                ⋯ {entry.skipped} unchanged
              </li>
            ) : (
              <li key={i} className={`op-${entry.op}`} style={{ paddingLeft: `${entry.step.depth * 12}px` }} title={entry.step.label}>
                <span className="mark">{entry.op === Op.Added ? "+" : entry.op === Op.Removed ? "−" : " "}</span>
                {/* A gone variant's steps, and a changed one's dropped steps, are the earlier recording's functions: this one may not have them. */}
                {entry.step.symbol && entry.op !== Op.Removed && change !== Change.Removed ? (
                  <button type="button" className="link" onClick={() => onOpenFunction(entry.step.symbol!)}>
                    {entry.step.label}
                  </button>
                ) : (
                  <span className={entry.step.symbol ? undefined : "external-step"}>{entry.step.label}</span>
                )}
                {entry.step.repeated && <span className="muted" title="ran more than once in a row"> ↻</span>}
              </li>
            ),
          )}
        </ol>
      </details>
    </li>
  );
}

/** Unchanged steps either side of a change, like a diff's context lines. */
const CONTEXT_STEPS = 1;

/** A changed path as `git diff` shows a file: what changed, with a little context, the rest folded. */
function hunks(path: VariantRow["path"]): (VariantRow["path"][number] | { skipped: number })[] {
  const near = (i: number) => path.slice(Math.max(0, i - CONTEXT_STEPS), i + CONTEXT_STEPS + 1).some((entry) => entry.op !== Op.Same);
  const out: (VariantRow["path"][number] | { skipped: number })[] = [];
  let skipped = 0;
  path.forEach((entry, i) => {
    if (near(i)) {
      if (skipped > 0) out.push({ skipped });
      skipped = 0;
      out.push(entry);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) out.push({ skipped });
  return out;
}

function describe(row: VariantRow): string {
  if (row.change === Change.Changed) {
    const parts = [row.nowCalls.length ? `now calls ${row.nowCalls.join(", ")}` : "", row.noLongerCalls.length ? `no longer calls ${row.noLongerCalls.join(", ")}` : ""];
    return parts.filter(Boolean).join("; ") || "same calls, nested or ordered differently";
  }
  const { variant } = row;
  if (!variant.reachedHandler) return `never reached the handler: ${variant.adds.join(", ") || "no project code ran"}`;
  if (variant.isMain) return "main path";
  const parts = [variant.skips.length ? `skips ${variant.skips.join(", ")}` : "", variant.adds.length ? `adds ${variant.adds.join(", ")}` : ""];
  return parts.filter(Boolean).join("; ") || "same calls, nested or ordered differently";
}

function rowsFromMap(map: RouteMap): RouteRow[] {
  return map.routes.map((route) => ({
    id: route.id,
    label: route.label,
    routed: route.routed,
    change: null,
    variants: route.variants.map((variant) => ({
      variant,
      change: null,
      before: variant.requests.length,
      after: variant.requests.length,
      nowCalls: [],
      noLongerCalls: [],
      path: variant.steps.map((step) => ({ op: Op.Same, step })),
    })),
  }));
}

/** What changed first, within the list and within each route. */
function rowsFromDiff(diff: RouteMapDiff): RouteRow[] {
  const rank = (change: Change) => CHANGE_ORDER.indexOf(change);
  return [...diff.routes]
    .sort((a, b) => rank(a.change) - rank(b.change))
    .map((route) => ({
      id: route.id,
      label: route.label,
      routed: route.routed,
      change: route.change,
      variants: [...route.variants].sort((a, b) => rank(a.change) - rank(b.change)),
    }));
}
