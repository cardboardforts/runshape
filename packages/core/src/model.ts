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

export interface FunctionInfo {
  key: string;
  role: Role;
  module: string;
  qualname: string;
  file: string | null;
  firstLine: number;
  landmarkKind: LandmarkKind | null;
}

export interface CatalogFunction {
  file: string;
  module: string;
  qualname: string;
  firstLine: number;
  lastLine: number;
  lines: number[];
}

export interface Route {
  methods: string[];
  path: string;
  handler: string;
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
}

export class ObjectInstance {
  readonly wires: Wire[] = [];
  /** The span whose __init__ built it; null if it was built before recording or by framework code. */
  createdIn: Span | null = null;

  constructor(
    readonly id: number,
    readonly className: string,
  ) {}

  get shortClassName(): string {
    return lastSegment(this.className);
  }
}

export class Span {
  readonly children: Span[] = [];
  readonly lines: number[] = [];
  readonly boundaryCalls: BoundaryCall[] = [];
  resumes = 0;
  endUs: number;
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
    readonly python: string,
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

  catalogFunction(module: string, qualname: string): CatalogFunction | undefined {
    return this.catalog.find((f) => f.module === module && f.qualname === qualname);
  }
}

export function lastSegment(name: string, separator = "."): string {
  const index = name.lastIndexOf(separator);
  return index === -1 ? name : name.slice(index + separator.length);
}
