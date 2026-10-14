// The recorded runtime of an app: scenarios (one per test), each a tree of spans.

export enum Role {
  Source = "source",
  Test = "test",
  Landmark = "landmark",
}

export enum LandmarkKind {
  RequestEntry = "request-entry",
  Middleware = "middleware",
  Router = "router",
}

export enum Phase {
  Setup = "setup",
  Call = "call",
  Teardown = "teardown",
}

export enum Outcome {
  Passed = "passed",
  Failed = "failed",
  Error = "error",
  Skipped = "skipped",
  /** A known failure (pytest xfail): recorded like any other, flagged so it isn't mistaken for a pass. */
  ExpectedFailure = "xfailed",
  UnexpectedPass = "xpassed",
  Unknown = "unknown",
}

/**
 * A name in Runshape's own dotted syntax, the one runshape.json globs and component names on
 * the wire use: segments joined by ".", whatever language they came from, with a "." or "\"
 * inside a segment written "\." or "\\". Compare and match by segments; `text` is for the edges.
 */
export class QualifiedName {
  /** JSON, like CodeSymbol.key: "example.com" + "shop" and "example" + "com.shop" stay apart. */
  readonly key: string;

  constructor(readonly segments: readonly string[]) {
    this.key = JSON.stringify(segments);
  }

  /** Reads `text` back; a "\" before any other character, or at the end, stands for itself. */
  static parse(text: string): QualifiedName {
    return new QualifiedName(splitDotted(text));
  }

  get text(): string {
    return this.segments.map((segment) => segment.replace(/[\\.]/g, "\\$&")).join(".");
  }

  get last(): string {
    return this.segments[this.segments.length - 1] ?? "";
  }

  parent(): QualifiedName | null {
    return this.segments.length > 1 ? new QualifiedName(this.segments.slice(0, -1)) : null;
  }

  equals(other: QualifiedName): boolean {
    return this.key === other.key;
  }

  /** Strictly inside: app.api holds app.api.routes, not app.api itself or app.apix. */
  holds(other: QualifiedName): boolean {
    return other.segments.length > this.segments.length && this.segments.every((segment, i) => other.segments[i] === segment);
  }
}

/** Splits on unescaped dots and unescapes; QualifiedName.parse and rule globs share it. */
export function splitDotted(text: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const next = text[i + 1];
    if (char === "\\" && (next === "." || next === "\\")) {
      current += next;
      i += 1;
    } else if (char === ".") {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments;
}

/** What a piece of code is, as far as drawing it goes; recorders map their language onto these. */
export enum SymbolKind {
  Function = "function",
  Method = "method",
  /** Builds an object: Python's __init__, a C# or JS constructor, Go's or Rust's by convention if the recorder knows. */
  Constructor = "constructor",
  /** Runs when a module, class or package is loaded: Python's <module>, a static initializer. */
  Initializer = "initializer",
  /** Defined inside another function: closures, lambdas, comprehensions. */
  Nested = "nested",
}

/**
 * Where a function lives, as segments the trace parser split once, so no view parses a
 * language's separators. `key` is the identity diffs pair functions by across runs.
 */
export class CodeSymbol {
  /** JSON, not a joined string: no separator can collide with a segment in any language. */
  readonly key: string;
  readonly namespaceName: QualifiedName;
  /** Container and name: what the function is called within its namespace. */
  readonly localName: QualifiedName;
  /** Namespace, container and name: what a route registers as its handler. */
  readonly path: QualifiedName;

  constructor(
    readonly namespace: readonly string[],
    readonly container: readonly string[],
    readonly name: string,
    readonly kind: SymbolKind,
    /** The type whose box this code is drawn in (a method's class, a closure's enclosing class), if any. */
    readonly ownerType: string | null,
  ) {
    this.key = JSON.stringify([namespace, container, name]);
    // Built once: componentOf asks for them on every span, several times per view.
    this.namespaceName = new QualifiedName(namespace);
    this.localName = new QualifiedName([...container, name]);
    this.path = new QualifiedName([...namespace, ...container, name]);
  }
}

export interface FunctionInfo {
  role: Role;
  symbol: CodeSymbol;
  file: string | null;
  firstLine: number;
  landmarkKind: LandmarkKind | null;
}

export interface CatalogFunction {
  file: string;
  symbol: CodeSymbol;
  firstLine: number;
  lastLine: number;
  lines: number[];
}

export interface Route {
  methods: string[];
  path: string;
  handler: QualifiedName;
}

export interface Topology {
  framework: string;
  entry: string;
  middleware: string[];
  router: string | null;
  routes: Route[];
  externals: { name: string; kind: string }[];
}

export interface RequestLine {
  method: string;
  path: string;
}

export interface BoundaryCall {
  system: string;
  operation: string;
  statement: string | null;
  startUs: number;
  caller: Span | null;
  phase: Phase;
}

export interface Wire {
  attribute: string;
  target: ObjectInstance;
  /** When the holder's __init__ finished and the reference was recorded. */
  atUs: number;
}

export class ObjectInstance {
  readonly wires: Wire[] = [];
  /** The span whose __init__ built it; null if it was built before recording or by framework code. */
  createdIn: Span | null = null;

  constructor(
    readonly id: number,
    readonly type: QualifiedName,
    /** When the recorder first saw it: its construction, or its first use if built earlier. */
    readonly seenUs: number,
  ) {}
}

export class Span {
  readonly children: Span[] = [];
  readonly lines: number[] = [];
  readonly boundaryCalls: BoundaryCall[] = [];
  resumes = 0;
  endUs: number;
  /** When it was actually running: one interval for a plain call, one per resume for a coroutine. */
  readonly runs: [startUs: number, endUs: number][] = [];
  private runningSince: number | null;
  request: RequestLine | null = null;

  constructor(
    readonly id: number,
    readonly fn: FunctionInfo,
    readonly parent: Span | null,
    readonly obj: ObjectInstance | null,
    readonly phase: Phase,
    readonly startUs: number,
    readonly thread: number,
  ) {
    this.endUs = startUs;
    this.runningSince = startUs;
  }

  resumedAt(tUs: number): void {
    this.runningSince = tUs;
  }

  /** Returned, raised or suspended; the last stop is its end. */
  stoppedAt(tUs: number): void {
    this.endUs = tUs;
    if (this.runningSince !== null) this.runs.push([this.runningSince, tUs]);
    this.runningSince = null;
  }

  get isLandmark(): boolean {
    return this.fn.role === Role.Landmark;
  }

  get isTestCode(): boolean {
    return this.fn.role === Role.Test;
  }

  /** The nearest enclosing request-entry span, if this ran while serving a request. */
  enclosingRequest(): Span | null {
    let current: Span | null = this;
    while (current !== null) {
      if (current.fn.landmarkKind === LandmarkKind.RequestEntry) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }
}

export class Scenario {
  constructor(
    readonly nodeid: string,
    readonly outcome: Outcome,
    readonly durationUs: number,
    readonly spans: Span[],
    readonly objects: ObjectInstance[],
    readonly boundaryCalls: BoundaryCall[],
    readonly recorderErrors: string[],
  ) {}

  /** "tests/test_x.py::test_user_can_login[param]" -> "test_user_can_login[param]" */
  get name(): string {
    return lastSegment(this.nodeid, "::");
  }

  get file(): string {
    return this.nodeid.split("::")[0] ?? this.nodeid;
  }

  requests(): Span[] {
    return this.spans.filter((span) => span.request !== null);
  }
}

export class Run {
  constructor(
    readonly root: string,
    readonly createdAt: string,
    /** "python", "typescript", ...: who recorded it. */
    readonly language: string,
    /** The interpreter or runtime version: "3.12.9", "node 23.11.0". */
    readonly runtime: string,
    readonly backend: string,
    readonly topology: Topology | null,
    readonly catalog: CatalogFunction[],
    readonly scenarios: Scenario[],
    readonly problems: string[],
    readonly recorderVersion: string | null = null,
    /** Project source as it was when recorded, by file; null for older recordings. */
    readonly sources: ReadonlyMap<string, string[]> | null = null,
  ) {}

  /** The text of a line as it was when this run was recorded. */
  sourceLine(file: string, line: number): string | null {
    return this.sources?.get(file)?.[line - 1] ?? null;
  }

  scenario(nodeid: string): Scenario | undefined {
    return this.scenarios.find((s) => s.nodeid === nodeid);
  }

  /** By CodeSymbol.key. */
  catalogFunction(key: string): CatalogFunction | undefined {
    return this.catalog.find((f) => f.symbol.key === key);
  }
}

export function lastSegment(name: string, separator = "."): string {
  const index = name.lastIndexOf(separator);
  return index === -1 ? name : name.slice(index + separator.length);
}
