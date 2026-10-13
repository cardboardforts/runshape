"""Reads middleware, URL routes and databases from a configured Django project."""
from __future__ import annotations

from types import FrameType
from typing import Any, List, Optional, Tuple

from runshape_recorder.domain.events import LandmarkKind
from runshape_recorder.domain.scope import SQL_OPERATIONS, Boundary, CodeScope, Landmark
from runshape_recorder.domain.topology import ExternalSystem, FrameworkTopology, Route

FRAMEWORK_NAME = "django"
DRF_IGNORED_METHODS = ("options", "head")


def is_configured() -> bool:
    try:
        from django.conf import settings
    except ImportError:
        return False
    return bool(settings.configured)


def introspect(scope: CodeScope) -> FrameworkTopology:
    from django.conf import settings
    from django.core.handlers.base import BaseHandler
    from django.db import connections
    from django.urls import get_resolver
    from django.urls.resolvers import URLResolver
    from django.utils.module_loading import import_string

    scope.register_landmark(BaseHandler.get_response.__code__, Landmark(LandmarkKind.REQUEST_ENTRY, _request_line))
    scope.register_landmark(URLResolver.resolve.__code__, Landmark(LandmarkKind.ROUTER))

    middleware_names: List[str] = []
    for dotted_path in settings.MIDDLEWARE:
        cls = import_string(dotted_path)
        middleware_names.append(cls.__name__)
        # Most middleware share MiddlewareMixin.__call__; the recorder labels each span by
        # the receiving instance's class, so they still appear as distinct steps.
        scope.register_landmark(cls.__call__.__code__, Landmark(LandmarkKind.MIDDLEWARE))

    externals: List[ExternalSystem] = []
    for alias in connections:
        vendor = connections[alias].vendor
        externals.append(ExternalSystem(vendor, "database"))
    if externals:
        scope.add_boundary(Boundary("django.db.backends.utils", externals[0].name, SQL_OPERATIONS))

    return FrameworkTopology(
        framework=FRAMEWORK_NAME,
        entry="WSGIHandler",
        middleware=middleware_names,
        router="URLResolver",
        routes=_routes(get_resolver().url_patterns, ""),
        externals=externals,
    )


def _routes(patterns: List[Any], prefix: str) -> List[Route]:
    routes: List[Route] = []
    for pattern in patterns:
        path = prefix + str(pattern.pattern)
        nested = getattr(pattern, "url_patterns", None)
        if nested is not None:
            routes.extend(_routes(nested, path))
            continue
        callback = pattern.callback
        handler_cls = getattr(callback, "cls", None) or getattr(callback, "view_class", None)
        if handler_cls is not None:
            handler = f"{handler_cls.__module__}.{handler_cls.__qualname__}"
        else:
            handler = f"{callback.__module__}.{callback.__qualname__}"
        routes.append(Route(_methods(callback, handler_cls), "/" + path.lstrip("^").rstrip("$"), handler))
    return routes


def _methods(callback: Any, handler_cls: Optional[type]) -> Tuple[str, ...]:
    actions = getattr(callback, "actions", None)  # DRF ViewSet routed via a Router
    if isinstance(actions, dict):
        return tuple(sorted(m.upper() for m in actions))
    if handler_cls is None:
        return ()
    names = getattr(handler_cls, "http_method_names", ())
    return tuple(sorted(m.upper() for m in names if m not in DRF_IGNORED_METHODS and hasattr(handler_cls, m)))


def _request_line(frame: FrameType) -> Optional[Tuple[str, str]]:
    request = frame.f_locals.get("request")
    if request is None:
        return None
    return str(getattr(request, "method", "")), str(getattr(request, "path", ""))
