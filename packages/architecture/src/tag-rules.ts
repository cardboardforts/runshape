// The rule engine: the taxonomy's rules (built in and the project's) read each item's tags and
// zone, and what they flag is a finding with a severity. Rules never read code, only claims.
import { QualifiedName, Renaming } from "@runshape/kernel";
import { CategorizedItem, Categorization, expectedZonesIn } from "./categorizer";
import { Glob } from "./glob";
import { profileFor } from "./profiles";
import { Axis, Condition, Kind, parseCondition, ROLE_LENSES, Severity, Taxonomy } from "./taxonomy";

export interface Finding {
  rule: string;
  severity: Exclude<Severity, "off">;
  /** The item's name, as CategorizedItem.name. */
  item: string;
  kind: Kind;
  /** A callable's CodeSymbol.key: findings pair across runs by it. */
  key: string | null;
  zone: string | null;
  region: string;
  message: string;
  /** Why: the evidence of the tags the rule read. */
  evidence: string[];
}

const SHOWN_EVIDENCE = 3;

/** Every finding the rules make on these items, in item order. */
export function checkTagRules(categorization: Categorization, taxonomy: Taxonomy): Finding[] {
  const rules = taxonomy.rules
    .filter((rule) => rule.severity !== "off")
    .map((rule) => ({ rule, glob: rule.match === null ? null : new Glob(rule.match), when: conditions(rule.when), flag: conditions(rule.flag), unless: conditions(rule.unless) }));
  const findings: Finding[] = [];
  for (const item of categorization.items) {
    const segments = QualifiedName.parse(item.name).segments;
    const regions = item.region === "" ? [] : item.region.split("/");
    for (const { rule, glob, when, flag, unless } of rules) {
      const inScope = glob === null ? rule.styles.includes(item.style) : glob.matches(segments);
      if (!inScope || regions.some((region) => rule.off_in.includes(region))) continue;
      const holds = (condition: Condition) => holdsFor(item, condition, taxonomy);
      if (!when.every(holds) || !flag.every(holds) || unless.some(holds)) continue;
      findings.push({
        rule: rule.id,
        severity: rule.severity as Finding["severity"],
        item: item.name,
        kind: item.kind,
        key: item.key,
        zone: item.zone,
        region: item.region,
        message: rule.message,
        evidence: evidenceFor(item, flag, taxonomy).slice(0, SHOWN_EVIDENCE),
      });
    }
  }
  return findings;
}

function conditions(texts: string[]): Condition[] {
  // Parsing already refused anything unreadable; a built-in rule that can't be read is a bug.
  return texts.map((text) => {
    const condition = parseCondition(text);
    if (condition === null) throw new Error(`unreadable condition ${JSON.stringify(text)}`);
    return condition;
  });
}

/** An axis with no value for this item (no zone, no tag in that lens) holds for neither "=" nor "!=": unknown isn't a yes. */
function holdsFor(item: CategorizedItem, condition: Condition, taxonomy: Taxonomy): boolean {
  const values = valuesOf(item, condition.axis, taxonomy);
  if (values.length === 0) return false;
  const matches = values.some((value) => condition.values.includes(value));
  return condition.negated ? !matches : matches;
}

function valuesOf(item: CategorizedItem, axis: string, taxonomy: Taxonomy): string[] {
  switch (axis) {
    case Axis.Kind:
      return [item.kind];
    case Axis.Style:
      return [item.style];
    case Axis.Zone:
      return item.zone === null ? [] : [item.zone];
    case Axis.Role:
      return item.tags.filter((tag) => ROLE_LENSES.includes(tag.lens)).map((tag) => tag.id);
    case Axis.ZoneExpected: {
      const verdicts = misplacedRoles(item, taxonomy);
      if (verdicts.length === 0) return [];
      return verdicts.some((verdict) => verdict.expected.length > 0 && !verdict.expected.includes(item.zone!)) ? ["no"] : ["yes"];
    }
    case Axis.ZoneIo: {
      const profile = profileFor(item.style);
      return item.zone === null || profile === undefined ? [] : [profile.externalAccess.includes(item.zone) ? "yes" : "no"];
    }
    default:
      return item.tags.filter((tag) => tag.lens === axis).map((tag) => tag.id);
  }
}

/** Each role tag whose definition says where it belongs in the item's style. */
function misplacedRoles(item: CategorizedItem, taxonomy: Taxonomy): { role: string; expected: string[] }[] {
  if (item.zone === null) return [];
  return item.tags
    .filter((tag) => ROLE_LENSES.includes(tag.lens))
    .flatMap((tag) => {
      const definition = taxonomy.definition(tag.lens, tag.id);
      const expected = definition === undefined ? [] : expectedZonesIn(definition, item.style);
      return expected.length === 0 ? [] : [{ role: tag.id, expected }];
    });
}

/** The evidence behind the flag: the tags of the lenses it named, and for a misplaced role, where it belongs. */
function evidenceFor(item: CategorizedItem, flag: Condition[], taxonomy: Taxonomy): string[] {
  const out: string[] = [];
  for (const condition of flag) {
    if (condition.axis === Axis.ZoneExpected) {
      for (const verdict of misplacedRoles(item, taxonomy).filter((v) => !v.expected.includes(item.zone!))) {
        const tag = item.tags.find((candidate) => candidate.id === verdict.role)!;
        out.push(`${verdict.role} belongs in ${verdict.expected.join(" or ")}, it's in ${item.zone} (${tag.evidence[0]})`);
      }
    } else if (condition.axis === Axis.ZoneIo) {
      out.push(`${item.style} lets only ${profileFor(item.style)?.externalAccess.join(", ")} talk to external systems; it's in ${item.zone}`);
    } else {
      const tags = condition.axis === Axis.Role ? item.tags.filter((tag) => ROLE_LENSES.includes(tag.lens)) : item.tags.filter((tag) => tag.lens === condition.axis);
      for (const tag of tags.filter((candidate) => condition.values.includes(candidate.id))) out.push(`${tag.id}: ${tag.evidence.join("; ")}`);
    }
  }
  return out;
}

/** How a base finding's item is named in head: a moved type or module, a moved function's key. */
export interface FindingRenaming extends Renaming {
  functionKey(baseKey: string): string;
}

/**
 * Findings head has that the base didn't, with renames recognised so a moved function's old
 * finding isn't reported as new. A finding is the same when its rule and item are.
 */
export function newFindings(before: Finding[], after: Finding[], renaming: FindingRenaming): Finding[] {
  const identity = (finding: Finding, name: string, key: string | null) => `${finding.rule} ${finding.kind} ${key ?? name}`;
  const renamed = (finding: Finding): string => {
    if (finding.key !== null) return identity(finding, finding.item, renaming.functionKey(finding.key));
    const name = QualifiedName.parse(finding.item);
    if (finding.kind === Kind.Container) return identity(finding, renaming.module(name).text, null);
    if (finding.kind === Kind.Type) return identity(finding, renaming.type(name).text, null);
    const holder = name.parent();
    return identity(finding, holder === null ? finding.item : new QualifiedName([...renaming.type(holder).segments, name.last]).text, null);
  };
  const known = new Set(before.map(renamed));
  return after.filter((finding) => !known.has(identity(finding, finding.item, finding.key)));
}
