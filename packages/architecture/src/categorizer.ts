// The deterministic categorizer (docs/categorizer.md): each piece of code the recording knows,
// its kind (a parser fact), the roles its region's style gives it, and what it does when it
// runs. Every role and trait is a claim with evidence; nothing here asks a model.
import { BoundaryCall, byCodeUnit, CodeSymbol, ComponentKind, Placement, QualifiedName, Role, Run, Span, SymbolKind, ZoneRule, ZoneSource } from "@runshape/kernel";
import { ArchitectureSnapshot, buildPlacements } from "./placements";
import { profileFor } from "./profiles";
import { Claim, ClaimSource, Definition, Kind, Lens, matchingName, RoleDeclaration, ROLE_LENSES, STYLE_LENSES, Taxonomy } from "./taxonomy";
import { ZoneRules } from "./zones";

/** One piece of code, what it is, where it sits, and what's claimed about it. */
export interface CategorizedItem {
  /** A type's or module's dotted name; a callable's path (namespace, container, name); a field's holder and attribute. */
  name: string;
  kind: Kind;
  /** As the trace knows it: "class" or "type" (Go: the trace doesn't say struct or interface), "method", "closure", "field", … */
  subkind: string;
  /** CodeSymbol.key for a callable, so diffs pair it across runs (and renames); null otherwise. */
  key: string | null;
  /** The regions it's inside, outermost first, joined by "/"; "" at the top level. */
  region: string;
  /** The style of the innermost area it's in: the lenses its roles come from. */
  style: string;
  /** Its zone there: a rule's, or inferred from behaviour at the top level; null when nothing places it. */
  zone: string | null;
  tags: Claim[];
}

export interface Categorization {
  items: CategorizedItem[];
  /** What the trace can't support, so no tag will ever say it: the categorizer's honest limits. */
  missing: string[];
}

// How sure each kind of evidence makes a claim. Named so a reader can argue with each one.
const CONFIRMED = 1;
/** A model's role proposal written to runshape.json, not yet approved in a diff. */
const PROPOSED_IN_FILE = 0.8;
const DETECTED_IN_FILE = 0.7;
const ZONE_RULE_CONFIDENCE: Record<ZoneRule["by"], number> = { user: 0.9, llm: 0.8, detected: 0.7 };
/** Inferred zones follow what the tests did: a test that mocks the database moves them. */
const INFERRED_ZONE = 0.6;
const ROUTED = 0.85;
const CALLS_EXTERNAL_ITSELF = 0.8;
const NAMED_LIKE = 0.6;
const RECORDED_BOUNDARY_CALL = 0.95;
const EXECUTED_LINE = 0.85;
const UNEXECUTED_LINE = 0.6;
/** "pure" means no effect was recorded: in-memory reads, clocks and randomness never are. */
const NO_RECORDED_EFFECT = 0.4;
/** CQS rests on reading a return line's text: a heuristic, however often the line ran. */
const CQS_FROM_SOURCE = 0.7;
/** Each extra independent signal for the same role adds this, up to the cap. */
const EXTRA_SIGNAL = 0.1;
const DETECTED_CAP = 0.95;
/** Evidence lists past this are counted, not copied. */
const MAX_EVIDENCE = 4;

/** Claims from stronger sources win a lens whatever their confidence: a person beats a heuristic. */
const SOURCE_RANK: Record<ClaimSource, number> = { confirmed: 0, declared: 1, judged: 2, detected: 3 };
const RULE_BY_TO_SOURCE: Record<ZoneRule["by"], ClaimSource> = { user: "confirmed", llm: "judged", detected: "detected" };
const DECLARED_CONFIDENCE: Record<RoleDeclaration["by"], number> = { user: CONFIRMED, llm: PROPOSED_IN_FILE, detected: DETECTED_IN_FILE };

/** The role a zone implies, in the lens that zone's style uses. Layered zones are layers, not roles. */
const ZONE_ROLES: Record<string, [lens: Lens, role: string]> = {
  "inbound-adapter": [Lens.PortsAndAdapters, "primary-adapter"],
  "outbound-adapter": [Lens.PortsAndAdapters, "secondary-adapter"],
  controller: [Lens.MvcFamily, "controller"],
  view: [Lens.MvcFamily, "view"],
  viewmodel: [Lens.MvcFamily, "view-model"],
  presenter: [Lens.MvcFamily, "presenter"],
};
/** What code the framework routes requests to is, per lens. */
const ROUTED_ROLES: [lens: Lens, role: string][] = [
  [Lens.PortsAndAdapters, "primary-adapter"],
  [Lens.MvcFamily, "controller"],
];

const CALLABLE_SUBKINDS: Record<SymbolKind, string> = {
  [SymbolKind.Function]: "function",
  [SymbolKind.Method]: "method",
  [SymbolKind.Constructor]: "constructor",
  [SymbolKind.Initializer]: "initializer",
  [SymbolKind.Nested]: "closure",
};
const KIND_ORDER = [Kind.Container, Kind.Type, Kind.Callable, Kind.State, Kind.Metadata];

/** What the trace never records, whatever the recording: said once, so a missing tag isn't read as "no". */
const ALWAYS_MISSING = [
  "Types: a type appears only when one of its methods ran or an object of it was seen, and the trace doesn't say class, struct or interface; interfaces never run, so primary-port and secondary-port can only be judged by a model or declared.",
  "State: only object references set while constructing (an object's wires) are recorded; plain fields, constants and globals aren't, so state has no traits.",
  "Metadata: decorators, annotations and attributes aren't recorded, so none is categorized and none is used as evidence.",
  "Failure: exceptions aren't recorded per call; can-fail is read from raise, throw, panic or error-making lines in the source, and total is never claimed.",
  "Effect: clocks, randomness and in-memory reads aren't recorded, so pure means no recorded effect, not a proof.",
  "Intent (decision, orchestration) needs a model: it isn't detected.",
];
const NO_SOURCE = "This recording keeps no source: CQS (does it return a value?), field writes and can-fail aren't detected.";

/** What one function did across every recorded call of it. */
interface FunctionFacts {
  symbol: CodeSymbol;
  file: string | null;
  firstLine: number;
  /** Its calls, each once, in the order first met: each root's tree, depth first. */
  spans: Span[];
  /** Effects it had itself: effect id → "postgres: SELECT" → how many. */
  own: Map<string, Map<string, number>>;
  /** Functions that ran under it, by key. */
  below: Set<string>;
  executed: Set<number>;
}

const TRANSACTION_CONTROL = new Set(["SAVEPOINT", "RELEASE", "BEGIN", "COMMIT", "ROLLBACK", "START", "SET"]);
const WRITE_STATEMENT = /\b(INSERT|UPDATE|DELETE|MERGE|REPLACE|UPSERT|CREATE|DROP|ALTER|TRUNCATE)\b/i;

/** What a boundary call means for state; null for transaction bookkeeping, which no code asked for itself. */
function effectOf(call: BoundaryCall): { effect: string; label: string } | null {
  if (call.statement === null) return { effect: "external-io", label: `${call.system}: ${call.operation}` };
  const verb = call.statement.trim().split(/\s+/)[0]!.toUpperCase();
  if (TRANSACTION_CONTROL.has(verb)) return null;
  // The verb, never the statement: evidence may be stored centrally (docs/review-bundle.md).
  return { effect: WRITE_STATEMENT.test(call.statement) ? "writes-state" : "reads-state", label: `${call.system}: ${verb}` };
}

/** Per language: what a line that changes a field, returns a value, or fails looks like. */
interface SourceDialect {
  fieldWrite(firstLine: string): RegExp | null;
  /** Matched against the line with its strings and comment removed: "throw" in a message isn't a throw. */
  failure: RegExp;
  lineComment: string;
  /** Return values that aren't values: "return None", Go's "return nil, err". */
  noValue: RegExp;
}
const PYTHON: SourceDialect = {
  fieldWrite: () => /^\s*self\.([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*(?:[-+*/%|&^@]|\/\/|\*\*|<<|>>)?=(?!=)/,
  failure: /^\s*(raise)\b/,
  lineComment: "#",
  noValue: /^(None|self\.\w+)?$/,
};
const TYPESCRIPT: SourceDialect = {
  fieldWrite: () => /^\s*this\.([A-Za-z_$][\w$]*)(?:\[[^\]]*\])?\s*(?:(?:[-+*/%|&^]|\*\*|<<|>>|\?\?|\|\||&&)?=(?!=)|\+\+|--)/,
  // A statement, not a property or an identifier: "x.throw" and "throwIfMissing" aren't throws.
  failure: /(?:^|[;{}:)]|\belse)\s*(throw)\b/,
  lineComment: "//",
  noValue: /^(null|undefined)?$/,
};
const GO: SourceDialect = {
  // A method's receiver is named in its signature: "func (s *Service) Place(…)".
  fieldWrite: (signature) => {
    const receiver = /^\s*func\s*\(\s*([A-Za-z_]\w*)\s+\*?[\w.[\]]+\s*\)/.exec(signature)?.[1];
    return receiver === undefined ? null : new RegExp(`^\\s*(?:${receiver}\\.([A-Za-z_]\\w*)(?:\\[[^\\]]*\\])?\\s*(?:(?:[-+*/%|^]|&\\^?|<<|>>)?=(?!=)|\\+\\+|--)|delete\\(\\s*${receiver}\\.([A-Za-z_]\\w*))`);
  },
  failure: /\b(panic|errors\.New|fmt\.Errorf)\(/,
  lineComment: "//",
  noValue: /^(nil|err|errors\.New\(.*|fmt\.Errorf\(.*)?$/,
};
const DIALECTS: Record<string, SourceDialect> = { python: PYTHON, typescript: TYPESCRIPT, javascript: TYPESCRIPT, go: GO };

/** One line's code only: string literals emptied, the line comment cut. A line, not a parser: a string spanning lines isn't seen. */
export function codeOnly(text: string, lineComment: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote !== null) {
      if (char === "\\") i += 1;
      else if (char === quote) {
        out += char;
        quote = null;
      }
      continue;
    }
    if (text.startsWith(lineComment, i)) break;
    if (char === '"' || char === "'" || char === "`") quote = char;
    out += char;
  }
  return out;
}

/** The keyword that makes this line fail ("raise", "throw", "panic", …), or null; for the tests and SourceReading. */
export function failureOn(language: string, line: string): string | null {
  const dialect = DIALECTS[language];
  return dialect === undefined ? null : (dialect.failure.exec(codeOnly(line, dialect.lineComment))?.[1] ?? null);
}

/** "a, f(b, c)" → ["a", "f(b, c)"]: commas at the top level only. */
function topLevelParts(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of expression) {
    if ("([{".includes(char)) depth += 1;
    if (")]}".includes(char)) depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  parts.push(current.trim());
  return parts;
}

/** Categorizes every piece of code the recording knows, with the rules' zones and taxonomy. */
export function categorize(run: Run, rules: ZoneRules, placed: ArchitectureSnapshot = buildPlacements(run, rules)): Categorization {
  const taxonomy = rules.taxonomy;
  const placements = new Map(placed.placements.map((placement) => [`${placement.kind} ${placement.component}`, placement]));
  const facts = functionFacts(run);
  // Indexed once: asked per type, a scan of every function made categorizing quadratic.
  const methodsOf = new Map<string, FunctionFacts[]>();
  for (const fact of facts.values()) methodsOf.set(fact.symbol.owner.key, [...(methodsOf.get(fact.symbol.owner.key) ?? []), fact]);
  const boundaryLabels = ownBoundaryLabels(facts);
  const routes = routedHandlers(run);
  const dialect = DIALECTS[run.language] ?? null;
  const source = new SourceReading(run, dialect);
  const where = (name: QualifiedName, kind: ComponentKind.Class | ComponentKind.Module) => placementOf(name, rules, placements.get(`${kind} ${name.text}`) ?? null);

  const items: CategorizedItem[] = [];
  const transitive = transitiveEffects(facts, source);
  for (const fact of facts.values()) {
    if (fact.spans.every((span) => span.fn.role !== Role.Source)) continue;
    // A base class's method that only ran on subclasses is drawn in the receiver's box (componentOf): placed there too.
    const definedIn = fact.symbol.ownerType === null ? null : fact.symbol.owner;
    const owner = definedIn !== null && !placements.has(`${ComponentKind.Class} ${definedIn.text}`) ? (fact.spans.find((span) => span.obj !== null)?.obj?.type ?? definedIn) : fact.symbol.owner;
    const at = where(owner, fact.symbol.ownerType === null ? ComponentKind.Module : ComponentKind.Class);
    const lenses = STYLE_LENSES[at.place.style] ?? [];
    const tags: Claim[] = [...callableTraits(fact, transitive, source)];
    const roles: Claim[] = [];
    const routed = routes.get(fact.symbol.path.key);
    if (routed !== undefined) roles.push(...routedClaims(routed, lenses));
    roles.push(...namedClaims(taxonomy, Kind.Callable, lenses, fact.symbol.name), ...declaredClaims(taxonomy, Kind.Callable, fact.symbol.path));
    const item = { name: fact.symbol.path.text, kind: Kind.Callable, subkind: CALLABLE_SUBKINDS[fact.symbol.kind], key: fact.symbol.key, ...at.place, tags: [...resolveRoles(roles), ...tags] };
    items.push(item);
  }

  const wires = wiresByTarget(run);
  for (const placement of placements.values()) {
    const name = QualifiedName.parse(placement.component);
    const at = where(name, placement.kind);
    const lenses = STYLE_LENSES[at.place.style] ?? [];
    if (placement.kind === ComponentKind.Module) {
      const rule = rules.matchFor(name)?.rule;
      const tags =
        rule?.role === "composition-root"
          ? [{ id: "composition-root", lens: Lens.Container, by: RULE_BY_TO_SOURCE[rule.by], confidence: ZONE_RULE_CONFIDENCE[rule.by], evidence: [`rule ${rule.match}: ${rule.reason}`] }]
          : [];
      items.push({ name: placement.component, kind: Kind.Container, subkind: run.language === "go" ? "package" : "module", key: null, ...at.place, tags });
      continue;
    }
    const methods = methodsOf.get(name.key) ?? [];
    const roles: Claim[] = [];
    const zoneRole = at.place.zone === null ? undefined : ZONE_ROLES[at.place.zone];
    if (zoneRole !== undefined && lenses.includes(zoneRole[0])) roles.push(claim(zoneRole[1], zoneRole[0], at.confidence, [at.evidence]));
    // Django's class-based views register the class itself; Go's mux registers a method.
    const routedHere = [...(routes.get(name.key) ?? []), ...methods.flatMap((method) => routes.get(method.symbol.path.key) ?? [])];
    if (routedHere.length > 0) roles.push(...routedClaims(routedHere, lenses));
    const itself = boundaryLabels.get(name.key) ?? [];
    if (itself.length > 0 && lenses.includes(Lens.PortsAndAdapters)) roles.push(claim("secondary-adapter", Lens.PortsAndAdapters, CALLS_EXTERNAL_ITSELF, [`calls ${listed(itself)} itself`]));
    const handedTo = wires.get(name.key) ?? [];
    if (handedTo.length > 0 && roles.some((role) => role.id === "secondary-adapter")) roles.push(claim("secondary-adapter", Lens.PortsAndAdapters, NAMED_LIKE, [`handed to ${listed(handedTo)}`]));
    roles.push(...namedClaims(taxonomy, Kind.Type, lenses, name.last), ...declaredClaims(taxonomy, Kind.Type, name));
    items.push({ name: placement.component, kind: Kind.Type, subkind: run.language === "go" ? "type" : "class", key: null, ...at.place, tags: resolveRoles(roles) });
  }

  for (const field of fields(run)) {
    const at = where(field.holder, ComponentKind.Class);
    items.push({ name: new QualifiedName([...field.holder.segments, field.attribute]).text, kind: Kind.State, subkind: "field", key: null, ...at.place, tags: [] });
  }

  items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || byCodeUnit(a.name, b.name));
  return { items, missing: run.sources === null ? [...ALWAYS_MISSING, NO_SOURCE] : ALWAYS_MISSING };
}

function claim(id: string, lens: string, confidence: number, evidence: string[], by: ClaimSource = "detected"): Claim {
  return { id, lens, by, confidence, evidence };
}

/** "a, b, c and 2 more". */
function listed(items: string[]): string {
  const shown = items.slice(0, MAX_EVIDENCE);
  return `${shown.join(", ")}${items.length > shown.length ? ` and ${items.length - shown.length} more` : ""}`;
}

interface Whereabouts {
  place: Pick<CategorizedItem, "region" | "style" | "zone">;
  /** How sure the zone is, and why: what a role read off the zone rests on. */
  confidence: number;
  evidence: string;
}

/** Where a name sits: the innermost region's style and the zone a rule (or, at the top level, inference) gives it. */
function placementOf(name: QualifiedName, rules: ZoneRules, top: Placement | null): Whereabouts {
  const levels = rules.placementsOf(name);
  const inner = levels[levels.length - 1]!;
  const region = levels.slice(1).map((level) => level.region).join("/");
  if (levels.length === 1) {
    if (top === null) return { place: { region, style: inner.style, zone: inner.zone }, confidence: INFERRED_ZONE, evidence: "" };
    const evidence =
      top.source === ZoneSource.Rule ? `placed in ${top.zone} by rule ${top.rule} (${top.decidedBy})` : `inferred ${top.zone}: ${top.reason}`;
    const confidence = top.source === ZoneSource.Rule && top.decidedBy !== null ? ZONE_RULE_CONFIDENCE[top.decidedBy] : INFERRED_ZONE;
    return { place: { region, style: inner.style, zone: top.zone }, confidence, evidence };
  }
  // Inside a region only its rules place code: the graph that infers zones is the top level's.
  let area = rules;
  for (const level of levels.slice(1)) area = area.regions.find((candidate) => candidate.name === level.region)!.rules;
  const rule = area.matchFor(name)?.rule ?? null;
  return {
    place: { region, style: inner.style, zone: inner.zone },
    confidence: rule === null ? INFERRED_ZONE : ZONE_RULE_CONFIDENCE[rule.by],
    evidence: rule === null ? "" : `placed in ${rule.zone} by the ${inner.region} region's rule ${rule.match} (${rule.by})`,
  };
}

/** One walk of each scenario's trees, from its roots: each call counted once. */
function functionFacts(run: Run): Map<string, FunctionFacts> {
  const facts = new Map<string, FunctionFacts>();
  const visit = (span: Span): Set<string> => {
    const key = span.fn.symbol.key;
    let fact = facts.get(key);
    if (fact === undefined) {
      fact = { symbol: span.fn.symbol, file: span.fn.file, firstLine: span.fn.firstLine, spans: [], own: new Map(), below: new Set(), executed: new Set() };
      facts.set(key, fact);
    }
    fact.spans.push(span);
    for (const line of span.lines) fact.executed.add(line);
    for (const call of span.boundaryCalls) {
      const effect = effectOf(call);
      if (effect === null) continue;
      const labels = fact.own.get(effect.effect) ?? new Map<string, number>();
      labels.set(effect.label, (labels.get(effect.label) ?? 0) + 1);
      fact.own.set(effect.effect, labels);
    }
    const below = new Set<string>();
    for (const child of span.children) {
      below.add(child.fn.symbol.key);
      for (const key of visit(child)) below.add(key);
    }
    for (const key of below) if (key !== span.fn.symbol.key) fact.below.add(key);
    return below;
  };
  for (const scenario of run.scenarios) {
    for (const span of scenario.spans) if (span.parent === null) visit(span);
  }
  return facts;
}

/** Reads a function's own lines from the source the recording kept. */
class SourceReading {
  /** Per file, each catalogued function's lines: a function's own lines exclude the ones nested in it. */
  private readonly ranges = new Map<string, [first: number, last: number][]>();

  constructor(
    private readonly run: Run,
    private readonly dialect: SourceDialect | null,
  ) {
    for (const fn of run.catalog) {
      const list = this.ranges.get(fn.file) ?? [];
      list.push([fn.firstLine, fn.lastLine]);
      this.ranges.set(fn.file, list);
    }
  }

  get available(): boolean {
    return this.run.sources !== null && this.dialect !== null;
  }

  /** Its own lines and their text, nested functions' lines left out; empty without source. */
  private ownLines(fact: FunctionFacts): { line: number; text: string }[] {
    if (!this.available || fact.file === null) return [];
    const catalogued = this.run.catalogFunction(fact.symbol.key);
    const [first, last] = catalogued === undefined ? [fact.firstLine, fact.firstLine] : [catalogued.firstLine, catalogued.lastLine];
    const nested = (this.ranges.get(fact.file) ?? []).filter(([a, b]) => a >= first && b <= last && (a !== first || b !== last));
    const lines: { line: number; text: string }[] = [];
    for (let line = first; line <= last; line += 1) {
      if (nested.some(([a, b]) => line >= a && line <= b)) continue;
      const text = this.run.sourceLine(fact.file, line);
      if (text !== null) lines.push({ line, text });
    }
    return lines;
  }

  /** Fields an executed line assigns, outside constructors (building an object isn't changing state). */
  fieldWrites(fact: FunctionFacts): string[] {
    const known = this.writes.get(fact.symbol.key);
    if (known !== undefined) return known;
    const found = this.findFieldWrites(fact);
    this.writes.set(fact.symbol.key, found);
    return found;
  }

  /** Asked once per function for itself and once for every caller above it: read once. */
  private readonly writes = new Map<string, string[]>();

  private findFieldWrites(fact: FunctionFacts): string[] {
    if (fact.symbol.kind === SymbolKind.Constructor) return [];
    const lines = this.ownLines(fact);
    const pattern = this.dialect?.fieldWrite(lines[0]?.text ?? "") ?? null;
    if (pattern === null) return [];
    return lines.filter(({ line }) => fact.executed.has(line)).flatMap(({ line, text }) => {
      const match = pattern.exec(text);
      const field = match?.slice(1).find((group) => group !== undefined);
      return field === undefined ? [] : [`writes field ${field} (line ${line})`];
    });
  }

  /** The first executed return that hands back a value, as evidence; null if none ran. */
  returnedValue(fact: FunctionFacts): string | null {
    if (fact.symbol.kind === SymbolKind.Constructor) return null;
    for (const { line, text } of this.ownLines(fact)) {
      if (!fact.executed.has(line)) continue;
      const expression = /^\s*return\b\s*(.*?)\s*;?\s*$/.exec(text)?.[1];
      if (expression === undefined) continue;
      if (topLevelParts(expression).some((part) => !this.dialect!.noValue.test(part))) return `returns a value (line ${line})`;
    }
    return null;
  }

  /** Lines that raise, throw, panic or make an error, and whether the tests ran them. */
  failures(fact: FunctionFacts): { evidence: string; ran: boolean }[] {
    return this.ownLines(fact).flatMap(({ line, text }) => {
      const keyword = this.dialect!.failure.exec(codeOnly(text, this.dialect!.lineComment))?.[1];
      if (keyword === undefined) return [];
      const ran = fact.executed.has(line);
      return [{ evidence: `${keyword} at line ${line}${ran ? ", ran in the tests" : ", not run by the tests"}`, ran }];
    });
  }
}

/** Each effect a function had through what it called: effect id → evidence naming who did it. */
function transitiveEffects(facts: Map<string, FunctionFacts>, source: SourceReading): Map<string, Map<string, string[]>> {
  const ownWrites = new Map([...facts].map(([key, fact]) => [key, source.fieldWrites(fact)]));
  const result = new Map<string, Map<string, string[]>>();
  for (const [key, fact] of facts) {
    const through = new Map<string, string[]>();
    for (const belowKey of [...fact.below].sort(byCodeUnit)) {
      const below = facts.get(belowKey);
      if (below === undefined) continue;
      const name = below.symbol.path.text;
      for (const [effect, labels] of below.own) {
        const list = through.get(effect) ?? [];
        list.push(`${[...labels.keys()].join(", ")} through ${name}`);
        through.set(effect, list);
      }
      if ((ownWrites.get(belowKey) ?? []).length > 0) {
        const list = through.get("writes-state") ?? [];
        list.push(`${FIELD_WRITE_THROUGH} ${name}`);
        through.set("writes-state", list);
      }
    }
    result.set(key, through);
  }
  return result;
}

const EFFECTS = ["reads-state", "writes-state", "external-io"];
/** How evidence names a callee's in-memory field write; CQS leaves these out. */
const FIELD_WRITE_THROUGH = "writes a field through";

function callableTraits(fact: FunctionFacts, transitive: Map<string, Map<string, string[]>>, source: SourceReading): Claim[] {
  const tags: Claim[] = [];
  const through = transitive.get(fact.symbol.key) ?? new Map<string, string[]>();
  const fieldWrites = source.fieldWrites(fact);
  const calls = fact.spans.length;
  for (const effect of EFFECTS) {
    const own = [...(fact.own.get(effect) ?? new Map<string, number>())].map(([label, count]) => `${label} ×${count} itself`);
    const fields = effect === "writes-state" ? fieldWrites : [];
    const below = through.get(effect) ?? [];
    const evidence = [...own, ...fields, ...below];
    if (evidence.length === 0) continue;
    const confidence = own.length > 0 || below.some((line) => !line.startsWith(FIELD_WRITE_THROUGH)) ? RECORDED_BOUNDARY_CALL : EXECUTED_LINE;
    tags.push(claim(effect, Lens.Effect, confidence, cap(evidence)));
  }
  // What CQS counts as a write: its own (a field, a boundary call) and stored state changed
  // below it. A callee's in-memory field isn't: a memoizing getter (QualifiedName.text) would
  // make every caller that returns a value "both" (second-model review).
  const cqsWrites = [
    ...[...(fact.own.get("writes-state") ?? new Map<string, number>())].map(([label, count]) => `${label} ×${count} itself`),
    ...fieldWrites,
    ...(through.get("writes-state") ?? []).filter((line) => !line.startsWith(FIELD_WRITE_THROUGH)),
  ];
  const memoryBelowOnly = cqsWrites.length === 0 && tags.some((tag) => tag.id === "writes-state");
  if (tags.length === 0) {
    const unseen = source.available ? "" : "; this recording keeps no source, so field writes aren't seen";
    tags.push(claim("pure", Lens.Effect, NO_RECORDED_EFFECT, [`no boundary call or field write in ${calls} recorded call${calls === 1 ? "" : "s"}${unseen}`]));
  }
  if (fact.own.size > 0) {
    const labels = [...fact.own.values()].flatMap((byLabel) => [...byLabel.keys()]);
    tags.push(claim("direct-io", Lens.Io, RECORDED_BOUNDARY_CALL, cap(labels)));
  }
  if (source.available) {
    const returns = source.returnedValue(fact);
    const write = cqsWrites[0];
    const noWrite = memoryBelowOnly ? "no write of its own or to stored state (callees' in-memory fields don't count)" : "no recorded write";
    if (returns !== null && write !== undefined) tags.push(claim("both", Lens.Cqs, CQS_FROM_SOURCE, [returns, write]));
    else if (write !== undefined) tags.push(claim("command", Lens.Cqs, CQS_FROM_SOURCE, ["no executed return with a value: the return lines that ran hand back nothing", write]));
    else if (returns !== null) tags.push(claim("query", Lens.Cqs, CQS_FROM_SOURCE, [returns, noWrite]));
    const failures = source.failures(fact);
    if (failures.length > 0) tags.push(claim("can-fail", Lens.Failure, failures.some((failure) => failure.ran) ? EXECUTED_LINE : UNEXECUTED_LINE, cap(failures.map((failure) => failure.evidence))));
  }
  return tags;
}

function cap(evidence: string[]): string[] {
  return evidence.length <= MAX_EVIDENCE ? evidence : [...evidence.slice(0, MAX_EVIDENCE), `and ${evidence.length - MAX_EVIDENCE} more`];
}

/** Route handlers by their path's key: "POST /orders" for each route registered to them. */
function routedHandlers(run: Run): Map<string, string[]> {
  const routes = new Map<string, string[]>();
  for (const route of run.topology?.routes ?? []) {
    const list = routes.get(route.handler.key) ?? [];
    list.push(`${route.methods.join(",")} ${route.path}`.trim());
    routes.set(route.handler.key, list);
  }
  return routes;
}

function routedClaims(routes: string[], lenses: readonly string[]): Claim[] {
  return ROUTED_ROLES.filter(([lens]) => lenses.includes(lens)).map(([lens, role]) => claim(role, lens, ROUTED, [`the framework routes ${listed([...new Set(routes)])} to it`]));
}

function namedClaims(taxonomy: Taxonomy, kind: Kind, lenses: readonly string[], name: string): Claim[] {
  return taxonomy.definitionsFor(kind, lenses).flatMap((definition: Definition) => {
    const pattern = matchingName(definition, name);
    return pattern === null ? [] : [claim(definition.id, definition.lens, NAMED_LIKE, [`its name matches ${pattern}`])];
  });
}

/** Roles runshape.json writes down for this name; any lens, since a person may cross the style on purpose. */
function declaredClaims(taxonomy: Taxonomy, kind: Kind, name: QualifiedName): Claim[] {
  return taxonomy.declaredFor(name.segments).flatMap((declaration) => {
    const definition = taxonomy.definitions.find((candidate) => candidate.id === declaration.role && ROLE_LENSES.includes(candidate.lens) && (declaration.lens === undefined || candidate.lens === declaration.lens));
    if (definition === undefined || !definition.on.includes(kind)) return [];
    const by = RULE_BY_TO_SOURCE[declaration.by];
    return [claim(definition.id, definition.lens, DECLARED_CONFIDENCE[declaration.by], [`runshape.json (${declaration.by}): ${declaration.reason}`], by)];
  });
}

/**
 * One role per lens (docs/taxonomy.md, open question 1: start strict). The same role from
 * several signals is one claim with all the evidence; a different role that lost is named in
 * the winner's evidence, so the reviewer sees it was close.
 */
function resolveRoles(claims: Claim[]): Claim[] {
  const byLens = new Map<string, Claim[]>();
  for (const one of claims) byLens.set(one.lens, [...(byLens.get(one.lens) ?? []), one]);
  const resolved: Claim[] = [];
  for (const lensClaims of byLens.values()) {
    const merged = new Map<string, Claim>();
    for (const one of [...lensClaims].sort((a, b) => SOURCE_RANK[a.by] - SOURCE_RANK[b.by] || b.confidence - a.confidence)) {
      const held = merged.get(one.id);
      if (held === undefined) merged.set(one.id, { ...one, evidence: [...one.evidence] });
      else {
        held.evidence.push(...one.evidence);
        if (held.by === "detected" && one.by === "detected") held.confidence = Math.min(DETECTED_CAP, Number((held.confidence + EXTRA_SIGNAL).toFixed(2)));
      }
    }
    const [winner, ...others] = [...merged.values()].sort((a, b) => SOURCE_RANK[a.by] - SOURCE_RANK[b.by] || b.confidence - a.confidence);
    for (const other of others) winner!.evidence.push(`also looked like ${other.id} (${other.confidence}): ${other.evidence[0]}`);
    resolved.push(winner!);
  }
  return resolved;
}

/** By type key, the boundary calls its own code made (its methods, or code that ran on its objects); one pass. */
function ownBoundaryLabels(facts: Map<string, FunctionFacts>): Map<string, string[]> {
  const byType = new Map<string, Set<string>>();
  for (const fact of facts.values()) {
    for (const span of fact.spans) {
      if (span.boundaryCalls.length === 0 || span.fn.role !== Role.Source) continue;
      const on = span.obj?.type ?? (span.fn.symbol.ownerType === null ? null : span.fn.symbol.owner);
      if (on === null) continue;
      for (const call of span.boundaryCalls) {
        const effect = effectOf(call);
        if (effect === null) continue;
        const labels = byType.get(on.key) ?? new Set<string>();
        labels.add(effect.label);
        byType.set(on.key, labels);
      }
    }
  }
  return new Map([...byType].map(([key, labels]) => [key, [...labels].sort(byCodeUnit)]));
}


/** Who holds a reference to each type: "ArticlesRepository as _profiles_repo". */
function wiresByTarget(run: Run): Map<string, string[]> {
  const holders = new Map<string, Set<string>>();
  for (const scenario of run.scenarios) {
    for (const object of scenario.objects) {
      for (const wire of object.wires) {
        const set = holders.get(wire.target.type.key) ?? new Set<string>();
        set.add(`${object.type.last} as ${wire.attribute}`);
        holders.set(wire.target.type.key, set);
      }
    }
  }
  return new Map([...holders].map(([key, set]) => [key, [...set].sort(byCodeUnit)]));
}

/** The fields the trace records: object references set while an object was built. */
function fields(run: Run): { holder: QualifiedName; attribute: string }[] {
  const seen = new Map<string, { holder: QualifiedName; attribute: string }>();
  for (const scenario of run.scenarios) {
    for (const object of scenario.objects) {
      for (const wire of object.wires) seen.set(JSON.stringify([object.type.key, wire.attribute]), { holder: object.type, attribute: wire.attribute });
    }
  }
  return [...seen.values()];
}

/** The style's zones a role's expected_in names; empty when the definition doesn't speak to this style. */
export function expectedZonesIn(definition: Definition, style: string): string[] {
  const zones = profileFor(style)?.zones.map((zone) => zone.id) ?? [];
  return definition.expected_in.filter((zone) => zones.includes(zone));
}
