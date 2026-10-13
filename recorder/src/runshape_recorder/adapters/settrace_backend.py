"""Tracing via sys.settrace — works on every supported Python (3.9+).

Limitations: only one settrace tracer can be active, so coverage.py's tracer must be off;
threads that already existed when tracing started (e.g. a warm thread pool) are not traced.
"""
from __future__ import annotations

import dis
import sys
import threading
from types import CodeType, FrameType
from typing import Any, Callable, Dict, Optional

from runshape_recorder.domain.events import CodeRole
from runshape_recorder.domain.recorder import GENERATOR_LIKE_FLAGS, ScenarioRecorder

TraceFunction = Callable[[FrameType, str, Any], Optional["TraceFunction"]]

_RESUME_OPCODE = dis.opmap.get("RESUME")
_first_resume_offsets: Dict[CodeType, int] = {}


def is_fresh_entry(frame: FrameType) -> bool:
    """settrace reports both a first call and a coroutine resume as "call"."""
    code = frame.f_code
    if not code.co_flags & GENERATOR_LIKE_FLAGS:
        return True
    if _RESUME_OPCODE is None:  # < 3.11: a frame that has run no instruction yet
        return frame.f_lasti < 0
    return frame.f_lasti <= _first_resume_offset(code)


def _first_resume_offset(code: CodeType) -> int:
    offset = _first_resume_offsets.get(code)
    if offset is None:
        offset = next(i.offset for i in dis.get_instructions(code) if i.opcode == _RESUME_OPCODE)
        _first_resume_offsets[code] = offset
    return offset


class SettraceBackend:
    name = "settrace"

    def __init__(self) -> None:
        self._recorder: Optional[ScenarioRecorder] = None

    def start(self, recorder: ScenarioRecorder) -> None:
        self._recorder = recorder
        threading.settrace(self._on_call)
        sys.settrace(self._on_call)

    def stop(self) -> None:
        sys.settrace(None)
        threading.settrace(None)  # type: ignore[arg-type]
        self._recorder = None

    def _on_call(self, frame: FrameType, event: str, arg: Any) -> Optional[TraceFunction]:
        recorder = self._recorder
        if event != "call" or recorder is None:
            return None
        try:
            role = recorder.role_of(frame)
            if role is CodeRole.OUTSIDE:
                return None
            if role is CodeRole.BOUNDARY:
                if is_fresh_entry(frame):
                    recorder.boundary(frame)
                return None
            recorder.enter(frame, role, fresh=is_fresh_entry(frame))
            if role is CodeRole.LANDMARK:
                frame.f_trace_lines = False
            return self._on_local
        except Exception as error:  # a tracer must never break the program it observes
            recorder.note_error(error)
            return None

    def _on_local(self, frame: FrameType, event: str, arg: Any) -> Optional[TraceFunction]:
        recorder = self._recorder
        if recorder is None:
            return None
        try:
            if event == "line":
                recorder.line(frame, frame.f_lineno)
            elif event == "return":
                recorder.exit(frame)
        except Exception as error:
            recorder.note_error(error)
        return self._on_local
