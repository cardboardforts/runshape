import {
  BoundaryCall,
  CatalogFunction,
  CodeSymbol,
  FunctionInfo,
  SymbolKind,
  LandmarkKind,
  ObjectInstance,
  Outcome,
  Phase,
  QualifiedName,
  Role,
  Run,
  Scenario,
  Span,
} from "../model";
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
  if (manifestProblems.length > 0) {
    throw new TraceFormatError(manifestProblems);
  }

  const problems = [...(manifest.sessionProblems ?? [])];
  for (const problem of manifest.catalogProblems ?? []) {
    problems.push(`${problem.file}: ${problem.reason}`);
  }
  const scenarios: Scenario[] = [];
  for (const { file, dto } of loaded) {
    try {
      scenarios.push(parseScenario(dto));
    } catch (error) {
      problems.push(`${file}: skipped, ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return new Run(
    manifest.root,
    manifest.createdAt,
    manifest.language ?? "python",
    manifest.runtime ?? manifest.python ?? "unknown",
    manifest.backend,
    manifest.framework && {
      ...manifest.framework,
      routes: manifest.framework.routes.map((route) => ({ ...route, handler: typeName(route.handler) })),
    },
    (manifest.catalog ?? []).map(parseCatalogFunction),
    scenarios,
    problems,
    manifest.recorder ?? null,
    manifest.sources ? new Map(Object.entries(manifest.sources)) : null,
  );
}

export function parseScenario(dto: ScenarioDto): Scenario {
  const functions = dto.functions.map(parseFunction);
  const spans = new Map<number, Span>();
  // Objects first: the recorder writes a creating span's "S" before the "O" it causes.
  const objects = new Map<number, ObjectInstance>();
  const createdIn = new Map<number, number>();
  for (const event of dto.events) {
    if (event[0] === "O") {
      objects.set(event[2], new ObjectInstance(event[2], typeName(event[3]), event[1]));
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

function parseFunction(dto: ScenarioDto["functions"][number]): FunctionInfo {
  return {
    role: parseEnum(Role, dto.role, "role"),
    symbol: symbolOf(dto),
    file: dto.file,
    firstLine: dto.firstLine,
    landmarkKind: dto.landmarkKind === null ? null : parseEnum(LandmarkKind, dto.landmarkKind, "landmarkKind"),
  };
}

function parseCatalogFunction(dto: CatalogFunctionDto): CatalogFunction {
  return { file: dto.file, firstLine: dto.firstLine, lastLine: dto.lastLine, lines: dto.lines, symbol: symbolOf(dto) };
}

/** Version 2 sends segments; version 1, Python's names. */
function symbolOf(dto: CodeNameDto): CodeSymbol {
  if (!("symbol" in dto)) return pythonSymbol(dto.module, dto.qualname);
  const { namespace, container, name, kind, ownerType } = dto.symbol;
  return new CodeSymbol(namespace, container, name, parseEnum(SymbolKind, kind, "symbol kind"), ownerType);
}

/** An object's class or a route's handler: segments (version 2) or "pkg.mod.Class" (version 1). */
function typeName(name: string | string[]): QualifiedName {
  return new QualifiedName(typeof name === "string" ? name.split(".") : name);
}

/** "pkg.mod" + "Class.method.<locals>.inner": with typeName, the only places Python's dots are taken apart. */
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
