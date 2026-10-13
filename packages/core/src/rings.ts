// Declared rings: the architecture the team intends, checked into the repo as hexvis.json.
// Inference says what a component *does*; a rule says what it *is supposed to be*. Where the
// two disagree is the architecture finding.

export const RULES_FILE = "hexvis.json";
export const RULES_VERSION = 1;

/** The rings a rule may assign. Framework, external and test-double rings are facts, not choices. */
export enum DeclaredRing {
  InboundAdapter = "inbound-adapter",
  Core = "core",
  OutboundAdapter = "outbound-adapter",
}

export interface RingRule {
  /** Dotted-name glob: `*` is any text within one segment, `**` any number of segments. */
  match: string;
  ring: DeclaredRing;
  reason: string;
  /** Who decided: a person, or a model's proposal a person accepted. */
  by: "user" | "llm";
}

export interface RingRulesFile {
  version: number;
  rings: RingRule[];
}

export class RingRulesError extends Error {
  constructor(readonly problems: string[]) {
    super(`${RULES_FILE} is invalid:\n  - ${problems.join("\n  - ")}`);
  }
}

export interface RuleMatch {
  rule: RingRule;
  index: number;
}

/** First matching rule wins, so specific rules go above broad ones. */
export class RingRules {
  private readonly compiled: { rule: RingRule; pattern: RegExp }[];

  constructor(readonly rules: RingRule[]) {
    this.compiled = rules.map((rule) => ({ rule, pattern: globToRegExp(rule.match) }));
  }

  static none(): RingRules {
    return new RingRules([]);
  }

  /** Validates every rule and reports all problems at once. */
  static parse(text: string): RingRules {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new RingRulesError([`not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
    }
    const problems: string[] = [];
    if (typeof data !== "object" || data === null) throw new RingRulesError(["expected an object"]);
    const file = data as Partial<RingRulesFile>;
    if (file.version !== RULES_VERSION) problems.push(`"version" must be ${RULES_VERSION}`);
    if (!Array.isArray(file.rings)) problems.push(`"rings" must be a list of rules`);
    const allowed = Object.values(DeclaredRing) as string[];
    const rules: RingRule[] = [];
    (Array.isArray(file.rings) ? file.rings : []).forEach((candidate: Partial<RingRule>, index) => {
      const where = `rings[${index}]`;
      const before = problems.length;
      if (typeof candidate?.match !== "string" || candidate.match.trim() === "") problems.push(`${where}.match must be a non-empty string`);
      if (!allowed.includes(candidate?.ring as string)) problems.push(`${where}.ring must be one of ${allowed.join(", ")}`);
      if (typeof candidate?.reason !== "string" || candidate.reason.trim() === "") problems.push(`${where}.reason must say why`);
      if (candidate?.by !== undefined && candidate.by !== "user" && candidate.by !== "llm") problems.push(`${where}.by must be "user" or "llm"`);
      if (problems.length === before) {
        rules.push({ match: candidate.match!, ring: candidate.ring as DeclaredRing, reason: candidate.reason!, by: candidate.by ?? "user" });
      }
    });
    if (problems.length > 0) throw new RingRulesError(problems);
    return new RingRules(rules);
  }

  serialize(): string {
    const file: RingRulesFile = { version: RULES_VERSION, rings: this.rules };
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
  withRuleFor(qualifiedName: string, ring: DeclaredRing, reason: string, by: RingRule["by"]): RingRules {
    const others = this.rules.filter((rule) => rule.match !== qualifiedName);
    return new RingRules([{ match: qualifiedName, ring, reason, by }, ...others]);
  }
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
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
