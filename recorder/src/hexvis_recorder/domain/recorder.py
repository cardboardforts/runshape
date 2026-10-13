"""Turns raw interpreter callbacks into a ScenarioRecording.

Tracing backends (settrace, sys.monitoring) translate their own callback shapes into the
five calls below — enter, exit, line, boundary, note_error — so this class never knows
which backend is driving it.
"""
from __future__ import annotations

import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass
from types import CodeType, FrameType
from typing import Callable, Dict, List, Optional, Protocol, Tuple

from hexvis_recorder.domain.events import (
    BoundaryCalled,
    CodeRole,
    FunctionRef,
    LineExecuted,
    ObjectCreated,
    ObjectWired,
    Phase,
    PhaseStarted,
    RequestReceived,
    ScenarioRecording,
    SpanExited,
    SpanResumed,
    SpanStarted,
    TraceEvent,
)
from hexvis_recorder.domain.scope import CodeScope

MAX_STATEMENT_CHARS = 500
HTTP_SYSTEM = "http"
MAX_RECORDED_ERRORS = 20
# Bounds the parent search so a pathological stack can't stall the traced program.
MAX_PARENT_SEARCH_DEPTH = 256

GENERATOR_LIKE_FLAGS = 0x20 | 0x80 | 0x200  # CO_GENERATOR | CO_COROUTINE | CO_ASYNC_GENERATOR

# The span running in the current context, as (scenario generation, span). asyncio.to_thread
# and anyio's threadpool copy the context into the worker thread, so work handed to another
# thread can still find the span that handed it off. The generation stops a stale value from
# an earlier scenario being mistaken for a span of this one.
_CURRENT_SPAN: "ContextVar[Optional[Tuple[int, int]]]" = ContextVar("hexvis_current_span", default=None)


class CodeNamer(Protocol):
    def qualname(self, code: CodeType) -> str: ...


@dataclass
class _ActiveSpan:
    span: int
    code: CodeType
    role: CodeRole
    parent: Optional[int]
    obj: Optional[int]
    creates_obj: bool
    # The context's current span before this one started; restored when it stops, so a
    # pool thread doesn't keep a finished job's parent for the next, unrelated job.
    context_before: Optional[Tuple[int, int]]


class ScenarioRecorder:
    def __init__(
        self,
        scope: CodeScope,
        namer: CodeNamer,
        clock_ns: Callable[[], int] = time.perf_counter_ns,
        thread_ident: Callable[[], int] = threading.get_ident,
    ) -> None:
        self.scope = scope
        self._namer = namer
        self._clock_ns = clock_ns
        self._thread_ident = thread_ident
        self._reset("")

    def begin(self, nodeid: str) -> None:
        self._reset(nodeid)

    def set_phase(self, phase: Phase) -> None:
        self._events.append(PhaseStarted(self._now_us(), phase))

    def finish(self, outcome: str) -> ScenarioRecording:
        return ScenarioRecording(
            nodeid=self._nodeid,
            outcome=outcome,
            duration_us=self._now_us(),
            functions=self._functions,
            events=self._events,
            recorder_errors=self._errors,
        )

    def role_of(self, frame: FrameType) -> CodeRole:
        return self.scope.role_of(frame)

    def enter(self, frame: FrameType, role: CodeRole, fresh: bool) -> None:
        if not fresh:
            active = self._active_span(frame)
            if active is not None:
                _CURRENT_SPAN.set((self._generation, active.span))
                self._events.append(SpanResumed(self._now_us(), active.span, self._thread()))
                return
            # Resumed a coroutine that started before recording did; treat it as new.

        landmark_label, obj, creates_obj = self._identify_receiver(frame, role)
        function = self._function_index(frame, role, landmark_label)
        thread = self._thread()
        caller = self._nearest_active(frame.f_back)
        parent = caller.span if caller is not None else self._span_that_handed_off()
        span = self._next_span
        self._next_span += 1
        self._spans[id(frame)] = _ActiveSpan(span, frame.f_code, role, parent, obj, creates_obj, _CURRENT_SPAN.get())
        _CURRENT_SPAN.set((self._generation, span))
        now = self._now_us()
        self._events.append(SpanStarted(now, span, function, parent, thread, obj))
        if creates_obj and obj is not None:
            cls = type(frame.f_locals["self"])
            self._events.append(ObjectCreated(now, obj, _class_name(cls), span))
        if role is CodeRole.LANDMARK:
            self._describe_request(frame, span, now)

    def exit(self, frame: FrameType) -> None:
        active = self._active_span(frame)
        if active is None:
            return
        self._events.append(SpanExited(self._now_us(), active.span))
        _CURRENT_SPAN.set(active.context_before)
        if active.creates_obj and active.obj is not None:
            self._record_wiring(active.obj, frame.f_locals.get("self"))
        if not frame.f_code.co_flags & GENERATOR_LIKE_FLAGS:
            del self._spans[id(frame)]

    def line(self, frame: FrameType, lineno: int) -> None:
        active = self._active_span(frame)
        if active is not None:
            self._events.append(LineExecuted(active.span, lineno))

    def boundary(self, frame: FrameType) -> None:
        module = frame.f_globals.get("__name__", "")
        boundary = self.scope.boundary_for(module)
        if boundary is None or not boundary.is_traffic(frame.f_code.co_name):
            return
        if self._called_from_same_system(frame.f_back, boundary.system):
            return
        caller = self._nearest_active(frame.f_back)
        if caller is not None and caller.role is CodeRole.TEST:
            # The test harness's own traffic: its HTTP client *is* the inbound request,
            # and fixture/assertion queries aren't something the app did.
            return
        self._events.append(
            BoundaryCalled(
                self._now_us(),
                caller.span if caller is not None else None,
                boundary.system,
                f"{module}.{self._namer.qualname(frame.f_code)}",
                _statement_argument(frame, strip_query=boundary.system == HTTP_SYSTEM),
            )
        )

    def note_error(self, error: BaseException) -> None:
        if len(self._errors) < MAX_RECORDED_ERRORS:
            self._errors.append(f"{type(error).__name__}: {error}")

    def _reset(self, nodeid: str) -> None:
        self._nodeid = nodeid
        self._started_ns = self._clock_ns()
        self._events: List[TraceEvent] = []
        self._functions: List[FunctionRef] = []
        self._function_ids: Dict[Tuple[CodeType, Optional[str]], int] = {}
        self._spans: Dict[int, _ActiveSpan] = {}
        self._next_span = 0
        self._objects: Dict[int, int] = {}
        # Holding the objects keeps id() stable for the scenario (no reuse by a new object).
        # Cost: their finalizers run after the scenario, not mid-test. Released at begin().
        self._object_refs: List[object] = []
        self._threads: Dict[int, int] = {}
        self._generation = getattr(self, "_generation", 0) + 1
        self._errors: List[str] = []

    def _now_us(self) -> int:
        return (self._clock_ns() - self._started_ns) // 1000

    def _thread(self) -> int:
        ident = self._thread_ident()
        thread = self._threads.get(ident)
        if thread is None:
            thread = len(self._threads)
            self._threads[ident] = thread
        return thread

    def _active_span(self, frame: FrameType) -> Optional[_ActiveSpan]:
        active = self._spans.get(id(frame))
        if active is None or active.code is not frame.f_code:
            return None
        return active

    def _nearest_active(self, frame: Optional[FrameType]) -> Optional[_ActiveSpan]:
        depth = 0
        while frame is not None and depth < MAX_PARENT_SEARCH_DEPTH:
            active = self._active_span(frame)
            if active is not None:
                return active
            frame = frame.f_back
            depth += 1
        return None

    def _span_that_handed_off(self) -> Optional[int]:
        """No recorded caller on this stack: the work may have been handed over from another
        thread (asyncio.to_thread, FastAPI running a sync dependency in its threadpool)."""
        handed = _CURRENT_SPAN.get()
        if handed is None or handed[0] != self._generation:
            return None
        return handed[1]

    def _called_from_same_system(self, frame: Optional[FrameType], system: str) -> bool:
        if frame is None:
            return False
        boundary = self.scope.boundary_for(frame.f_globals.get("__name__", ""))
        return boundary is not None and boundary.system == system

    def _identify_receiver(
        self, frame: FrameType, role: CodeRole
    ) -> Tuple[Optional[str], Optional[int], bool]:
        """Returns (landmark label, receiving object, whether this call creates it)."""
        receiver = _method_receiver(frame)
        if role is CodeRole.LANDMARK:
            label = type(receiver).__name__ if receiver is not None else None
            return label, None, False
        if receiver is None or not self.scope.is_project_class(type(receiver)):
            return None, None, False
        known = self._objects.get(id(receiver))
        if known is not None:
            return None, known, False
        obj = self._register_object(receiver)
        if frame.f_code.co_name == "__init__":
            return None, obj, True
        # First seen mid-life: it was built before recording started (e.g. at app startup).
        self._events.append(ObjectCreated(self._now_us(), obj, _class_name(type(receiver)), None))
        return None, obj, False

    def _register_object(self, receiver: object) -> int:
        obj = len(self._object_refs)
        self._objects[id(receiver)] = obj
        self._object_refs.append(receiver)
        return obj

    def _record_wiring(self, obj: int, receiver: object) -> None:
        attributes = getattr(receiver, "__dict__", None)
        if not isinstance(attributes, dict):
            return
        for attribute, value in list(attributes.items()):
            target = self._objects.get(id(value))
            if target is None and self.scope.is_project_class(type(value)):
                target = self._register_object(value)
                self._events.append(ObjectCreated(self._now_us(), target, _class_name(type(value)), None))
            if target is not None and target != obj:
                self._events.append(ObjectWired(self._now_us(), obj, attribute, target))

    def _function_index(self, frame: FrameType, role: CodeRole, landmark_label: Optional[str]) -> int:
        code = frame.f_code
        cache_key = (code, landmark_label)
        index = self._function_ids.get(cache_key)
        if index is not None:
            return index
        module = frame.f_globals.get("__name__", "")
        qualname = self._namer.qualname(code)
        if role is CodeRole.LANDMARK:
            landmark = self.scope.landmark_for(code)
            kind = landmark.kind if landmark is not None else None
            name = landmark_label or qualname
            ref = FunctionRef(f"landmark:{kind.value if kind else '?'}:{name}", role, module, name, None, code.co_firstlineno, kind)
        else:
            ref = FunctionRef(
                f"{module}:{qualname}",
                role,
                module,
                qualname,
                self.scope.relative_path(code.co_filename),
                code.co_firstlineno,
            )
        index = len(self._functions)
        self._functions.append(ref)
        self._function_ids[cache_key] = index
        return index

    def _describe_request(self, frame: FrameType, span: int, now: int) -> None:
        landmark = self.scope.landmark_for(frame.f_code)
        if landmark is None or landmark.describe_request is None:
            return
        request_line = landmark.describe_request(frame)
        if request_line is not None:
            self._events.append(RequestReceived(now, span, request_line[0], request_line[1]))


def _method_receiver(frame: FrameType) -> Optional[object]:
    code = frame.f_code
    if code.co_argcount == 0 or code.co_varnames[0] != "self":
        return None
    return frame.f_locals.get("self")


def _class_name(cls: type) -> str:
    return f"{cls.__module__}.{cls.__qualname__}"


def _statement_argument(frame: FrameType, strip_query: bool) -> Optional[str]:
    """The SQL text or URL a driver was given. Never bound parameters; never URL query
    strings, which routinely carry API keys."""
    code = frame.f_code
    first_data_arg = 1 if code.co_argcount > 1 and code.co_varnames[0] == "self" else 0
    if code.co_argcount <= first_data_arg:
        return None
    value = frame.f_locals.get(code.co_varnames[first_data_arg])
    if not isinstance(value, str):
        return None
    if strip_query:
        value = value.split("?", 1)[0]
    return value[:MAX_STATEMENT_CHARS]
