"""Reads middleware, router and routes from a FastAPI/Starlette application object."""
from __future__ import annotations

import importlib
from types import FrameType
from typing import Any, List, Optional, Tuple

from runshape_recorder.domain.events import LandmarkKind
from runshape_recorder.domain.scope import CodeScope, Landmark
from runshape_recorder.domain.topology import FrameworkTopology, Route

FRAMEWORK_NAME = "fastapi"


def load_app(import_path: str) -> Any:
    """'package.module:attribute' -> the application object."""
    module_name, _, attribute = import_path.partition(":")
    if not module_name or not attribute:
        raise ValueError(f"expected 'module:attribute', got {import_path!r}")
    return getattr(importlib.import_module(module_name), attribute)


def introspect(app: Any, scope: CodeScope) -> FrameworkTopology:
    from starlette.middleware.errors import ServerErrorMiddleware

    middleware_classes = [ServerErrorMiddleware]
    middleware_classes.extend(m.cls for m in app.user_middleware)
    middleware_classes.append(_exception_middleware())

    scope.register_landmark(type(app).__call__.__code__, Landmark(LandmarkKind.REQUEST_ENTRY, _http_request_line))
    for cls in middleware_classes:
        code = _call_code(cls)
        if code is not None:
            scope.register_landmark(code, Landmark(LandmarkKind.MIDDLEWARE))
    router_code = _call_code(type(app.router))
    if router_code is not None:
        scope.register_landmark(router_code, Landmark(LandmarkKind.ROUTER))

    return FrameworkTopology(
        framework=FRAMEWORK_NAME,
        entry=type(app).__name__,
        middleware=[cls.__name__ for cls in middleware_classes],
        router=type(app.router).__name__,
        routes=_routes(app),
    )


def _exception_middleware() -> type:
    try:  # moved in Starlette 0.21
        from starlette.middleware.exceptions import ExceptionMiddleware
    except ImportError:
        from starlette.exceptions import ExceptionMiddleware  # type: ignore[no-redef,attr-defined]
    return ExceptionMiddleware


def _call_code(cls: type) -> Any:
    call = getattr(cls, "__call__", None)
    return getattr(call, "__code__", None)


def _routes(app: Any) -> List[Route]:
    routes: List[Route] = []
    for route in app.routes:
        endpoint = getattr(route, "endpoint", None)
        methods = getattr(route, "methods", None)
        if endpoint is None or not methods:
            continue
        routes.append(Route(tuple(sorted(methods)), route.path, f"{endpoint.__module__}.{endpoint.__qualname__}"))
    return routes


def _http_request_line(frame: FrameType) -> Optional[Tuple[str, str]]:
    asgi_scope = frame.f_locals.get("scope")
    if not isinstance(asgi_scope, dict) or asgi_scope.get("type") != "http":
        return None
    return str(asgi_scope.get("method", "")), str(asgi_scope.get("path", ""))
