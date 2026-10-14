import {
  BoundaryCall,
  CatalogFunction,
  CodeSymbol,
  FunctionInfo,
  LandmarkKind,
  ObjectInstance,
  Outcome,
  Phase,
  QualifiedName,
  Role,
  Run,
  Scenario,
  Span,
  SymbolKind,
  Topology,
} from "./model";
import { CatalogFunctionDto, CodeNameDto, ManifestDto, ScenarioDto, SUPPORTED_VERSIONS, TRACE_FORMAT } from "./wire";

export class TraceFormatError extends Error {
  constructor(readonly problems: string[]) {
    super(`not a readable runshape trace:\n  - ${problems.join("\n  - ")}`);
  }
}

export interface LoadedScenario {
  file: string;
  dto: ScenarioDto;
}

/**
 * A manifest we can't read is fatal. A single unreadable scenario is skipped and reported
 * in Run.problems, so one corrupt file doesn't hide the other ninety.
 */
export function parseRun(manifest: ManifestDto, loaded: LoadedScenario[]): Run {
  const manifestProblems: string[] = [];
  if (manifest.format !== TRACE_FORMAT) {
    manifestProblems.push(`format is ${JSON.stringify(manifest.format)}, expected ${JSON.stringify(TRACE_FORMAT)}`);
  }
  if (!SUPPORTED_VERSIONS.includes(manifest.version)) {
    manifestProblems.push(`version ${manifest.version} is not supported (this viewer reads versions ${SUPPORTED_VERSIONS.join(" and ")})`);
  }
  if (manifest.version === 2) {
    for (const field of ["language", "runtime"] as const) {
      if (typeof manifest[field] !== "string" || manifest[field] === "") {
        manifestProblems.push(`version 2 says which ${field} recorded it: "${field}" is missing`);
      }
    }
  }
  if (manifestProblems.length > 0) {
    throw new TraceFormatError(manifestProblems);
  }
  const naming = manifest.version === 1 ? VERSION_1_NAMES : VERSION_2_NAMES;

  const problems = [...(manifest.sessionProblems ?? [])];
  for (const problem of manifest.catalogProblems ?? []) {
    problems.push(`${problem.file}: ${problem.reason}`);
  }
  const catalog: CatalogFunction[] = [];
  (manifest.catalog ?? []).forEach((entry, index) => {
    try {
      catalog.push(parseCatalogFunction(entry, naming));
    } catch (error) {
      problems.push(`catalog entry ${index} (${entry?.file}) skipped: ${messageOf(error)}`);
    }
  });
  let topology: Topology | null = null;
  try {
    topology = manifest.framework && {
      ...manifest.framework,
      routes: manifest.framework.routes.map((route) => ({ ...route, handler: naming.type(route.handler) })),
    };
  } catch (error) {
    problems.push(`framework skipped: ${messageOf(error)}`);
  }
  const scenarios: Scenario[] = [];
  for (const { file, dto } of loaded) {
    try {
      scenarios.push(parseScenario(dto, naming));
    } catch (error) {
      problems.push(`${file}: skipped, ${messageOf(error)}`);
    }
  }
  return new Run(
    manifest.root,
    manifest.createdAt,
    manifest.language ?? "python",
    manifest.runtime ?? manifest.python ?? "unknown",
    manifest.backend,
    topology,
    catalog,
    scenarios,
    problems,
    manifest.recorder ?? null,
    manifest.sources ? new Map(Object.entries(manifest.sources)) : null,
  );
}

export function parseScenario(dto: ScenarioDto, naming: Naming): Scenario {
  const functions = dto.functions.map((fn, index) => {
    try {
      return parseFunction(fn, naming);
    } catch (error) {
      throw new Error(`function ${index}: ${messageOf(error)}`);
    }
  });
  const spans = new Map<number, Span>();
  // Objects first: the recorder writes a creating span's "S" before the "O" it causes.
  const objects = new Map<number, ObjectInstance>();
  const createdIn = new Map<number, number>();
  for (const event of dto.events) {
    if (event[0] === "O") {
      objects.set(event[2], new ObjectInstance(event[2], naming.type(event[3]), event[1]));
      if (event[4] !== null) createdIn.set(event[2], event[4]);
    }
  }
  const boundaryCalls: BoundaryCall[] = [];
  let phase = Phase.Setup;

  for (const event of dto.events) {
    switch (event[0]) {
      case "P":
        phase = parseEnum(Phase, event[2], "phase");
        break;
      case "S": {
        const [, startUs, id, functionIndex, parentId, thread, objectId] = event;
        const fn = functions[functionIndex];
        if (fn === undefined) {
          throw new Error(`span ${id} refers to unknown function ${functionIndex}`);
        }
        const parent = parentId === null ? null : spans.get(parentId) ?? null;
        const obj = objectId === null ? null : objects.get(objectId) ?? null;
        const span = new Span(id, fn, parent, obj, phase, startUs, thread);
        spans.set(id, span);
        parent?.children.push(span);
        break;
      }
      case "R": {
        const span = spans.get(event[2]);
        if (span) {
          span.resumes += 1;
          span.resumedAt(event[1]);
        }
        break;
      }
      case "X": {
        const span = spans.get(event[2]);
        if (span) span.stoppedAt(event[1]);
        break;
      }
      case "L":
        spans.get(event[1])?.lines.push(event[2]);
        break;
      case "O":
        break;
      case "W": {
        const [, atUs, from, attribute, to] = event;
        const source = objects.get(from);
        const target = objects.get(to);
        if (source && target) source.wires.push({ attribute, target, atUs });
        break;
      }
      case "B": {
        const [, startUs, callerId, system, operation, statement] = event;
        const caller = callerId === null ? null : spans.get(callerId) ?? null;
        const call: BoundaryCall = { system, operation, statement, startUs, caller, phase };
        boundaryCalls.push(call);
        caller?.boundaryCalls.push(call);
        break;
      }
      case "Q": {
        const span = spans.get(event[2]);
        if (span) span.request = { method: event[3], path: event[4] };
        break;
      }
      default:
        throw new Error(`unknown event tag ${JSON.stringify((event as unknown[])[0])}`);
    }
  }

  for (const [objectId, spanId] of createdIn) {
    const obj = objects.get(objectId);
    if (obj) obj.createdIn = spans.get(spanId) ?? null;
  }

  return new Scenario(
    dto.nodeid,
    parseEnum(Outcome, dto.outcome, "outcome"),
    dto.durationUs,
    [...spans.values()],
    [...objects.values()],
    boundaryCalls,
    dto.recorderErrors,
  );
}

function parseFunction(dto: ScenarioDto["functions"][number], naming: Naming): FunctionInfo {
  return {
    role: parseEnum(Role, dto.role, "role"),
    symbol: naming.symbol(dto),
    file: dto.file,
    firstLine: dto.firstLine,
    landmarkKind: dto.landmarkKind === null ? null : parseEnum(LandmarkKind, dto.landmarkKind, "landmarkKind"),
  };
}

function parseCatalogFunction(dto: CatalogFunctionDto, naming: Naming): CatalogFunction {
  return { file: dto.file, firstLine: dto.firstLine, lastLine: dto.lastLine, lines: dto.lines, symbol: naming.symbol(dto) };
}

/** How one version names code. The manifest's version picks it, never an entry's own shape. */
interface Naming {
  symbol(dto: CodeNameDto): CodeSymbol;
  /** An object's class or a route's handler. */
  type(name: unknown): QualifiedName;
}

const VERSION_1_NAMES: Naming = {
  symbol(dto) {
    if (!("module" in dto) || typeof dto.module !== "string" || typeof dto.qualname !== "string") {
      throw new Error("version 1 names code by module and qualname");
    }
    return pythonSymbol(dto.module, dto.qualname);
  },
  type: (name) => new QualifiedName(text(name, "a version 1 class or handler").split(".")),
};

const VERSION_2_NAMES: Naming = {
  symbol(dto) {
    if (!("symbol" in dto) || typeof dto.symbol !== "object" || dto.symbol === null) {
      throw new Error("version 2 names code by symbol, not module and qualname");
    }
    const { namespace, container, name, kind, ownerType } = dto.symbol;
    return new CodeSymbol(
      segments(namespace, "symbol namespace"),
      segments(container, "symbol container"),
      text(name, "symbol name"),
      parseEnum(SymbolKind, kind, "symbol kind"),
      ownerType === null ? null : text(ownerType, "symbol ownerType"),
    );
  },
  type: (name) => new QualifiedName(segments(name, "a version 2 class or handler")),
};

function segments(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((segment) => typeof segment === "string")) throw new Error(`${field} is not a list of strings`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is not text`);
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "pkg.mod" + "Class.method.<locals>.inner": with VERSION_1_NAMES.type, the only places Python's dots are taken apart. */
export function pythonSymbol(module: string, qualname: string): CodeSymbol {
  const container = qualname.split(".");
  const name = container.pop() ?? "";
  // "Class.method", "Class.method.<locals>.f" and "Outer.Inner.m" are drawn in the outermost
  // class's box; "f.<locals>.g" in its module's.
  const ownerType = container.length > 0 && container[1] !== "<locals>" ? container[0]! : null;
  return new CodeSymbol(module.split("."), container, name, pythonKind(container, name, ownerType), ownerType);
}

function pythonKind(container: string[], name: string, ownerType: string | null): SymbolKind {
  if (container.includes("<locals>")) return SymbolKind.Nested;
  if (name === "<module>") return SymbolKind.Initializer;
  if (ownerType === null) return SymbolKind.Function;
  return name === "__init__" ? SymbolKind.Constructor : SymbolKind.Method;
}

function parseEnum<T extends Record<string, string>>(enumObject: T, value: string, field: string): T[keyof T] {
  for (const member of Object.values(enumObject)) {
    if (member === value) {
      return member as T[keyof T];
    }
  }
  throw new Error(`${field} ${JSON.stringify(value)} is not one of ${Object.values(enumObject).join(", ")}`);
}
