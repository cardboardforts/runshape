// Declared zones: the architecture the team intends, checked into the repo as runshape.json.
// Inference says what a component *does*; a rule says what it *is supposed to be*. Where the
// two disagree is the architecture finding.

import { QualifiedName, splitDotted } from "@runshape/trace";
import { ArchitectureProfile, HEXAGONAL, PROFILES, profileFor } from "./profiles";

export const RULES_FILE = "runshape.json";
/** Version 2 says "zones" and names the style; version 1 said "rings" and is still read. */
export const RULES_VERSION = 2;

export interface ZoneRule {
  /**
   * Dotted-name glob: `*` is any text within one segment, `**` any number of segments (zero too:
   * `app.**` matches `app`). A dot inside a segment is written `\.` (Go's `example\.com.shop`).
   */
  match: string;
  /** One of the style's zone ids (profiles.ts). Framework, external and test-double zones are facts, not choices. */
  zone: string;
  reason: string;
  /** Who decided: a person, or a model's or the detector's proposal a person accepted. */
  by: "user" | "llm" | "detected";
}

const DECIDERS: ZoneRule["by"][] = ["user", "llm", "detected"];

export interface ZoneRulesFile {
  version: number;
  style: string;
  zones: ZoneRule[];
}

/** runshape.json version 1, from before zones were called zones. */
interface RingRulesFileV1 {
  version: 1;
  rings: { match?: string; ring?: string; reason?: string; by?: string }[];
}

export class ZoneRulesError extends Error {
  constructor(readonly problems: string[]) {
    super(`${RULES_FILE} is invalid:\n  - ${problems.join("\n  - ")}`);
  }
}

export interface RuleMatch {
  rule: ZoneRule;
  index: number;
}

/** First matching rule wins, so specific rules go above broad ones. */
export class ZoneRules {
  private readonly compiled: { rule: ZoneRule; glob: Glob }[];

  constructor(
    readonly rules: ZoneRule[],
    /** The style the file declares; its zones are the ones rules may name. */
    readonly profile: ArchitectureProfile = HEXAGONAL,
  ) {
    this.compiled = rules.map((rule) => ({ rule, glob: new Glob(rule.match) }));
  }

  static none(profile: ArchitectureProfile = HEXAGONAL): ZoneRules {
    return new ZoneRules([], profile);
  }

  /** Validates every rule and reports all problems at once. */
  static parse(text: string): ZoneRules {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new ZoneRulesError([`not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
    }
    const problems: string[] = [];
    if (typeof data !== "object" || data === null) throw new ZoneRulesError(["expected an object"]);
    const file = upgrade(data as Partial<ZoneRulesFile> | RingRulesFileV1);
    if (file.version !== RULES_VERSION) problems.push(`"version" must be ${RULES_VERSION} (or 1, the older "rings" format)`);
    const profile = file.style === undefined ? HEXAGONAL : profileFor(file.style);
    if (profile === undefined) {
      problems.push(`"style" ${JSON.stringify(file.style)} is not one of ${PROFILES.map((p) => p.style).join(", ")}`);
    }
    if (!Array.isArray(file.zones)) problems.push(`"zones" must be a list of rules`);
    const allowed = (profile ?? HEXAGONAL).zones.map((zone) => zone.id);
    const rules: ZoneRule[] = [];
    (Array.isArray(file.zones) ? file.zones : []).forEach((candidate: Partial<ZoneRule>, index) => {
      const where = `zones[${index}]`;
      const before = problems.length;
      if (typeof candidate?.match !== "string" || candidate.match.trim() === "") problems.push(`${where}.match must be a non-empty string`);
      if (profile !== undefined && !allowed.includes(candidate?.zone as string)) {
        problems.push(`${where}.zone must be one of ${allowed.join(", ")} (the ${profile.style} zones)`);
      }
      if (typeof candidate?.reason !== "string" || candidate.reason.trim() === "") problems.push(`${where}.reason must say why`);
      if (candidate?.by !== undefined && !DECIDERS.includes(candidate.by)) problems.push(`${where}.by must be "user", "llm" or "detected"`);
      if (problems.length === before) {
        rules.push({ match: candidate.match!, zone: candidate.zone!, reason: candidate.reason!, by: candidate.by ?? "user" });
      }
    });
    if (problems.length > 0) throw new ZoneRulesError(problems);
    return new ZoneRules(rules, profile);
  }

  serialize(): string {
    const file: ZoneRulesFile = { version: RULES_VERSION, style: this.profile.style, zones: this.rules };
    return `${JSON.stringify(file, null, 2)}\n`;
  }

  matchFor(name: QualifiedName): RuleMatch | null {
    for (let index = 0; index < this.compiled.length; index += 1) {
      const entry = this.compiled[index]!;
      if (entry.glob.matches(name.segments)) return { rule: entry.rule, index };
    }
    return null;
  }

  /** The rule for exactly this name replaces any earlier one and goes first: it's the most specific. */
  withRuleFor(qualifiedName: string, zone: string, reason: string, by: ZoneRule["by"]): ZoneRules {
    const others = this.rules.filter((rule) => rule.match !== qualifiedName);
    return new ZoneRules([{ match: qualifiedName, zone, reason, by }, ...others], this.profile);
  }

  isZoneOfStyle(zone: string): boolean {
    return this.profile.zones.some((candidate) => candidate.id === zone);
  }
}

/**
 * Matches dotted names against a glob, segment by segment: "**" is any number of segments
 * (none too), "*" any text within one segment. Not a regular expression: a run of "**"
 * made one backtrack exponentially, and the globs come from a file in the repository. The
 * memo bounds the work to pattern segments × name segments.
 */
class Glob {
  private readonly segments: string[];

  constructor(pattern: string) {
    this.segments = splitDotted(pattern);
  }

  matches(parts: readonly string[]): boolean {
    const memo = new Map<number, boolean>();
    const from = (p: number, n: number): boolean => {
      const key = p * (parts.length + 1) + n;
      const known = memo.get(key);
      if (known !== undefined) return known;
      let result: boolean;
      if (p === this.segments.length) {
        result = n === parts.length;
      } else if (this.segments[p] === "**") {
        // Zero segments, or one more and stay on "**".
        result = from(p + 1, n) || (n < parts.length && from(p, n + 1));
      } else {
        result = n < parts.length && segmentMatches(this.segments[p]!, parts[n]!) && from(p + 1, n + 1);
      }
      memo.set(key, result);
      return result;
    };
    return from(0, 0);
  }
}

/** "*" is any text (a "**" inside a segment counts as "*"); greedy with one backtrack point, so linear. */
function segmentMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      resume = t;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/** Reads a version 1 file ("rings", "ring") as version 2; the next save writes version 2. */
function upgrade(file: Partial<ZoneRulesFile> | RingRulesFileV1): Partial<ZoneRulesFile> {
  if (file.version !== 1 || !Array.isArray((file as RingRulesFileV1).rings)) return file as Partial<ZoneRulesFile>;
  // Anything not an object is passed through for parse() to report with the rest.
  const zones = (file as RingRulesFileV1).rings.map((entry) => {
    if (typeof entry !== "object" || entry === null) return entry;
    const { ring, ...rest } = entry;
    return { ...rest, zone: ring };
  });
  // Version 1 predates styles: its rings were the hexagon's zones.
  return { version: RULES_VERSION, style: HEXAGONAL.style, zones: zones as unknown as ZoneRule[] };
}
