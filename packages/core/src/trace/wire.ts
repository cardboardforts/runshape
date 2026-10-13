// The hexvis trace format as written by the Python recorder (docs/trace-format.md).
// These types describe the wire shape only; parse.ts maps them into the domain model.

export const TRACE_FORMAT = "hexvis-trace";
export const SUPPORTED_VERSION = 1;

export interface ManifestDto {
  format: string;
  version: number;
  createdAt: string;
  python: string;
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
  routes: { methods: string[]; path: string; handler: string }[];
  externals: { name: string; kind: string }[];
}

export interface CatalogFunctionDto {
  file: string;
  module: string;
  qualname: string;
  firstLine: number;
  lastLine: number;
  lines: number[];
}

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

export interface FunctionDto {
  key: string;
  role: string;
  module: string;
  qualname: string;
  file: string | null;
  firstLine: number;
  landmarkKind: string | null;
}

type Micros = number;
type SpanId = number;
type ObjectId = number;

export type EventDto =
  | ["P", Micros, string]
  | ["S", Micros, SpanId, number, SpanId | null, number, ObjectId | null]
  | ["R", Micros, SpanId, number]
  | ["X", Micros, SpanId]
  | ["L", SpanId, number]
  | ["O", Micros, ObjectId, string, SpanId | null]
  | ["W", Micros, ObjectId, string, ObjectId]
  | ["B", Micros, SpanId | null, string, string, string | null]
  | ["Q", Micros, SpanId, string, string];
