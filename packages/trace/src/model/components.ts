import { LandmarkKind, QualifiedName, Role, Span } from "./trace";

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

/**
 * How a comparison renames boxes when code moved: a module box by its module's new name, a class
 * box by its class's. Kept apart because a module moving says nothing about one beside it.
 */
export interface Renaming {
  module(name: QualifiedName): QualifiedName;
  type(name: QualifiedName): QualifiedName;
}

/** Nothing renamed: every name stays as it is. */
export const NO_RENAMING: Renaming = { module: (name) => name, type: (name) => name };

/** The same box under the name `renaming` gives it. */
export function renamedComponent(ref: ComponentRef, renaming: Renaming): ComponentRef {
  if (ref.name === null) return ref;
  if (ref.kind === ComponentKind.Class) return renamedIfMoved(ref, renaming.type(ref.name), classComponent);
  if (ref.kind === ComponentKind.Module) return renamedIfMoved(ref, renaming.module(ref.name), moduleComponent);
  if (ref.kind === ComponentKind.TestDouble) return renamedIfMoved(ref, doubleOwner(ref.name, renaming), doubleComponent);
  return ref;
}

/** As renamedComponent, for a box known only by its id (a graph node, a replay step). */
export function renamedComponentId(id: string, renaming: Renaming): string {
  for (const [kind, prefix] of Object.entries(NAMED_ID_PREFIXES) as [ComponentKind, string][]) {
    if (!id.startsWith(prefix)) continue;
    const name = QualifiedName.parse(id.slice(prefix.length));
    const renamed = kind === ComponentKind.Module ? renaming.module(name) : kind === ComponentKind.Class ? renaming.type(name) : doubleOwner(name, renaming);
    return `${prefix}${renamed.text}`;
  }
  return id;
}

/** A test double is named after a module or a class, whichever owned the fake code. */
function doubleOwner(name: QualifiedName, renaming: Renaming): QualifiedName {
  const asModule = renaming.module(name);
  return asModule.equals(name) ? renaming.type(name) : asModule;
}

function renamedIfMoved(ref: ComponentRef, name: QualifiedName, make: (name: QualifiedName) => ComponentRef): ComponentRef {
  return name.equals(ref.name!) ? ref : make(name);
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
