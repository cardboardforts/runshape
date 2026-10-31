// The categorizer's vocabulary (docs/categorizer.md): what code is (kind, a parser fact), the
// job it does in a style (roles, by lens) and what it does when it runs (traits). Roles and
// traits are claims with a source and evidence. The definitions and the rules that read them
// are data: built in here, and overridden by id in runshape.json's "taxonomy" section.
import { ArchitectureStyle } from "@runshape/kernel";
import { Glob, segmentMatches } from "./glob";
import { PROFILES } from "./profiles";

/** What syntactic thing an item is. The parser decides, never a model. */
export enum Kind {
  Container = "container",
  Type = "type",
  Callable = "callable",
  State = "state",
  Metadata = "metadata",
}

/**
 * Where a claim came from. `declared`: the code says so itself (an annotation; nothing records
 * them yet). `detected`: the deterministic categorizer. `judged`: a model, or a model's proposal
 * committed to runshape.json and not yet approved. `confirmed`: a person said so.
 */
export type ClaimSource = "declared" | "detected" | "judged" | "confirmed";

/** A role or trait, with how sure and why. `lens` names the family; one role per lens. */
export interface Claim {
  id: string;
  lens: string;
  by: ClaimSource;
  /** 0..1. */
  confidence: number;
  /** Names, zones, line numbers and counts: never source text or query text. */
  evidence: string[];
}

/** Role families (one style uses several) and trait axes: a lens is also a rule's condition axis. */
export enum Lens {
  PortsAndAdapters = "ports-and-adapters",
  TacticalDdd = "tactical-ddd",
  Cqrs = "cqrs",
  Application = "application",
  Boundary = "boundary",
  MvcFamily = "mvc-family",
  Container = "container",
  Effect = "effect",
  /** Does the callable make a boundary call itself, not through a callee? */
  Io = "io",
  Cqs = "cqs",
  Failure = "failure",
  Intent = "intent",
}

/** Lenses whose ids are roles (what a thing is for); the rest are traits (what it does). */
export const ROLE_LENSES: readonly string[] = [Lens.PortsAndAdapters, Lens.TacticalDdd, Lens.Cqrs, Lens.Application, Lens.Boundary, Lens.MvcFamily, Lens.Container];

const KNOWN_LENSES: readonly string[] = Object.values(Lens);
/** The kinds the categorizer reads declared roles for (categorizer.ts, declaredClaims). */
const DECLARABLE_KINDS: readonly string[] = ["type", "callable"];

/** The role lenses a region's style tags its code with. Layered has none: its layers are zones. */
export const STYLE_LENSES: Record<string, string[]> = {
  [ArchitectureStyle.Hexagonal]: [Lens.PortsAndAdapters, Lens.TacticalDdd, Lens.Cqrs, Lens.Application, Lens.Boundary],
  [ArchitectureStyle.Layered]: [Lens.TacticalDdd, Lens.Cqrs, Lens.Application, Lens.Boundary],
  [ArchitectureStyle.Mvc]: [Lens.MvcFamily, Lens.Boundary],
  [ArchitectureStyle.Mvvm]: [Lens.MvcFamily, Lens.Boundary],
  [ArchitectureStyle.Mvp]: [Lens.MvcFamily, Lens.Boundary],
};

/**
 * One role or trait: the prose a model reads (`definition`, `look_alikes`) and the parts the
 * detector and the rules read (`names`, `expected_in`).
 */
export interface Definition {
  id: string;
  lens: string;
  /** The kinds that can carry it. */
  on: Kind[];
  definition: string;
  /** Cheap hints, in words: what the detector or a model looks for. */
  signals: string[];
  /** What it's confused with, and how to tell them apart. */
  look_alikes: string[];
  /** Zone ids (of any style) it belongs in; empty: anywhere. The rules read this. */
  expected_in: string[];
  /** Globs over the item's own name ("*Repository"): the one signal the detector takes from data. */
  names: string[];
}

export type Severity = "error" | "warn" | "info" | "off";
const SEVERITIES: Severity[] = ["error", "warn", "info", "off"];

/**
 * A check over tags. It applies where the item's style is in `styles` (its default ruleset),
 * or, when `match` is set, wherever the glob matches, whatever the style: that's how a project
 * says "this container uses CQRS". `off_in` names regions it doesn't apply in.
 */
export interface TagRule {
  id: string;
  /** What it means when it fires: the finding's text. */
  message: string;
  styles: string[];
  match: string | null;
  /** "axis=value|value" or "axis!=value": all must hold for the rule to look at an item. */
  when: string[];
  /** All must hold for a finding. */
  flag: string[];
  /** Any one holding relaxes the rule for that item. */
  unless: string[];
  severity: Severity;
  off_in: string[];
}

/** A role a person (or a model, for approval) wrote down in runshape.json for matching code. */
export interface RoleDeclaration {
  match: string;
  role: string;
  /** Which lens the role is from; needed only when two lenses share the id. */
  lens?: string;
  reason: string;
  by: "user" | "llm" | "detected";
}

/** runshape.json's "taxonomy" section, as written. Every part is optional. */
export interface TaxonomyFile {
  definitions?: (Partial<Definition> & { id: string })[];
  roles?: RoleDeclaration[];
  rules?: (Partial<TagRule> & { id: string })[];
}

/** Axes a condition may name besides the lenses. */
export enum Axis {
  Kind = "kind",
  Style = "style",
  Zone = "zone",
  /** Any role, from any role lens. */
  Role = "role",
  /** "no" when a role's expected_in speaks to the item's style and its zone isn't among them. */
  ZoneExpected = "zone-expected",
  /** "yes" when the item's zone is one its style lets talk to external systems. */
  ZoneIo = "zone-io",
}
const YES_NO = ["yes", "no"];

const ALL_STYLES = PROFILES.map((profile) => profile.style);
const ALL_ZONES = [...new Set(PROFILES.flatMap((profile) => profile.zones.map((zone) => zone.id)))];

const role = (id: string, lens: Lens, on: Kind[], definition: string, more: Partial<Definition> = {}): Definition => ({
  id,
  lens,
  on,
  definition,
  signals: [],
  look_alikes: [],
  expected_in: [],
  names: [],
  ...more,
});
const TYPE = [Kind.Type];
const CALLABLE = [Kind.Callable];
const CORE_ZONES = ["core", "business", "model"];

/** The built-in vocabulary, from docs/taxonomy.md. A project overrides an entry by id. */
export const BUILT_IN_DEFINITIONS: readonly Definition[] = [
  role("primary-port", Lens.PortsAndAdapters, TYPE, "What the outside may ask of the core: a use-case interface.", {
    signals: ["an interface the inbound adapters call", "implemented by a use case in the core"],
    look_alikes: ["use-case: the implementation; the port is the interface it implements"],
    expected_in: ["core"],
  }),
  role("secondary-port", Lens.PortsAndAdapters, TYPE, "What the core needs from the outside: a store, a clock, a model.", {
    signals: ["an interface the core calls and an outbound adapter implements"],
    look_alikes: ["repository: the core's collection-like port is both"],
    expected_in: ["core"],
  }),
  role("primary-adapter", Lens.PortsAndAdapters, [Kind.Type, Kind.Callable], "Turns an external request into a call on the core.", {
    signals: ["the framework routes requests to it", "placed in the inbound-adapter zone"],
    look_alikes: ["secondary-adapter: that one is called by the core; this one calls the core"],
    expected_in: ["inbound-adapter"],
  }),
  role("secondary-adapter", Lens.PortsAndAdapters, TYPE, "Implements a secondary port against a real system (database, HTTP API, filesystem, queue, model provider). It knows the vendor's types and hides them from the core.", {
    signals: ["calls a database, HTTP or filesystem client itself", "handed to another component at construction", "placed in the outbound-adapter zone"],
    look_alikes: ["repository: the interface is core, only the implementation is this", "primary-adapter: this one is called by the core, it does not call the core"],
    expected_in: ["outbound-adapter"],
  }),
  role("aggregate-root", Lens.TacticalDdd, TYPE, "The one entity outsiders may hold a reference to. Guards the invariants of everything inside it.", { expected_in: CORE_ZONES }),
  role("entity", Lens.TacticalDdd, TYPE, "Has an identity that outlives its attribute values.", { look_alikes: ["dto: a persistence or wire shape with an id field is not an entity"], expected_in: CORE_ZONES }),
  role("value-object", Lens.TacticalDdd, TYPE, "Defined only by its values. Immutable, replaceable.", { expected_in: CORE_ZONES }),
  role("domain-service", Lens.TacticalDdd, TYPE, "A domain operation that belongs to no single entity or value object.", {
    look_alikes: ["use-case: sequences a request end to end; a domain service decides one domain rule", "policy: a swappable rule object"],
    expected_in: CORE_ZONES,
  }),
  role("factory", Lens.TacticalDdd, TYPE, "Builds complex objects, aggregates especially, and hands back valid ones.", { names: ["*Factory"], expected_in: CORE_ZONES }),
  role("repository", Lens.TacticalDdd, TYPE, "Collection-like access to aggregates. The interface is core; an implementation is an adapter.", {
    signals: ["its name ends in Repository", "reads and writes one kind of record"],
    look_alikes: ["secondary-adapter: an implementation against a real database is both"],
    names: ["*Repository", "*Repo"],
    expected_in: ["core", "outbound-adapter", "business", "data", "model"],
  }),
  role("domain-event", Lens.TacticalDdd, TYPE, "Something that happened, named in the past tense.", { names: ["*Event"], expected_in: CORE_ZONES }),
  role("policy", Lens.TacticalDdd, TYPE, "A swappable rule object.", { names: ["*Policy"], expected_in: CORE_ZONES }),
  role("command", Lens.Cqrs, TYPE, "A request to change state. A value, not a behaviour.", { names: ["*Command"], expected_in: CORE_ZONES }),
  role("command-handler", Lens.Cqrs, [Kind.Type, Kind.Callable], "Executes one command; may return the new id.", { names: ["*CommandHandler"], expected_in: CORE_ZONES }),
  role("query-model", Lens.Cqrs, TYPE, "A read-optimised projection that never takes writes.", { names: ["*ReadModel", "*Projection"] }),
  role("use-case", Lens.Application, TYPE, "An application service: runs one request end to end through the domain and the ports.", {
    look_alikes: ["domain-service: decides; a use case sequences", "orchestrator: sequences calls without deciding anything"],
    names: ["*UseCase", "*Interactor"],
    expected_in: CORE_ZONES,
  }),
  role("orchestrator", Lens.Application, TYPE, "Sequences calls across services and ports without deciding anything.", { names: ["*Orchestrator", "*Coordinator"], expected_in: CORE_ZONES }),
  role("dto", Lens.Boundary, TYPE, "A wire or persistence shape: data that crosses a boundary, bent to the format, not the domain.", {
    signals: ["its name says request, response, schema or DTO", "no behaviour of its own"],
    look_alikes: ["entity: has identity and behaviour in the domain", "value-object: a domain concept, not a wire shape"],
    names: ["*DTO", "*Dto", "*Schema", "*Request", "*Response", "*Payload", "*InCreate", "*InUpdate", "*InResponse"],
  }),
  role("mapper", Lens.Boundary, TYPE, "Converts between a DTO and a domain type.", { look_alikes: ["dto: the shape itself"], names: ["*Mapper", "*Serializer", "*Converter", "*Translator"] }),
  role("config", Lens.Boundary, TYPE, "Typed settings read once at startup.", { names: ["*Settings", "*Config", "*Configuration", "*Options"] }),
  role("controller", Lens.MvcFamily, [Kind.Type, Kind.Callable], "Receives the request, picks the model and the view.", {
    signals: ["the framework routes requests to it", "placed in the controller zone"],
    names: ["*Controller", "*APIView", "*ViewSet"],
    expected_in: ["controller", "presentation", "inbound-adapter"],
  }),
  role("view", Lens.MvcFamily, TYPE, "Renders the response.", { expected_in: ["view", "presentation"] }),
  role("view-model", Lens.MvcFamily, TYPE, "State and commands for one view.", { names: ["*ViewModel"], expected_in: ["viewmodel"] }),
  role("presenter", Lens.MvcFamily, TYPE, "Decides what the view shows.", { names: ["*Presenter"], expected_in: ["presenter"] }),
  role("composition-root", Lens.Container, [Kind.Container], "Builds the adapters and hands them in: its calls wire, they don't break the style.", { signals: ['a runshape.json rule with "role": "composition-root"'] }),

  role("pure", Lens.Effect, CALLABLE, "No recorded effect: no boundary call, no write to a field, itself or through anything it calls.", {
    signals: ["no boundary call in any recorded call", "no executed line assigns a field"],
    look_alikes: ["reads-state: in-memory reads aren't recorded, so a pure claim is never proof"],
  }),
  role("reads-state", Lens.Effect, CALLABLE, "Reads stored state: a database query, itself or through a callee.", { signals: ["a recorded SELECT"] }),
  role("writes-state", Lens.Effect, CALLABLE, "Changes stored or in-memory state: a database write, or an executed line assigning a field outside a constructor.", {
    signals: ["a recorded INSERT, UPDATE or DELETE", "an executed line assigning self.x, this.x or a Go receiver's field"],
  }),
  role("external-io", Lens.Effect, CALLABLE, "Talks to an external system other than a database: HTTP, files, a queue.", { signals: ["a recorded boundary call with no SQL statement"] }),
  role("direct-io", Lens.Io, CALLABLE, "Makes a boundary call (database, HTTP, filesystem) itself, not through a callee.", { signals: ["a boundary call recorded on its own span"] }),
  role("query", Lens.Cqs, CALLABLE, "Returns a value and changes no state.", { signals: ["an executed return with a value", "no writes-state"] }),
  role("command", Lens.Cqs, CALLABLE, "Changes state and returns nothing.", { signals: ["writes-state", "no executed return with a value"] }),
  role("both", Lens.Cqs, CALLABLE, "Changes state and returns a value: what CQS forbids, and what a command handler returning the new id is allowed.", {
    signals: ["writes-state", "an executed return with a value"],
  }),
  role("can-fail", Lens.Failure, CALLABLE, "Raises, throws, panics or makes an error.", { signals: ["raise, throw, panic(, errors.New or fmt.Errorf in its own lines"] }),
  role("decision", Lens.Intent, CALLABLE, "Branches on domain facts.", { look_alikes: ["orchestration: branches only on whether a call worked"] }),
  role("orchestration", Lens.Intent, CALLABLE, "Sequences other callables without deciding anything itself."),
  role("mixed", Lens.Intent, CALLABLE, "Decides and orchestrates at once: mixed levels of abstraction."),
];

/** Every style's default rules, and the ones a project turns on by `match`. */
export const BUILT_IN_RULES: readonly TagRule[] = [
  {
    id: "role-outside-expected-zone",
    message: "its role belongs in another zone",
    styles: ALL_STYLES,
    match: null,
    when: [],
    flag: [`${Axis.ZoneExpected}=no`],
    unless: [],
    severity: "warn",
    off_in: [],
  },
  {
    id: "io-outside-allowed-zones",
    message: "does I/O itself in a zone its style keeps free of it",
    styles: ALL_STYLES,
    match: null,
    when: [`${Axis.Kind}=${Kind.Callable}`],
    flag: [`${Lens.Io}=direct-io`, `${Axis.ZoneIo}=no`],
    unless: [],
    severity: "warn",
    off_in: [],
  },
  {
    id: "cqrs-no-mixed-callable",
    message: "changes state and returns a value (CQS)",
    // No style implies CQRS: a project turns it on for a container with "match".
    styles: [],
    match: null,
    when: [`${Axis.Kind}=${Kind.Callable}`],
    flag: [`${Lens.Cqs}=both`],
    unless: [`${Axis.Role}=command-handler`],
    severity: "warn",
    off_in: [],
  },
];

export class TaxonomyError extends Error {
  constructor(readonly problems: string[]) {
    super(`the taxonomy is invalid:\n  - ${problems.join("\n  - ")}`);
  }
}

/** A parsed condition: "axis=a|b" or "axis!=a|b". */
export interface Condition {
  axis: string;
  values: string[];
  negated: boolean;
}

export function parseCondition(text: string): Condition | null {
  const match = /^([a-z-]+)(!?=)([A-Za-z0-9|_-]+)$/.exec(text.trim());
  if (match === null) return null;
  return { axis: match[1]!, negated: match[2] === "!=", values: match[3]!.split("|") };
}

/**
 * The built-in vocabulary with a project's overrides applied: definitions and rules by id,
 * and the roles the project wrote down. `file` is the section as written, so saving
 * runshape.json keeps it as it was.
 */
export class Taxonomy {
  private readonly declared: { declaration: RoleDeclaration; glob: Glob }[];

  constructor(
    readonly definitions: readonly Definition[],
    readonly rules: readonly TagRule[],
    readonly roles: readonly RoleDeclaration[] = [],
    readonly file: TaxonomyFile | null = null,
  ) {
    this.declared = roles.map((declaration) => ({ declaration, glob: new Glob(declaration.match) }));
  }

  static builtIn(): Taxonomy {
    return new Taxonomy(BUILT_IN_DEFINITIONS, BUILT_IN_RULES);
  }

  /** Reads the section; every problem is reported at once, each with where it is. */
  static parse(section: unknown, regionNames: readonly string[] = []): Taxonomy {
    const problems: string[] = [];
    const taxonomy = readTaxonomy(section, regionNames, problems);
    if (problems.length > 0) throw new TaxonomyError(problems);
    return taxonomy;
  }

  definition(lens: string, id: string): Definition | undefined {
    return this.definitions.find((candidate) => candidate.lens === lens && candidate.id === id);
  }

  /** The definitions of these lenses that a kind can carry. */
  definitionsFor(kind: Kind, lenses: readonly string[]): Definition[] {
    return this.definitions.filter((candidate) => candidate.on.includes(kind) && lenses.includes(candidate.lens));
  }

  /** The roles runshape.json declares for a name, in file order. */
  declaredFor(segments: readonly string[]): RoleDeclaration[] {
    return this.declared.filter((entry) => entry.glob.matches(segments)).map((entry) => entry.declaration);
  }

  /** A model's proposals added for approval: they're written to runshape.json, never applied silently. */
  withRoles(declarations: RoleDeclaration[]): Taxonomy {
    const file: TaxonomyFile = { ...(this.file ?? {}), roles: [...(this.file?.roles ?? []), ...declarations] };
    return new Taxonomy(this.definitions, this.rules, [...this.roles, ...declarations], file);
  }

  /**
   * The taxonomy as runshape.json will hold it once only these regions exist: rules switched
   * off in a region that's going away lose that name (it would no longer load). `dropped` says
   * what went, for the confirmation a person reads before saving.
   */
  keptWithRegions(regionNames: readonly string[]): { taxonomy: Taxonomy; dropped: string[] } {
    if (this.file?.rules === undefined) return { taxonomy: this, dropped: [] };
    const dropped: string[] = [];
    const rules = this.file.rules.map((rule) => {
      const gone = (rule.off_in ?? []).filter((region) => !regionNames.includes(region));
      if (gone.length === 0) return rule;
      dropped.push(`${rule.id}: off_in ${gone.join(", ")}`);
      return { ...rule, off_in: (rule.off_in ?? []).filter((region) => regionNames.includes(region)) };
    });
    if (dropped.length === 0) return { taxonomy: this, dropped };
    const file = { ...this.file, rules };
    return { taxonomy: Taxonomy.parse(file, regionNames), dropped };
  }

  /** How many entries the project's section holds: what a person loses if it's dropped. */
  get size(): { definitions: number; roles: number; rules: number } {
    return { definitions: this.file?.definitions?.length ?? 0, roles: this.file?.roles?.length ?? 0, rules: this.file?.rules?.length ?? 0 };
  }

  /**
   * What a model reads to tag code: each definition with its look-alikes, for the given
   * lenses. One blurb per project, since a project's overrides are in it.
   */
  blurb(lenses: readonly string[]): string {
    return lenses
      .map((lens) => {
        const entries = this.definitions.filter((candidate) => candidate.lens === lens);
        const lines = entries.map((entry) => {
          const alike = entry.look_alikes.length > 0 ? ` Not to be confused with: ${entry.look_alikes.join("; ")}.` : "";
          return `- ${entry.id}: ${entry.definition}${alike}`;
        });
        return `${lens}:\n${lines.join("\n")}`;
      })
      .join("\n\n");
  }
}

/** Below this a claim is shown as a guess, not a fact: "pure" at 0.4 means only "nothing was recorded". */
export const LOW_CONFIDENCE = 0.5;

/**
 * A claim as a person reads it: "pure" as "no recorded effect", anything else under
 * LOW_CONFIDENCE marked as a guess, and who said so when it wasn't the detector.
 */
export function claimText(claim: Claim): string {
  const id = claim.lens === Lens.Effect && claim.id === "pure" ? "no recorded effect" : claim.id;
  const notes = [claim.by === "detected" ? null : claim.by, claim.confidence < LOW_CONFIDENCE && id === claim.id ? `low confidence, ${claim.confidence}` : null].filter((note) => note !== null);
  return notes.length === 0 ? id : `${id} (${notes.join("; ")})`;
}

/** True when a definition's name globs match the item's own name. */
export function matchingName(definition: Definition, name: string): string | null {
  return definition.names.find((pattern) => segmentMatches(pattern, name)) ?? null;
}

/** As Taxonomy.parse, pushing problems onto a list shared with the rest of runshape.json. */
export function readTaxonomy(section: unknown, regionNames: readonly string[], problems: string[]): Taxonomy {
  if (section === undefined) return Taxonomy.builtIn();
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    problems.push(`"taxonomy" must be an object with "definitions", "roles" and "rules", each optional`);
    return Taxonomy.builtIn();
  }
  const file = section as Record<string, unknown>;
  for (const key of Object.keys(file)) {
    if (!["definitions", "roles", "rules"].includes(key)) problems.push(`taxonomy.${key} is not a part of the taxonomy: "definitions", "roles" or "rules"`);
  }
  const definitions = readDefinitions(file.definitions, problems);
  const roles = readRoles(file.roles, definitions, problems);
  const rules = readRules(file.rules, definitions, regionNames, problems);
  return new Taxonomy(definitions, rules, roles, section as TaxonomyFile);
}

function listOf(value: unknown, where: string, problems: string[]): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${where} must be a list`);
    return [];
  }
  return value;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The built-in entry an override names: by id, and by lens too when two lenses share the id. */
function findEntry<T extends { id: string; lens?: string }>(entries: readonly T[], id: string, lens: unknown, at: string, problems: string[]): T | null | undefined {
  const same = entries.filter((entry) => entry.id === id && (lens === undefined || entry.lens === lens));
  if (same.length > 1) {
    problems.push(`${at}: ${id} is in lenses ${same.map((entry) => entry.lens).join(" and ")}: say which with "lens"`);
    return null;
  }
  return same[0];
}

function readDefinitions(value: unknown, problems: string[]): Definition[] {
  const definitions = [...BUILT_IN_DEFINITIONS];
  listOf(value, "taxonomy.definitions", problems).forEach((given, index) => {
    const at = `taxonomy.definitions[${index}]`;
    if (typeof given !== "object" || given === null) {
      problems.push(`${at} must be a definition: id, and the fields to change`);
      return;
    }
    const candidate = given as Record<string, unknown>;
    const before = problems.length;
    if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
      problems.push(`${at}.id must name the definition`);
      return;
    }
    for (const field of ["signals", "look_alikes", "expected_in", "names"] as const) {
      if (candidate[field] !== undefined && !isStringList(candidate[field])) problems.push(`${at}.${field} must be a list of strings`);
    }
    if (candidate.definition !== undefined && (typeof candidate.definition !== "string" || candidate.definition.trim() === "")) problems.push(`${at}.definition must be text`);
    if (isStringList(candidate.expected_in)) {
      for (const zone of candidate.expected_in) if (!ALL_ZONES.includes(zone)) problems.push(`${at}.expected_in: ${zone} is not a zone of any style (${ALL_ZONES.join(", ")})`);
    }
    if (candidate.on !== undefined && !(isStringList(candidate.on) && candidate.on.every((kind) => (Object.values(Kind) as string[]).includes(kind)))) {
      problems.push(`${at}.on must list kinds: ${Object.values(Kind).join(", ")}`);
    }
    const existing = findEntry(definitions, candidate.id, candidate.lens, at, problems);
    if (existing === undefined) {
      // A new entry: everything a model and the rules need, said once.
      if (typeof candidate.lens !== "string" || candidate.lens.trim() === "") problems.push(`${at}: ${candidate.id} is not built in, so it needs a "lens"`);
      // A new lens would be inert: no style uses it, so nothing would ever be tagged with it.
      else if (!KNOWN_LENSES.includes(candidate.lens)) problems.push(`${at}.lens ${candidate.lens} is not a lens: ${KNOWN_LENSES.join(", ")}`);
      if (typeof candidate.definition !== "string") problems.push(`${at}: ${candidate.id} is not built in, so it needs a "definition"`);
      if (candidate.on === undefined) problems.push(`${at}: ${candidate.id} is not built in, so it needs "on" (the kinds that carry it)`);
    }
    if (problems.length > before || existing === null) return;
    const merged = { ...(existing ?? role(candidate.id, candidate.lens as Lens, [], "")), ...(candidate as Partial<Definition>) } as Definition;
    if (existing === undefined) definitions.push(merged);
    else definitions[definitions.indexOf(existing)] = merged;
  });
  return definitions;
}

function readRoles(value: unknown, definitions: readonly Definition[], problems: string[]): RoleDeclaration[] {
  const roles: RoleDeclaration[] = [];
  listOf(value, "taxonomy.roles", problems).forEach((given, index) => {
    const at = `taxonomy.roles[${index}]`;
    const candidate = (typeof given === "object" && given !== null ? given : {}) as Partial<RoleDeclaration>;
    const before = problems.length;
    if (typeof candidate.match !== "string" || candidate.match.trim() === "") problems.push(`${at}.match must be a name or glob`);
    if (typeof candidate.reason !== "string" || candidate.reason.trim() === "") problems.push(`${at}.reason must say why`);
    if (candidate.by !== undefined && !["user", "llm", "detected"].includes(candidate.by)) problems.push(`${at}.by must be "user", "llm" or "detected"`);
    const roleDefinitions = definitions.filter((definition) => ROLE_LENSES.includes(definition.lens));
    if (typeof candidate.role !== "string") problems.push(`${at}.role must name a role`);
    else {
      const found = findEntry(roleDefinitions, candidate.role, candidate.lens, at, problems);
      if (found === undefined) problems.push(`${at}.role ${candidate.role} is not a role${candidate.lens === undefined ? "" : ` in ${candidate.lens}`}: define it in taxonomy.definitions first`);
      // Declared roles are read for types and callables; a container's role is a zone rule's "role".
      else if (found !== null && !found.on.some((kind) => DECLARABLE_KINDS.includes(kind))) {
        problems.push(`${at}.role ${candidate.role} is for ${found.on.join(", ")}, which a declared role never reaches: ${candidate.role === "composition-root" ? 'give the zone rule "role": "composition-root"' : `declare it on a ${DECLARABLE_KINDS.join(" or ")}`}`);
      }
    }
    if (problems.length === before) roles.push({ ...(candidate as RoleDeclaration), by: candidate.by ?? "user" });
  });
  return roles;
}

function readRules(value: unknown, definitions: readonly Definition[], regionNames: readonly string[], problems: string[]): TagRule[] {
  const rules = [...BUILT_IN_RULES];
  listOf(value, "taxonomy.rules", problems).forEach((given, index) => {
    const at = `taxonomy.rules[${index}]`;
    if (typeof given !== "object" || given === null || typeof (given as { id?: unknown }).id !== "string") {
      problems.push(`${at} must be a rule with an "id"`);
      return;
    }
    const candidate = given as Partial<TagRule> & { id: string };
    const before = problems.length;
    const existing = rules.find((rule) => rule.id === candidate.id);
    if (existing === undefined) {
      if (!isStringList(candidate.flag) || candidate.flag.length === 0) problems.push(`${at}: ${candidate.id} is not built in, so it needs "flag" (the conditions that make a finding)`);
      if (typeof candidate.message !== "string") problems.push(`${at}: ${candidate.id} is not built in, so it needs a "message"`);
      // Without either it applies nowhere: a rule that silently never runs looks like a passing one.
      const scoped = (typeof candidate.match === "string" && candidate.match.trim() !== "") || (isStringList(candidate.styles) && candidate.styles.length > 0);
      if (!scoped) problems.push(`${at}: ${candidate.id} applies nowhere: give it "match" (a glob) or "styles"`);
    }
    if (candidate.message !== undefined && (typeof candidate.message !== "string" || candidate.message.trim() === "")) problems.push(`${at}.message must be text`);
    if (candidate.severity !== undefined && !SEVERITIES.includes(candidate.severity)) problems.push(`${at}.severity must be one of ${SEVERITIES.join(", ")}`);
    if (candidate.match !== undefined && candidate.match !== null && (typeof candidate.match !== "string" || candidate.match.trim() === "")) problems.push(`${at}.match must be a name or glob`);
    if (candidate.styles !== undefined) {
      if (!isStringList(candidate.styles)) problems.push(`${at}.styles must be a list of styles`);
      else for (const style of candidate.styles) if (!ALL_STYLES.includes(style as ArchitectureStyle)) problems.push(`${at}.styles: ${style} is not one of ${ALL_STYLES.join(", ")}`);
    }
    if (candidate.off_in !== undefined) {
      if (!isStringList(candidate.off_in)) problems.push(`${at}.off_in must be a list of region names`);
      else for (const region of candidate.off_in) if (!regionNames.includes(region)) problems.push(`${at}.off_in: there is no region named ${region}`);
    }
    for (const field of ["when", "flag", "unless"] as const) {
      const conditions = candidate[field];
      if (conditions === undefined) continue;
      if (!isStringList(conditions)) {
        problems.push(`${at}.${field} must be a list of conditions ("cqs=both")`);
        continue;
      }
      conditions.forEach((text, i) => {
        const problem = conditionProblem(text, definitions);
        if (problem !== null) problems.push(`${at}.${field}[${i}] ${JSON.stringify(text)}: ${problem}`);
      });
    }
    if (problems.length > before) return;
    const merged: TagRule = { ...(existing ?? { id: candidate.id, message: "", styles: [], match: null, when: [], flag: [], unless: [], severity: "warn", off_in: [] }), ...candidate };
    if (existing === undefined) rules.push(merged);
    else rules[rules.indexOf(existing)] = merged;
  });
  return rules;
}

/** Why a condition can't be read, or null. Unknown values fail here, not by silently never matching. */
function conditionProblem(text: string, definitions: readonly Definition[]): string | null {
  const condition = parseCondition(text);
  if (condition === null) return `write it "axis=value", "axis=a|b" or "axis!=value"`;
  const lenses = [...new Set(definitions.map((definition) => definition.lens))];
  const known: Record<string, readonly string[]> = {
    [Axis.Kind]: Object.values(Kind),
    [Axis.Style]: ALL_STYLES,
    [Axis.Zone]: ALL_ZONES,
    [Axis.Role]: definitions.filter((definition) => ROLE_LENSES.includes(definition.lens)).map((definition) => definition.id),
    [Axis.ZoneExpected]: YES_NO,
    [Axis.ZoneIo]: YES_NO,
    ...Object.fromEntries(lenses.map((lens) => [lens, definitions.filter((definition) => definition.lens === lens).map((definition) => definition.id)])),
  };
  const values = known[condition.axis];
  if (values === undefined) return `${condition.axis} is not an axis: ${Object.keys(known).join(", ")}`;
  const unknown = condition.values.filter((value) => !values.includes(value));
  return unknown.length === 0 ? null : `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not ${condition.axis} values (${values.join(", ")})`;
}
