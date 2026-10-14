import { LandmarkKind, QualifiedName, Role, Span } from "@runshape/trace";

export const CLIENT_ID = "client";
export const MIDDLEWARE_CHAIN_ID = "landmark:middleware-chain";

/** How finely the graph and the replay split the system into boxes. They must agree. */
export interface Grouping {
  /** One "middleware" box instead of one per middleware class. */
  collapseMiddleware: boolean;
}

export const FINE_GROUPING: Grouping = { collapseMiddleware: false };

export enum ComponentKind {
  Client = "client",
  Entry = "entry",
  Middleware = "middleware",
  Router = "router",
  Class = "class",
  Module = "module",
  TestDouble = "test-double",
  External = "external",
}

export interface ComponentRef {
  id: string;
  kind: ComponentKind;
  label: string;
  /** The class or module, for source components. */
  name: QualifiedName | null;
}

const LANDMARK_COMPONENT_KIND: Record<LandmarkKind, ComponentKind> = {
  [LandmarkKind.RequestEntry]: ComponentKind.Entry,
  [LandmarkKind.Middleware]: ComponentKind.Middleware,
  [LandmarkKind.Router]: ComponentKind.Router,
};

/**
 * Which box on the system graph a span belongs to. Methods are grouped by the class of the
 * object that actually received the call, not the class that defined the method, so
 * BaseRepository.connection called on a UsersRepository counts as UsersRepository.
 */
export function componentOf(span: Span, grouping: Grouping = FINE_GROUPING): ComponentRef {
  const fn = span.fn;
  if (grouping.collapseMiddleware && fn.landmarkKind === LandmarkKind.Middleware) {
    return { id: MIDDLEWARE_CHAIN_ID, kind: ComponentKind.Middleware, label: "Middleware", name: null };
  }
  if (fn.role === Role.Test) {
    if (!calledFromTheApp(span)) {
      return { id: CLIENT_ID, kind: ComponentKind.Client, label: "Client (tests)", name: null };
    }
    // Test code the app calls into is a fake standing in for a real adapter.
    return doubleComponent(ownerName(span));
  }
  if (fn.role === Role.Landmark) {
    const kind = fn.landmarkKind === null ? ComponentKind.Middleware : LANDMARK_COMPONENT_KIND[fn.landmarkKind];
    const name = fn.symbol.localName.text;
    return { id: `landmark:${kind}:${name}`, kind, label: name, name: null };
  }
  if (span.obj !== null) {
    return classComponent(span.obj.type);
  }
  const owner = ownerName(span);
  const module = fn.symbol.namespaceName;
  if (!owner.equals(module)) {
    return classComponent(owner);
  }
  return moduleComponent(module);
}

/** The prefixes of the ids of boxes named after code; the rest of such an id is the name's text. */
const NAMED_ID_PREFIXES: Partial<Record<ComponentKind, string>> = {
  [ComponentKind.Class]: "class:",
  [ComponentKind.Module]: "module:",
  [ComponentKind.TestDouble]: "double:",
};

/** The same box under the name `rename` gives it: how a comparison follows a module or class that moved. */
export function renamedComponent(ref: ComponentRef, rename: (name: QualifiedName) => QualifiedName): ComponentRef {
  if (ref.name === null) return ref;
  const name = rename(ref.name);
  if (name.equals(ref.name)) return ref;
  if (ref.kind === ComponentKind.Class) return classComponent(name);
  if (ref.kind === ComponentKind.Module) return moduleComponent(name);
  if (ref.kind === ComponentKind.TestDouble) return doubleComponent(name);
  return ref;
}

/** As renamedComponent, for a box known only by its id (a graph node, a replay step). */
export function renamedComponentId(id: string, rename: (name: QualifiedName) => QualifiedName): string {
  for (const prefix of Object.values(NAMED_ID_PREFIXES)) {
    if (id.startsWith(prefix)) return `${prefix}${rename(QualifiedName.parse(id.slice(prefix.length))).text}`;
  }
  return id;
}

function moduleComponent(module: QualifiedName): ComponentRef {
  return { id: `${NAMED_ID_PREFIXES[ComponentKind.Module]}${module.text}`, kind: ComponentKind.Module, label: moduleLabel(module), name: module };
}

function doubleComponent(owner: QualifiedName): ComponentRef {
  return { id: `${NAMED_ID_PREFIXES[ComponentKind.TestDouble]}${owner.text}`, kind: ComponentKind.TestDouble, label: owner.last, name: owner };
}

/** app.db.repositories.users.UsersRepository for a method, else the module itself. */
function ownerName(span: Span): QualifiedName {
  return span.obj !== null ? span.obj.type : span.fn.symbol.owner;
}

function calledFromTheApp(span: Span): boolean {
  for (let ancestor = span.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.fn.role !== Role.Test) return true;
  }
  return false;
}

/** Two segments: app.api.routes.authentication and app.services.authentication must differ. */
function moduleLabel(module: QualifiedName): string {
  return module.segments.slice(-2).join(".");
}

export function externalComponent(system: string): ComponentRef {
  return { id: `external:${system}`, kind: ComponentKind.External, label: system, name: null };
}

/** The graph id of a project class's box; objects and the calls made on them share it. */
export function classComponentId(type: QualifiedName): string {
  return `${NAMED_ID_PREFIXES[ComponentKind.Class]}${type.text}`;
}

function classComponent(type: QualifiedName): ComponentRef {
  return { id: classComponentId(type), kind: ComponentKind.Class, label: type.last, name: type };
}
