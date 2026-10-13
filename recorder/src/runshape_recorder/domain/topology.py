"""The runtime shape of the app as its framework sees it: middleware order, routes, and
the external systems it is configured to talk to. Read once per session at startup."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple


@dataclass(frozen=True)
class Route:
    methods: Tuple[str, ...]
    path: str
    handler: str


@dataclass(frozen=True)
class ExternalSystem:
    name: str
    kind: str


@dataclass
class FrameworkTopology:
    framework: str
    entry: str
    middleware: List[str] = field(default_factory=list)
    router: Optional[str] = None
    routes: List[Route] = field(default_factory=list)
    externals: List[ExternalSystem] = field(default_factory=list)
