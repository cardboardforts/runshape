import type { ReactNode } from "react";

import { ArchitectureDiff, Placement, PlacementChange, ZoneRule } from "@runshape/core";

interface Props {
  diff: ArchitectureDiff;
  /** False when the base was drawn with the current rules, its own being unknown. */
  baseRulesKnown: boolean;
  zoneName: (zone: string) => string;
  onOpenComponent: (qualifiedName: string) => void;
}

/**
 * How the change moved the architecture, as a reviewer approves it with the code: what was
 * decided (rules, and what they moved), what still needs a decision (new code no rule covers),
 * and what only moved because the tests behave differently.
 */
export function ArchitectureChangesPanel({ diff, baseRulesKnown, zoneName, onOpenComponent }: Props) {
  const { rules, decided, observed, unplaced, removed, unusedRules } = diff;
  const ruleChanges = rules.added.length + rules.removed.length + rules.changed.length;
  const nothing = ruleChanges + decided.length + observed.length + unplaced.length + removed.length + unusedRules.length === 0 && diff.styleBefore === diff.styleAfter;
  const name = (component: string) => (
    <button type="button" className="link component-name" onClick={() => onOpenComponent(component)} title={component}>
      {shortName(component)}
    </button>
  );
  const placed = (placement: Placement | null) =>
    placement === null ? "—" : `${zoneName(placement.zone)}${placement.decidedBy ? ` (${placement.decidedBy === "llm" ? "model" : placement.decidedBy})` : " (inferred)"}`;

  return (
    <div className="architecture-changes">
      {!baseRulesKnown && (
        <p className="muted notice-inline">
          The base's own runshape.json isn't known (recorded before zones were kept), so both sides use the current rules: only new and gone code shows here.
        </p>
      )}
      {nothing && <p className="muted">No architecture changes: the same rules, and no new code they don't cover.</p>}
      {diff.styleBefore !== diff.styleAfter && (
        <p>
          <strong>Style changed</strong>: {diff.styleBefore} → {diff.styleAfter}. Both sides are drawn as {diff.styleAfter}.
        </p>
      )}

      {(ruleChanges > 0 || decided.length > 0) && (
        <section aria-labelledby="decided-heading">
          <h3 id="decided-heading">Decided in this change</h3>
          {ruleChanges > 0 && (
            <ul className="rule-changes">
              {rules.added.map((rule) => (
                <li key={`added:${rule.match}`} className="op-added">
                  <span className="mark">+</span> <RuleText rule={rule} zoneName={zoneName} />
                </li>
              ))}
              {rules.removed.map((rule) => (
                <li key={`removed:${rule.match}`} className="op-removed">
                  <span className="mark">−</span> <RuleText rule={rule} zoneName={zoneName} />
                </li>
              ))}
              {rules.changed.map(({ before, after }) => (
                <li key={`changed:${after.match}`}>
                  <span className="mark">~</span> <code>{after.match}</code>: {zoneName(before.zone)} by {decider(before)} → {zoneName(after.zone)} by {decider(after)}
                  <div className="muted">{after.reason}</div>
                </li>
              ))}
            </ul>
          )}
          <PlacementList changes={decided.filter(movedZone)} name={name} placed={placed} />
          {decided.some((change) => !movedZone(change)) && (
            <details>
              <summary className="muted">{decided.filter((change) => !movedZone(change)).length} now declared where they already were (or by someone else)</summary>
              <PlacementList changes={decided.filter((change) => !movedZone(change))} name={name} placed={placed} />
            </details>
          )}
        </section>
      )}

      {unplaced.length > 0 && (
        <section aria-labelledby="unplaced-heading">
          <h3 id="unplaced-heading">Needs a decision ({unplaced.length})</h3>
          <p className="muted">Code the base's tests never ran, placed by its behaviour alone: no rule says where it belongs.</p>
          <ul className="placements">
            {unplaced.map((placement) => (
              <li key={`${placement.kind}:${placement.component}`}>
                {name(placement.component)} <span className="zone-tag">{zoneName(placement.zone)}?</span>
                <div className="muted">{placement.reason}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {observed.length > 0 && (
        <section aria-labelledby="observed-heading">
          <h3 id="observed-heading">Moved with behaviour ({observed.length})</h3>
          <p className="muted">No rule on either side: the tests now behave differently (a mocked database, a new route), so the inferred zone moved.</p>
          <PlacementList changes={observed} name={name} placed={placed} />
        </section>
      )}

      {removed.length > 0 && (
        <section aria-labelledby="removed-heading">
          <h3 id="removed-heading">No longer recorded ({removed.length})</h3>
          <ul className="placements">
            {removed.map((placement) => (
              <li key={`${placement.kind}:${placement.component}`} className="op-removed" title={placement.component}>
                {shortName(placement.component)} <span className="muted">was {placed(placement)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unusedRules.length > 0 && (
        <section aria-labelledby="unused-heading">
          <h3 id="unused-heading">Rules that place nothing ({unusedRules.length})</h3>
          <p className="muted">No recorded class or module matches them: renamed code, or code the tests don't run.</p>
          <ul className="placements">
            {unusedRules.map((match) => (
              <li key={match}>
                <code>{match}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function PlacementList({
  changes,
  name,
  placed,
}: {
  changes: PlacementChange[];
  name: (component: string) => ReactNode;
  placed: (placement: Placement | null) => string;
}) {
  if (changes.length === 0) return null;
  return (
    <ul className="placements">
      {changes.map((change) => (
        <li key={`${change.kind}:${change.component}`}>
          {name(change.component)} {placed(change.before)} → <strong>{placed(change.after)}</strong>
          {change.movedFrom && <div className="muted">moved from {change.movedFrom}</div>}
          {change.after?.reason && <div className="muted">{change.after.reason}</div>}
        </li>
      ))}
    </ul>
  );
}

function RuleText({ rule, zoneName }: { rule: ZoneRule; zoneName: (zone: string) => string }) {
  return (
    <>
      <code>{rule.match}</code> → {zoneName(rule.zone)} <span className="muted">by {decider(rule)}</span>
      <div className="muted">{rule.reason}</div>
    </>
  );
}

/** A decision that put it somewhere else, rather than writing down where it already was. */
function movedZone(change: PlacementChange): boolean {
  return change.before?.zone !== change.after?.zone;
}

function decider(rule: ZoneRule): string {
  return rule.by === "llm" ? "a model" : rule.by === "detected" ? "the detector" : "a person";
}

/** The last two segments: enough to recognise a class in a narrow sidebar; the full name is its title. */
function shortName(component: string): string {
  const segments = component.split(/(?<!\\)\./);
  return segments.slice(-2).join(".");
}
