// Declared zones: the architecture the team intends, checked into the repo as hexvis.json.
// Inference says what a component *does*; a rule says what it *is supposed to be*. Where the
// two disagree is the architecture finding.

export const RULES_FILE = "hexvis.json";
/** Version 2 says "zones" and names the style; version 1 said "rings" and is still read. */
export const RULES_VERSION = 2;
/** The only style the viewer draws so far; see docs/architecture-profiles.md for the rest. */
export const DRAWN_STYLE = "hexagonal";

/** The zones a rule may assign. Framework, external and test-double zones are facts, not choices. */
export enum DeclaredZone {
  InboundAdapter = "inbound-adapter",
  Core = "core",
  OutboundAdapter = "outbound-adapter",
}

export interface ZoneRule {
  /** Dotted-name glob: `*` is any text within one segment, `**` any number of segments (zero too: `app.**` matches `app`). */
  match: string;
  zone: DeclaredZone;
  reason: string;
  /** Who decided: a person, or a model's proposal a person accepted. */
  by: "user" | "llm";
}

export interface ZoneRulesFile {
  version: number;
  style: string;
  zones: ZoneRule[];
}

/** hexvis.json version 1, from before zones were called zones. */
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
  private readonly compiled: { rule: ZoneRule; pattern: RegExp }[];

  constructor(readonly rules: ZoneRule[]) {
    this.compiled = rules.map((rule) => ({ rule, pattern: globToRegExp(rule.match) }));
  }

  static none(): ZoneRules {
    return new ZoneRules([]);
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
    if (file.style !== undefined && file.style !== DRAWN_STYLE) {
      problems.push(`"style" ${JSON.stringify(file.style)} isn't drawn yet; only "${DRAWN_STYLE}" is (see docs/architecture-profiles.md)`);
    }
    if (!Array.isArray(file.zones)) problems.push(`"zones" must be a list of rules`);
    const allowed = Object.values(DeclaredZone) as string[];
    const rules: ZoneRule[] = [];
    (Array.isArray(file.zones) ? file.zones : []).forEach((candidate: Partial<ZoneRule>, index) => {
      const where = `zones[${index}]`;
      const before = problems.length;
      if (typeof candidate?.match !== "string" || candidate.match.trim() === "") problems.push(`${where}.match must be a non-empty string`);
      if (!allowed.includes(candidate?.zone as string)) problems.push(`${where}.zone must be one of ${allowed.join(", ")}`);
      if (typeof candidate?.reason !== "string" || candidate.reason.trim() === "") problems.push(`${where}.reason must say why`);
      if (candidate?.by !== undefined && candidate.by !== "user" && candidate.by !== "llm") problems.push(`${where}.by must be "user" or "llm"`);
      if (problems.length === before) {
        rules.push({ match: candidate.match!, zone: candidate.zone as DeclaredZone, reason: candidate.reason!, by: candidate.by ?? "user" });
      }
    });
    if (problems.length > 0) throw new ZoneRulesError(problems);
    return new ZoneRules(rules);
  }

  serialize(): string {
    const file: ZoneRulesFile = { version: RULES_VERSION, style: DRAWN_STYLE, zones: this.rules };
    return `${JSON.stringify(file, null, 2)}\n`;
  }

  matchFor(qualifiedName: string): RuleMatch | null {
    for (let index = 0; index < this.compiled.length; index += 1) {
      const entry = this.compiled[index]!;
      if (entry.pattern.test(qualifiedName)) return { rule: entry.rule, index };
    }
    return null;
  }

  /** The rule for exactly this name replaces any earlier one and goes first: it's the most specific. */
  withRuleFor(qualifiedName: string, zone: DeclaredZone, reason: string, by: ZoneRule["by"]): ZoneRules {
    const others = this.rules.filter((rule) => rule.match !== qualifiedName);
    return new ZoneRules([{ match: qualifiedName, zone, reason, by }, ...others]);
  }
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    // ".**" and "**." may stand for no segments at all, taking their dot with them.
    if (glob.startsWith(".**", i) && (i + 3 === glob.length || glob[i + 3] === ".")) {
      source += "(?:\\..*)?";
      i += 2;
    } else if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^.]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** Reads a version 1 file ("rings", "ring") as version 2; the next save writes version 2. */
function upgrade(file: Partial<ZoneRulesFile> | RingRulesFileV1): Partial<ZoneRulesFile> {
  if (file.version !== 1 || !Array.isArray((file as RingRulesFileV1).rings)) return file as Partial<ZoneRulesFile>;
  const zones = (file as RingRulesFileV1).rings.map(({ ring, ...rest }) => ({ ...rest, zone: ring }));
  return { version: RULES_VERSION, style: DRAWN_STYLE, zones: zones as unknown as ZoneRule[] };
}
