// Declared zones: the architecture the team intends, checked into the repo as runshape.json.
// Inference says what a component *does*; a rule says what it *is supposed to be*. Where the
// two disagree is the architecture finding.

import { ArchitectureProfile, QualifiedName, splitDotted } from "@runshape/kernel";
import { HEXAGONAL, PROFILES, profileFor } from "./profiles";

export const RULES_FILE = "runshape.json";
/** Version 2 says "zones" and names the style; version 1 said "rings" and is still read. */
export const RULES_VERSION = 2;
/** Version 3 adds nested regions; a file without regions is still written as version 2. */
export const REGIONS_VERSION = 3;

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
  /**
   * "composition-root": code that builds the adapters and hands them in (an app's main, a
   * framework's dependency functions). Its calls wire; they don't break the style.
   */
  role?: ZoneRole;
}

export type ZoneRole = "composition-root";
const ROLES: ZoneRole[] = ["composition-root"];

const DECIDERS: ZoneRule["by"][] = ["user", "llm", "detected"];

export interface ZoneRulesFile {
  version: number;
  style: string;
  zones: ZoneRule[];
  /** Version 3: areas inside this one with a style of their own. */
  regions?: RegionFile[];
}

/** A region as runshape.json writes it. */
export interface RegionFile {
  name: string;
  match: string;
  in: string;
  style: string;
  reason: string;
  by: ZoneRule["by"];
  zones: ZoneRule[];
  regions?: RegionFile[];
}

/**
 * An area of the code with one style, inside one zone of the area around it: Runshape's trace
 * module could be layered inside the hexagon's core. A subtree of names, so "inside" can be
 * checked when the file loads.
 */
export interface Region {
  name: string;
  /** "a.b.**" (the name and everything under it) or one exact name. */
  match: string;
  /** The parent's zone the region sits in, whole. */
  in: string;
  reason: string;
  by: ZoneRule["by"];
  /** Its own rules, in its own style, and its own regions. */
  rules: ZoneRules;
}

/** Where a name lands in one area: the region (top level: ""), its style, and the zone a rule gives it there. */
export interface RegionPlacement {
  region: string;
  style: string;
  /** Null when no rule there names it: inference decides. */
  zone: string | null;
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

/**
 * First matching rule wins, so specific rules go above broad ones. A name inside a region is
 * the region's: at this level it sits in the region's zone, whatever the rules here say.
 */
export class ZoneRules {
  private readonly compiled: { rule: ZoneRule; glob: Glob }[];
  private readonly compiledRegions: { region: Region; glob: Glob }[];

  constructor(
    readonly rules: ZoneRule[],
    /** The style the file declares; its zones are the ones rules may name. */
    readonly profile: ArchitectureProfile = HEXAGONAL,
    readonly regions: Region[] = [],
  ) {
    this.compiled = rules.map((rule) => ({ rule, glob: new Glob(rule.match) }));
    this.compiledRegions = regions.map((region) => ({ region, glob: new Glob(region.match) }));
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
    if (file.version !== RULES_VERSION && file.version !== REGIONS_VERSION) {
      problems.push(`"version" must be ${REGIONS_VERSION} (or ${RULES_VERSION} without regions, or 1, the older "rings" format)`);
    }
    if (file.version !== REGIONS_VERSION && file.regions !== undefined) problems.push(`"regions" needs "version": ${REGIONS_VERSION}`);
    const rules = readArea(file, "", null, problems);
    if (problems.length > 0) throw new ZoneRulesError(problems);
    return rules;
  }

  /** Version 3 when there are regions; otherwise version 2, so a file without them doesn't churn. */
  serialize(): string {
    const file: ZoneRulesFile = { version: this.regions.length > 0 ? REGIONS_VERSION : RULES_VERSION, style: this.profile.style, zones: this.rules };
    if (this.regions.length > 0) file.regions = this.regions.map(regionFile);
    return `${JSON.stringify(file, null, 2)}\n`;
  }

  /** At this level: a name inside a region sits in the region's zone; otherwise the first rule that matches. */
  matchFor(name: QualifiedName): RuleMatch | null {
    const region = this.regionContaining(name);
    if (region !== null) {
      const reason = `the ${region.name} region (${region.rules.profile.style}): ${region.reason}`;
      return { rule: { match: region.match, zone: region.in, reason, by: region.by }, index: -1 };
    }
    for (let index = 0; index < this.compiled.length; index += 1) {
      const entry = this.compiled[index]!;
      if (entry.glob.matches(name.segments)) return { rule: entry.rule, index };
    }
    return null;
  }

  /** Where a name lands at every level, outermost first: the top level, then each region it's in. */
  placementsOf(name: QualifiedName, regionName = ""): RegionPlacement[] {
    const here: RegionPlacement = { region: regionName, style: this.profile.style, zone: this.matchFor(name)?.rule.zone ?? null };
    const region = this.regionContaining(name);
    return region === null ? [here] : [here, ...region.rules.placementsOf(name, region.name)];
  }

  /**
   * The rule for exactly this name replaces any earlier one and goes first: it's the most
   * specific. Inside a region it goes into the innermost region's rules, in that region's style.
   */
  withRuleFor(qualifiedName: string, zone: string, reason: string, by: ZoneRule["by"]): ZoneRules {
    return this.withRuleIn(qualifiedName, zone, reason, by, null);
  }

  private withRuleIn(qualifiedName: string, zone: string, reason: string, by: ZoneRule["by"], inRegion: string | null): ZoneRules {
    const region = this.regionContaining(QualifiedName.parse(qualifiedName));
    if (region !== null) {
      const regions = this.regions.map((candidate) => (candidate === region ? { ...region, rules: region.rules.withRuleIn(qualifiedName, zone, reason, by, region.name) } : candidate));
      return new ZoneRules(this.rules, this.profile, regions);
    }
    if (inRegion !== null && !this.isZoneOfStyle(zone)) {
      const zones = this.profile.zones.map((candidate) => candidate.id).join(", ");
      throw new ZoneRulesError([`${qualifiedName} is in the ${inRegion} region (${this.profile.style}): its zone is one of ${zones}`]);
    }
    const replaced = this.rules.find((rule) => rule.match === qualifiedName);
    const others = this.rules.filter((rule) => rule !== replaced);
    // Placing a composition root again keeps it one: the role is about what it does, not where it sits.
    const role = replaced?.role === undefined ? {} : { role: replaced.role };
    return new ZoneRules([{ match: qualifiedName, zone, reason, by, ...role }, ...others], this.profile, this.regions);
  }

  private regionContaining(name: QualifiedName): Region | null {
    return this.compiledRegions.find((entry) => entry.glob.matches(name.segments))?.region ?? null;
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

/** The top level of runshape.json, or one region in it: a style, its rules, and regions inside. */
interface AreaFile {
  style?: unknown;
  zones?: unknown;
  regions?: unknown;
}

/** A region's names: one exact name, or a name and everything under it. */
interface Subtree {
  segments: string[];
  exact: boolean;
}

/**
 * One area's rules and regions, each problem pushed with where it is ("regions[0].zones[1]").
 * `around` is the region this area is (null at the top level): its rules must stay inside it.
 */
function readArea(file: AreaFile, where: string, around: { name: string; match: string; subtree: Subtree } | null, problems: string[]): ZoneRules {
  const path = where === "" ? "" : `${where}.`;
  const field = (name: string) => (where === "" ? `"${name}"` : `${path}${name}`);
  // The top level was hexagonal before files named a style; a region always names its own.
  const profile = file.style === undefined && where === "" ? HEXAGONAL : profileFor(file.style as string);
  if (profile === undefined) problems.push(`${field("style")} ${JSON.stringify(file.style)} is not one of ${PROFILES.map((p) => p.style).join(", ")}`);
  const zonesGiven = file.zones === undefined && where !== "" ? [] : file.zones;
  if (!Array.isArray(zonesGiven)) problems.push(`${field("zones")} must be a list of rules`);
  const allowed = (profile ?? HEXAGONAL).zones.map((zone) => zone.id);

  const rules: ZoneRule[] = [];
  (Array.isArray(zonesGiven) ? zonesGiven : []).forEach((candidate: Partial<ZoneRule>, index) => {
    const at = `${path}zones[${index}]`;
    const before = problems.length;
    if (typeof candidate?.match !== "string" || candidate.match.trim() === "") problems.push(`${at}.match must be a non-empty string`);
    else if (around !== null && isOutside(candidate.match, around.subtree)) problems.push(`${at}.match ${candidate.match} is outside the ${around.name} region (${around.match})`);
    if (profile !== undefined && !allowed.includes(candidate?.zone as string)) {
      problems.push(`${at}.zone must be one of ${allowed.join(", ")} (the ${profile.style} zones)`);
    }
    if (typeof candidate?.reason !== "string" || candidate.reason.trim() === "") problems.push(`${at}.reason must say why`);
    if (candidate?.by !== undefined && !DECIDERS.includes(candidate.by)) problems.push(`${at}.by must be "user", "llm" or "detected"`);
    if (candidate?.role !== undefined) {
      if (!ROLES.includes(candidate.role)) problems.push(`${at}.role must be ${ROLES.map((role) => `"${role}"`).join(" or ")}, or left out`);
      // Only the top level's graph is judged by edge; a role in a region would silently do nothing.
      else if (around !== null) problems.push(`${at}.role: a composition root is declared at the top level, not inside a region`);
      // A role silences every finding from what it matches: it names code, it doesn't sweep.
      else if (typeof candidate.match === "string" && fixedPrefix(candidate.match).segments.length === 0) problems.push(`${at}.role needs a match that names code ("app.main", "app.wiring.**"), not one that starts with a wildcard`);
    }
    if (problems.length === before) {
      rules.push({ match: candidate.match!, zone: candidate.zone!, reason: candidate.reason!, by: candidate.by ?? "user", ...(candidate.role === undefined ? {} : { role: candidate.role }) });
    }
  });

  const regions: Region[] = [];
  const placed: { name: string; index: number; subtree: Subtree }[] = [];
  const regionsGiven = file.regions === undefined ? [] : file.regions;
  if (!Array.isArray(regionsGiven)) problems.push(`${field("regions")} must be a list of regions`);
  (Array.isArray(regionsGiven) ? regionsGiven : []).forEach((given: unknown, index) => {
    const at = `${path}regions[${index}]`;
    if (typeof given !== "object" || given === null) {
      problems.push(`${at} must be a region: name, match, in, style, reason, zones`);
      return;
    }
    const candidate = given as Partial<RegionFile>;
    const before = problems.length;
    const name = typeof candidate.name === "string" && candidate.name.trim() !== "" ? candidate.name : null;
    if (name === null) problems.push(`${at}.name must be a non-empty string`);
    const subtree = typeof candidate.match === "string" ? subtreeOf(candidate.match) : null;
    if (subtree === null) problems.push(`${at}.match must be a name, or a name and everything under it ("a.b.**")`);
    else if (around !== null && !contains(around.subtree, subtree)) problems.push(`${at}.match ${candidate.match} is outside the ${around.name} region (${around.match})`);
    if (name !== null && placed.some((other) => other.name === name)) problems.push(`${at}.name ${name} is used by another region here: names say which region a review means`);
    if (subtree !== null) {
      for (const other of placed) {
        if (contains(other.subtree, subtree) || contains(subtree, other.subtree)) {
          problems.push(`${at} (${name ?? "unnamed"}) overlaps ${path}regions[${other.index}] (${other.name}): a name is in one region at each level`);
        }
      }
      placed.push({ name: name ?? "unnamed", index, subtree });
    }
    if (profile !== undefined && !allowed.includes(candidate.in as string)) {
      problems.push(`${at}.in must be one of ${allowed.join(", ")} (the ${profile.style} zone it sits in)`);
    }
    if (typeof candidate.reason !== "string" || candidate.reason.trim() === "") problems.push(`${at}.reason must say why`);
    if (candidate.by !== undefined && !DECIDERS.includes(candidate.by)) problems.push(`${at}.by must be "user", "llm" or "detected"`);
    const inner = readArea(candidate, at, subtree === null ? null : { name: name ?? "unnamed", match: candidate.match!, subtree }, problems);
    if (problems.length === before) regions.push({ name: name!, match: candidate.match!, in: candidate.in!, reason: candidate.reason!, by: candidate.by ?? "user", rules: inner });
  });

  // A rule here that only ever matches names inside a region would put part of it in another zone.
  rules.forEach((rule, index) => {
    const inside = placed.find((region) => isInside(rule.match, region.subtree));
    if (inside !== undefined) {
      problems.push(`${path}zones[${index}] (${rule.match}) is inside the ${inside.name} region: a region sits in one zone, whole; set it in the region's zones`);
    }
  });
  return new ZoneRules(rules, profile ?? HEXAGONAL, regions);
}

function subtreeOf(match: string): Subtree | null {
  const segments = splitDotted(match);
  const exact = segments.at(-1) !== "**";
  const prefix = exact ? segments : segments.slice(0, -1);
  if (prefix.length === 0 || prefix.some((segment) => segment.includes("*"))) return null;
  return { segments: prefix, exact };
}

/** Every name in `inner` is in `outer`. */
function contains(outer: Subtree, inner: Subtree): boolean {
  if (outer.exact) return inner.exact && startsWith(inner.segments, outer.segments) && inner.segments.length === outer.segments.length;
  return startsWith(inner.segments, outer.segments);
}

/** The segments a rule's glob fixes before its first wildcard: every name it matches starts with them. */
function fixedPrefix(match: string): { segments: string[]; wild: boolean } {
  const segments = splitDotted(match);
  const first = segments.findIndex((segment) => segment.includes("*"));
  return first === -1 ? { segments, wild: false } : { segments: segments.slice(0, first), wild: true };
}

/** The rule matches only names inside the region. */
function isInside(match: string, region: Subtree): boolean {
  const fixed = fixedPrefix(match);
  if (region.exact) return !fixed.wild && fixed.segments.length === region.segments.length && startsWith(fixed.segments, region.segments);
  return startsWith(fixed.segments, region.segments);
}

/** The rule can match no name inside the region. */
function isOutside(match: string, region: Subtree): boolean {
  const fixed = fixedPrefix(match);
  // An exact region holds one name: a rule fixing more segments than that can never match it.
  if (region.exact && fixed.segments.length > region.segments.length) return true;
  return !startsWith(fixed.segments, region.segments) && !startsWith(region.segments, fixed.segments);
}

function startsWith(segments: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= segments.length && prefix.every((segment, i) => segments[i] === segment);
}

/** A region as a review compares it: by its path ("trace/moves"), its own rules included, its regions apart. */
export interface RegionSummary {
  path: string;
  match: string;
  in: string;
  style: string;
  reason: string;
  by: ZoneRule["by"];
  zones: ZoneRule[];
}

/** Every region at every depth, outermost first. */
export function flattenRegions(regions: readonly RegionFile[], parent = ""): RegionSummary[] {
  return regions.flatMap((region) => {
    const path = parent === "" ? region.name : `${parent}/${region.name}`;
    const { regions: inner, name: _name, ...own } = region;
    return [{ path, ...own }, ...flattenRegions(inner ?? [], path)];
  });
}

export function regionFile(region: Region): RegionFile {
  const file: RegionFile = { name: region.name, match: region.match, in: region.in, style: region.rules.profile.style, reason: region.reason, by: region.by, zones: region.rules.rules };
  if (region.rules.regions.length > 0) file.regions = region.rules.regions.map(regionFile);
  return file;
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
