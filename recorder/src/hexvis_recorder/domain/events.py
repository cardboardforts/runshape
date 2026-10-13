"""Everything a scenario recording is made of.

Events are NamedTuples rather than dataclasses because LineExecuted is created once per
executed line of project code; a NamedTuple keeps the hot path cheap and still named.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List, NamedTuple, Optional, Union


class CodeRole(Enum):
    SOURCE = "source"
    TEST = "test"
    LANDMARK = "landmark"
    BOUNDARY = "boundary"
    OUTSIDE = "outside"


class LandmarkKind(Enum):
    REQUEST_ENTRY = "request-entry"
    MIDDLEWARE = "middleware"
    ROUTER = "router"


class Phase(Enum):
    SETUP = "setup"
    CALL = "call"
    TEARDOWN = "teardown"


@dataclass(frozen=True)
class FunctionRef:
    key: str
    role: CodeRole
    module: str
    qualname: str
    file: Optional[str]
    first_line: int
    landmark_kind: Optional[LandmarkKind] = None


class PhaseStarted(NamedTuple):
    t_us: int
    phase: Phase


class SpanStarted(NamedTuple):
    t_us: int
    span: int
    function: int
    parent: Optional[int]
    thread: int
    obj: Optional[int]


class SpanResumed(NamedTuple):
    t_us: int
    span: int
    thread: int


class SpanExited(NamedTuple):
    t_us: int
    span: int


class LineExecuted(NamedTuple):
    span: int
    line: int


class ObjectCreated(NamedTuple):
    t_us: int
    obj: int
    cls: str
    span: Optional[int]


class ObjectWired(NamedTuple):
    t_us: int
    obj: int
    attribute: str
    target: int


class BoundaryCalled(NamedTuple):
    t_us: int
    span: Optional[int]
    system: str
    operation: str
    statement: Optional[str]


class RequestReceived(NamedTuple):
    t_us: int
    span: int
    method: str
    path: str


TraceEvent = Union[
    PhaseStarted,
    SpanStarted,
    SpanResumed,
    SpanExited,
    LineExecuted,
    ObjectCreated,
    ObjectWired,
    BoundaryCalled,
    RequestReceived,
]


@dataclass
class ScenarioRecording:
    nodeid: str
    outcome: str
    duration_us: int
    functions: List[FunctionRef]
    events: List[TraceEvent]
    recorder_errors: List[str] = field(default_factory=list)
