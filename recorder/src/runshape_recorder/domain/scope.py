"""Decides which running code is worth recording, and at what detail.

SOURCE and TEST code are recorded line by line. LANDMARK code (framework middleware,
routers) is recorded as calls only. BOUNDARY code is where the app leaves the process
(database drivers, HTTP clients) and is recorded as a single external call.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from types import CodeType, FrameType
from typing import Callable, Dict, Iterable, List, Optional, Tuple

from runshape_recorder.domain.events import CodeRole, LandmarkKind

RequestLine = Tuple[str, str]  # (method, path)


@dataclass(frozen=True)
class Boundary:
    module_prefix: str
    system: str
    # None means every public function in the module is traffic.
    operations: Optional[Tuple[str, ...]] = None

    def covers(self, module: str) -> bool:
        return module == self.module_prefix or module.startswith(self.module_prefix + ".")

    def is_traffic(self, function_name: str) -> bool:
        """Private helpers and lifecycle dunders (__init__, __aexit__) are not traffic."""
        if function_name.startswith("_"):
            return False
        return self.operations is None or function_name in self.operations


@dataclass(frozen=True)
class Landmark:
    kind: LandmarkKind
    describe_request: Optional[Callable[[FrameType], Optional[RequestLine]]] = None


# The module where traffic actually leaves the process, not the whole driver package:
# "django.db.backends" would also match SQL-building helpers like quote_name().
SQL_OPERATIONS = ("execute", "executemany", "fetch", "fetchrow", "fetchval", "callproc", "copy")
HTTP_OPERATIONS = ("request", "send", "get", "post", "put", "patch", "delete", "head", "options", "stream")
DEFAULT_BOUNDARIES = (
    Boundary("asyncpg.connection", "postgres", SQL_OPERATIONS),
    Boundary("psycopg.cursor", "postgres", SQL_OPERATIONS),
    Boundary("django.db.backends.utils", "database", SQL_OPERATIONS),
    Boundary("httpx._client", "http", HTTP_OPERATIONS),
    Boundary("requests", "http", HTTP_OPERATIONS),
    Boundary("redis.client", "redis", ("execute_command",)),
)


class CodeScope:
    def __init__(
        self,
        root: str,
        source_roots: Iterable[str],
        test_roots: Iterable[str],
        boundaries: Iterable[Boundary] = DEFAULT_BOUNDARIES,
    ) -> None:
        self.root = os.path.realpath(root)
        self._source_roots = [_as_dir(os.path.join(self.root, r)) for r in source_roots]
        self._test_roots = [_as_dir(os.path.join(self.root, r)) for r in test_roots]
        # Longest prefix first so "django.db.backends" wins over a hypothetical "django".
        self._boundaries = sorted(boundaries, key=lambda b: len(b.module_prefix), reverse=True)
        self._landmarks: Dict[CodeType, Landmark] = {}
        self._roles: Dict[CodeType, CodeRole] = {}
        self._project_classes: Dict[type, bool] = {}

    @property
    def source_roots(self) -> List[str]:
        return list(self._source_roots)

    @property
    def test_roots(self) -> List[str]:
        return list(self._test_roots)

    def register_landmark(self, code: CodeType, landmark: Landmark) -> None:
        self._landmarks[code] = landmark
        self._roles.pop(code, None)

    def add_boundary(self, boundary: Boundary) -> None:
        """Replaces any boundary on the same module, e.g. naming the system "sqlite"."""
        self._boundaries = [b for b in self._boundaries if b.module_prefix != boundary.module_prefix]
        self._boundaries.append(boundary)
        self._boundaries.sort(key=lambda b: len(b.module_prefix), reverse=True)
        self._roles.clear()

    def landmark_for(self, code: CodeType) -> Optional[Landmark]:
        return self._landmarks.get(code)

    def role_of(self, frame: FrameType) -> CodeRole:
        code = frame.f_code
        role = self._roles.get(code)
        if role is None:
            role = self._classify(code, frame.f_globals.get("__name__", ""))
            self._roles[code] = role
        return role

    def boundary_for(self, module: str) -> Optional[Boundary]:
        for boundary in self._boundaries:
            if boundary.covers(module):
                return boundary
        return None

    def is_project_class(self, cls: type) -> bool:
        known = self._project_classes.get(cls)
        if known is None:
            module = sys.modules.get(cls.__module__)
            file = getattr(module, "__file__", None)
            known = file is not None and _under_any(os.path.realpath(file), self._source_roots)
            self._project_classes[cls] = known
        return known

    def relative_path(self, filename: str) -> str:
        return os.path.relpath(os.path.realpath(filename), self.root)

    def _classify(self, code: CodeType, module: str) -> CodeRole:
        if code in self._landmarks:
            return CodeRole.LANDMARK
        filename = os.path.realpath(code.co_filename)
        if _under_any(filename, self._test_roots):
            return CodeRole.TEST
        if _under_any(filename, self._source_roots):
            return CodeRole.SOURCE
        if self.boundary_for(module) is not None:
            return CodeRole.BOUNDARY
        return CodeRole.OUTSIDE


def _as_dir(path: str) -> str:
    return os.path.realpath(path).rstrip(os.sep) + os.sep


def _under_any(filename: str, roots: List[str]) -> bool:
    for root in roots:
        if filename.startswith(root):
            return True
    return False
