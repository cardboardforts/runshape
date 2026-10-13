"""Writes recordings in the runshape trace format (docs/trace-format.md).

Events are written as tagged arrays, not objects: a scenario holds tens of thousands of
line events and the key names would dominate the file. The viewer maps them back to
named types at its own boundary.
"""
from __future__ import annotations

import json
import os
import platform
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from runshape_recorder.adapters.source_catalog import CatalogFunction, CatalogProblem
from runshape_recorder.domain.events import (
    BoundaryCalled,
    FunctionRef,
    LineExecuted,
    ObjectCreated,
    ObjectWired,
    PhaseStarted,
    RequestReceived,
    ScenarioRecording,
    SpanExited,
    SpanResumed,
    SpanStarted,
    TraceEvent,
)
from runshape_recorder.domain.topology import FrameworkTopology

FORMAT_NAME = "runshape-trace"
FORMAT_VERSION = 1
LATEST_POINTER = "latest.json"
# The run latest.json pointed at before this one: the baseline for "what changed".
PREVIOUS_POINTER = "previous.json"


@dataclass
class ScenarioIndexEntry:
    nodeid: str
    file: str
    outcome: str
    duration_us: int
    event_count: int
    recorder_errors: int


@dataclass
class RunSummary:
    run_directory: str
    scenarios: List[ScenarioIndexEntry] = field(default_factory=list)


class JsonTraceStore:
    def __init__(self, out_directory: str, run_name: Optional[str] = None) -> None:
        self._out = os.path.realpath(out_directory)
        self._run_name = _unused_name(self._out, run_name or time.strftime("%Y%m%d-%H%M%S"))
        self.summary = RunSummary(os.path.join(self._out, self._run_name))

    def write_scenario(self, recording: ScenarioRecording) -> ScenarioIndexEntry:
        index = len(self.summary.scenarios) + 1
        relative = os.path.join("scenarios", f"{index:04d}.json")
        _write_json(
            os.path.join(self.summary.run_directory, relative),
            {
                "nodeid": recording.nodeid,
                "outcome": recording.outcome,
                "durationUs": recording.duration_us,
                "functions": [_function(ref) for ref in recording.functions],
                "events": [_event(event) for event in recording.events],
                "recorderErrors": recording.recorder_errors,
            },
        )
        entry = ScenarioIndexEntry(
            recording.nodeid,
            relative,
            recording.outcome,
            recording.duration_us,
            len(recording.events),
            len(recording.recorder_errors),
        )
        self.summary.scenarios.append(entry)
        return entry

    def write_manifest(
        self,
        root: str,
        backend: str,
        topology: Optional[FrameworkTopology],
        catalog: List[CatalogFunction],
        sources: Dict[str, List[str]],
        catalog_problems: List[CatalogProblem],
        session_problems: List[str],
    ) -> str:
        path = os.path.join(self.summary.run_directory, "manifest.json")
        _write_json(
            path,
            {
                "format": FORMAT_NAME,
                "version": FORMAT_VERSION,
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "python": platform.python_version(),
                "recorder": _recorder_version(),
                "backend": backend,
                "root": root,
                "framework": _topology(topology),
                "catalog": [_catalog_function(f) for f in catalog],
                "sources": sources,
                "catalogProblems": [{"file": p.file, "reason": p.reason} for p in catalog_problems],
                "sessionProblems": session_problems,
                "scenarios": [
                    {
                        "nodeid": s.nodeid,
                        "file": s.file,
                        "outcome": s.outcome,
                        "durationUs": s.duration_us,
                        "eventCount": s.event_count,
                        "recorderErrors": s.recorder_errors,
                    }
                    for s in self.summary.scenarios
                ],
            },
        )
        latest_path = os.path.join(self._out, LATEST_POINTER)
        previous_run = _read_run_pointer(latest_path)
        if previous_run is not None and previous_run != self._run_name:
            _write_json(os.path.join(self._out, PREVIOUS_POINTER), {"run": previous_run})
        _write_json(latest_path, {"run": self._run_name})
        return path


def _write_json(path: str, payload: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
    os.replace(temporary, path)  # readers never see a half-written file


def _recorder_version() -> str:
    try:
        from importlib.metadata import version

        return version("runshape-recorder")
    except Exception:  # running from a source checkout without installed metadata
        return "unknown"


def _unused_name(directory: str, wanted: str) -> str:
    """Two runs started in the same second must not share (and mix) one directory."""
    name, suffix = wanted, 1
    while os.path.exists(os.path.join(directory, name)):
        suffix += 1
        name = f"{wanted}-{suffix}"
    return name


def _read_run_pointer(path: str) -> Optional[str]:
    try:
        with open(path, encoding="utf-8") as handle:
            run = json.load(handle).get("run")
    except (OSError, ValueError, AttributeError):
        return None
    return run if isinstance(run, str) else None


def _function(ref: FunctionRef) -> Dict[str, Any]:
    return {
        "key": ref.key,
        "role": ref.role.value,
        "module": ref.module,
        "qualname": ref.qualname,
        "file": ref.file,
        "firstLine": ref.first_line,
        "landmarkKind": ref.landmark_kind.value if ref.landmark_kind else None,
    }


def _event(event: TraceEvent) -> List[Any]:
    if isinstance(event, LineExecuted):
        return ["L", event.span, event.line]
    if isinstance(event, SpanStarted):
        return ["S", event.t_us, event.span, event.function, event.parent, event.thread, event.obj]
    if isinstance(event, SpanExited):
        return ["X", event.t_us, event.span]
    if isinstance(event, SpanResumed):
        return ["R", event.t_us, event.span, event.thread]
    if isinstance(event, BoundaryCalled):
        return ["B", event.t_us, event.span, event.system, event.operation, event.statement]
    if isinstance(event, ObjectCreated):
        return ["O", event.t_us, event.obj, event.cls, event.span]
    if isinstance(event, ObjectWired):
        return ["W", event.t_us, event.obj, event.attribute, event.target]
    if isinstance(event, RequestReceived):
        return ["Q", event.t_us, event.span, event.method, event.path]
    if isinstance(event, PhaseStarted):
        return ["P", event.t_us, event.phase.value]
    raise TypeError(f"unknown trace event {type(event).__name__}")


def _catalog_function(function: CatalogFunction) -> Dict[str, Any]:
    return {
        "file": function.file,
        "module": function.module,
        "qualname": function.qualname,
        "firstLine": function.first_line,
        "lastLine": function.last_line,
        "lines": list(function.lines),
    }


def _topology(topology: Optional[FrameworkTopology]) -> Optional[Dict[str, Any]]:
    if topology is None:
        return None
    return {
        "framework": topology.framework,
        "entry": topology.entry,
        "middleware": topology.middleware,
        "router": topology.router,
        "routes": [{"methods": list(r.methods), "path": r.path, "handler": r.handler} for r in topology.routes],
        "externals": [{"name": e.name, "kind": e.kind} for e in topology.externals],
    }
