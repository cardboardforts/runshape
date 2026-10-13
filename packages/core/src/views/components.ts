import { lastSegment, LandmarkKind, Role, Span } from "../model";

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
  /** Fully qualified class or module name, for source components. */
  qualifiedName: string | null;
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
    return { id: MIDDLEWARE_CHAIN_ID, kind: ComponentKind.Middleware, label: "Middleware", qualifiedName: null };
  }
  if (fn.role === Role.Test) {
    if (!calledFromTheApp(span)) {
      return { id: CLIENT_ID, kind: ComponentKind.Client, label: "Client (tests)", qualifiedName: null };
    }
    // Test code the app calls into is a fake standing in for a real adapter.
    const owner = ownerName(span);
    return { id: `double:${owner}`, kind: ComponentKind.TestDouble, label: lastSegment(owner), qualifiedName: owner };
  }
  if (fn.role === Role.Landmark) {
    const kind = fn.landmarkKind === null ? ComponentKind.Middleware : LANDMARK_COMPONENT_KIND[fn.landmarkKind];
    return { id: `landmark:${kind}:${fn.qualname}`, kind, label: fn.qualname, qualifiedName: null };
  }
  if (span.obj !== null) {
    return classComponent(span.obj.className);
  }
  const owner = ownerName(span);
  if (owner !== span.fn.module) {
    return classComponent(owner);
  }
  return { id: `module:${fn.module}`, kind: ComponentKind.Module, label: moduleLabel(fn.module), qualifiedName: fn.module };
}

/** "app.db.repositories.users.UsersRepository" for a method, else the module itself. */
function ownerName(span: Span): string {
  if (span.obj !== null) return span.obj.className;
  const segments = span.fn.qualname.split(".");
  const isMethodOfClass = segments.length > 1 && segments[1] !== "<locals>";
  return isMethodOfClass ? `${span.fn.module}.${segments[0]}` : span.fn.module;
}

function calledFromTheApp(span: Span): boolean {
  for (let ancestor = span.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.fn.role !== Role.Test) return true;
  }
  return false;
}

/** Two segments: app.api.routes.authentication and app.services.authentication must differ. */
function moduleLabel(module: string): string {
  return module.split(".").slice(-2).join(".");
}

export function externalComponent(system: string): ComponentRef {
  return { id: `external:${system}`, kind: ComponentKind.External, label: system, qualifiedName: null };
}

function classComponent(qualifiedName: string): ComponentRef {
  return { id: `class:${qualifiedName}`, kind: ComponentKind.Class, label: lastSegment(qualifiedName), qualifiedName };
}
