"""Recorder settings, read from pytest ini options and validated in one visible place.

Every problem is collected before failing so a misconfigured run reports all of them.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from enum import Enum
from typing import List, Optional

from hexvis_recorder.domain.scope import Boundary


class BackendChoice(Enum):
    AUTO = "auto"
    SETTRACE = "settrace"
    MONITORING = "monitoring"


class FrameworkChoice(Enum):
    AUTO = "auto"
    DJANGO = "django"
    FASTAPI = "fastapi"
    NONE = "none"


DEFAULT_OUT_DIRECTORY = ".hexvis/traces"
MONITORING_MIN_PYTHON = (3, 12)


@dataclass(frozen=True)
class RawSettings:
    """Exactly what the user wrote, before validation."""

    root: str
    source: List[str]
    tests: List[str]
    out: Optional[str]
    backend: str
    framework: str
    app: str
    boundaries: List[str]
    coverage_active: bool
    xdist_workers: int


@dataclass(frozen=True)
class RecorderSettings:
    root: str
    source_roots: List[str]
    test_roots: List[str]
    out_directory: str
    backend: BackendChoice
    framework: FrameworkChoice
    app_import_path: Optional[str]
    extra_boundaries: List[Boundary]


class SettingsError(Exception):
    def __init__(self, problems: List[str]) -> None:
        super().__init__("hexvis is misconfigured:\n  - " + "\n  - ".join(problems))
        self.problems = problems


def validate(raw: RawSettings) -> RecorderSettings:
    problems: List[str] = []

    if not raw.source:
        problems.append("hexvis_source is required: the directories holding your app's code (e.g. 'app').")
    for directory in raw.source + raw.tests:
        if not os.path.isdir(os.path.join(raw.root, directory)):
            problems.append(f"directory {directory!r} does not exist under {raw.root}")

    backend = _parse_enum(BackendChoice, raw.backend, "hexvis_backend", problems)
    if backend is BackendChoice.MONITORING and sys.version_info < MONITORING_MIN_PYTHON:
        problems.append("hexvis_backend=monitoring needs Python 3.12+; use 'settrace' or 'auto'.")
    uses_settrace = backend is BackendChoice.SETTRACE or (
        backend is BackendChoice.AUTO and sys.version_info < MONITORING_MIN_PYTHON
    )
    if uses_settrace and raw.coverage_active:
        problems.append("coverage is active and the settrace backend can't share the tracer; add --no-cov.")
    if raw.xdist_workers > 0:
        problems.append("recording across xdist workers isn't supported yet; add -n0.")

    framework = _parse_enum(FrameworkChoice, raw.framework, "hexvis_framework", problems)
    if framework is FrameworkChoice.FASTAPI and not raw.app:
        problems.append("hexvis_framework=fastapi needs hexvis_app = 'module:attribute' (e.g. app.main:app).")

    boundaries: List[Boundary] = []
    for line in raw.boundaries:
        prefix, separator, target = (part.strip() for part in line.partition("="))
        system, _, operation_list = (part.strip() for part in target.partition(":"))
        if not separator or not prefix or not system:
            problems.append(
                f"hexvis_boundaries entry {line!r} must look like 'module.prefix = system' "
                "or 'module.prefix = system: operation, operation'"
            )
            continue
        operations = tuple(op.strip() for op in operation_list.split(",") if op.strip()) or None
        boundaries.append(Boundary(prefix, system, operations))

    if problems:
        raise SettingsError(problems)
    assert backend is not None and framework is not None
    return RecorderSettings(
        root=raw.root,
        source_roots=raw.source,
        test_roots=raw.tests,
        out_directory=os.path.join(raw.root, raw.out or DEFAULT_OUT_DIRECTORY),
        backend=backend,
        framework=framework,
        app_import_path=raw.app or None,
        extra_boundaries=boundaries,
    )


def _parse_enum(enum: type, value: str, option: str, problems: List[str]):  # type: ignore[no-untyped-def]
    try:
        return enum(value)
    except ValueError:
        allowed = ", ".join(member.value for member in enum)
        problems.append(f"{option}={value!r} is not one of: {allowed}")
        return None
