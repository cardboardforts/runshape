"""Tracing via sys.monitoring (PEP 669, Python 3.12+).

Preferred over settrace when available: code we don't care about is DISABLEd per
location after its first event, so the steady-state cost is near zero, and it coexists
with coverage.py because each tool gets its own id.
"""
from __future__ import annotations

import sys
from types import CodeType
from typing import Any, Optional

from hexvis_recorder.domain.events import CodeRole
from hexvis_recorder.domain.recorder import ScenarioRecorder

# Tool ids 0-2 and 5 are reserved by convention (debugger, coverage, profiler, optimizer).
CANDIDATE_TOOL_IDS = (3, 4)
TOOL_NAME = "hexvis"
LINE_RECORDING_ROLES = (CodeRole.SOURCE, CodeRole.TEST)
SPAN_RECORDING_ROLES = (CodeRole.SOURCE, CodeRole.TEST, CodeRole.LANDMARK)


def is_available() -> bool:
    return hasattr(sys, "monitoring")


class MonitoringBackend:
    name = "monitoring"

    def __init__(self) -> None:
        self._recorder: Optional[ScenarioRecorder] = None
        self._tool_id: Optional[int] = None

    def start(self, recorder: ScenarioRecorder) -> None:
        monitoring = sys.monitoring  # type: ignore[attr-defined]
        events = monitoring.events
        self._recorder = recorder
        self._tool_id = _claim_tool_id()
        callbacks = {
            events.PY_START: self._on_start,
            events.PY_RESUME: self._on_resume,
            # throw() (task cancellation, gen.close()) resumes a frame without PY_RESUME.
            events.PY_THROW: self._on_throw,
            events.PY_RETURN: self._on_exit,
            events.PY_YIELD: self._on_exit,
            events.PY_UNWIND: self._on_unwind,
            events.LINE: self._on_line,
        }
        for event, callback in callbacks.items():
            monitoring.register_callback(self._tool_id, event, callback)
        all_events = 0
        for event in callbacks:
            all_events |= event
        monitoring.set_events(self._tool_id, all_events)

    def stop(self) -> None:
        monitoring = sys.monitoring  # type: ignore[attr-defined]
        if self._tool_id is not None:
            monitoring.set_events(self._tool_id, 0)
            monitoring.free_tool_id(self._tool_id)
            # Re-enables every location we DISABLEd, for the next scenario and other tools.
            monitoring.restart_events()
        self._tool_id = None
        self._recorder = None

    def _on_start(self, code: CodeType, offset: int) -> Any:
        return self._enter(fresh=True)

    def _on_resume(self, code: CodeType, offset: int) -> Any:
        return self._enter(fresh=False)

    def _on_throw(self, code: CodeType, offset: int, exception: BaseException) -> Any:
        return self._enter(fresh=False)

    def _enter(self, fresh: bool) -> Any:
        recorder = self._recorder
        if recorder is None:
            return None
        try:
            frame = sys._getframe(2)
            role = recorder.role_of(frame)
            if role in SPAN_RECORDING_ROLES:
                recorder.enter(frame, role, fresh)
                return None
            if role is CodeRole.BOUNDARY and fresh:
                recorder.boundary(frame)
                return None
            return sys.monitoring.DISABLE  # type: ignore[attr-defined]
        except Exception as error:
            recorder.note_error(error)
            return None

    def _on_exit(self, code: CodeType, offset: int, value: Any) -> Any:
        return self._exit()

    def _on_unwind(self, code: CodeType, offset: int, exception: BaseException) -> Any:
        self._exit()
        return None  # PY_UNWIND cannot be disabled

    def _exit(self) -> Any:
        recorder = self._recorder
        if recorder is None:
            return None
        try:
            frame = sys._getframe(2)
            if recorder.role_of(frame) in SPAN_RECORDING_ROLES:
                recorder.exit(frame)
                return None
            return sys.monitoring.DISABLE  # type: ignore[attr-defined]
        except Exception as error:
            recorder.note_error(error)
            return None

    def _on_line(self, code: CodeType, line: int) -> Any:
        recorder = self._recorder
        if recorder is None:
            return None
        try:
            frame = sys._getframe(1)
            if recorder.role_of(frame) in LINE_RECORDING_ROLES:
                recorder.line(frame, line)
                return None
            return sys.monitoring.DISABLE  # type: ignore[attr-defined]
        except Exception as error:
            recorder.note_error(error)
            return None


def _claim_tool_id() -> int:
    monitoring = sys.monitoring  # type: ignore[attr-defined]
    for tool_id in CANDIDATE_TOOL_IDS:
        if monitoring.get_tool(tool_id) is None:
            monitoring.use_tool_id(tool_id, TOOL_NAME)
            return tool_id
    raise RuntimeError(f"hexvis: no free sys.monitoring tool id among {CANDIDATE_TOOL_IDS}")
