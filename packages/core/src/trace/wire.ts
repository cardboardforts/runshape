// The runshape trace format as written by the recorders (docs/trace-format.md). Version 1
// (the Python recorder's) names code by Python's module and qualname; version 2 by segments.
// These types describe the wire shape only; parse.ts maps them into the domain model.

export const TRACE_FORMAT = "runshape-trace";
export const SUPPORTED_VERSIONS = [1, 2];

/** Version 2's name for a piece of code; see CodeSymbol. */
export interface SymbolDto {
  namespace: string[];
  container: string[];
  name: string;
  kind: string;
  ownerType: string | null;
}

/** How an entry names its code: Python's names in version 1, a symbol in version 2. */
export type CodeNameDto = { module: string; qualname: string } | { symbol: SymbolDto };

export interface ManifestDto {
  format: string;
  version: number;
  createdAt: string;
  /** Version 1: the interpreter version. Version 2 says language and runtime instead. */
  python?: string;
  language?: string;
  runtime?: string;
  /** Absent in recordings made before the field existed. */
  recorder?: string;
  backend: string;
  root: string;
  framework: FrameworkDto | null;
  catalog: CatalogFunctionDto[];
  /** Project source at record time, by file; absent in recordings made before the field existed. */
  sources?: Record<string, string[]>;
  catalogProblems: { file: string; reason: string }[];
  sessionProblems: string[];
  scenarios: ScenarioIndexDto[];
}

export interface FrameworkDto {
  framework: string;
  entry: string;
  middleware: string[];
  router: string | null;
  /** The handler's dotted Python name (version 1) or its segments (version 2). */
  routes: { methods: string[]; path: string; handler: string | string[] }[];
  externals: { name: string; kind: string }[];
}

export type CatalogFunctionDto = CodeNameDto & {
  file: string;
  firstLine: number;
  lastLine: number;
  lines: number[];
};

export interface ScenarioIndexDto {
  nodeid: string;
  file: string;
  outcome: string;
  durationUs: number;
  eventCount: number;
  recorderErrors: number;
}

export interface ScenarioDto {
  nodeid: string;
  outcome: string;
  durationUs: number;
  functions: FunctionDto[];
  events: EventDto[];
  recorderErrors: string[];
}

export type FunctionDto = CodeNameDto & {
  role: string;
  file: string | null;
  firstLine: number;
  landmarkKind: string | null;
};

type Micros = number;
type SpanId = number;
type ObjectId = number;

export type EventDto =
  | ["P", Micros, string]
  | ["S", Micros, SpanId, number, SpanId | null, number, ObjectId | null]
  | ["R", Micros, SpanId, number]
  | ["X", Micros, SpanId]
  | ["L", SpanId, number]
  /** The class as a dotted Python name (version 1) or segments (version 2). */
  | ["O", Micros, ObjectId, string | string[], SpanId | null]
  | ["W", Micros, ObjectId, string, ObjectId]
  | ["B", Micros, SpanId | null, string, string, string | null]
  | ["Q", Micros, SpanId, string, string];
