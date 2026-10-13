"""pytest entry point and composition root: the only module that wires domain and adapters.

Each test becomes one recorded scenario. Run with:  pytest --runshape
"""
from __future__ import annotations

import os
import sys
import time
from typing import Any, Dict, Generator, List, Optional

import pytest

from runshape_recorder.adapters import monitoring_backend
from runshape_recorder.adapters.frameworks import django_introspector, fastapi_introspector
from runshape_recorder.adapters.json_store import JsonTraceStore
from runshape_recorder.adapters.monitoring_backend import MonitoringBackend
from runshape_recorder.adapters.settrace_backend import SettraceBackend
from runshape_recorder.adapters.source_catalog import SourceCatalog
from runshape_recorder.domain.events import Phase
from runshape_recorder.domain.recorder import ScenarioRecorder
from runshape_recorder.domain.scope import DEFAULT_BOUNDARIES, CodeScope
from runshape_recorder.domain.topology import FrameworkTopology
from runshape_recorder.settings import (
    BackendChoice,
    FrameworkChoice,
    RawSettings,
    RecorderSettings,
    SettingsError,
    validate,
)

PLUGIN_NAME = "runshape-recording-session"


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("runshape", "record execution traces for the Runshape viewer")
    group.addoption("--runshape", action="store_true", default=False, help="record one trace per test")
    group.addoption("--runshape-out", default=None, help="output directory (default .runshape/traces)")
    group.addoption("--runshape-run-name", default=None, help="name this run's directory (default: the start time)")
    parser.addini("runshape_source", type="args", default=[], help="directories with app code, traced line by line")
    parser.addini("runshape_tests", type="args", default=[], help="directories with test code")
    parser.addini("runshape_backend", default=BackendChoice.AUTO.value, help="auto | settrace | monitoring")
    parser.addini("runshape_framework", default=FrameworkChoice.AUTO.value, help="auto | django | fastapi | none")
    parser.addini("runshape_app", default="", help="ASGI app import path for FastAPI, e.g. app.main:app")
    parser.addini("runshape_boundaries", type="linelist", default=[], help="extra 'module.prefix = system' lines")


def pytest_configure(config: pytest.Config) -> None:
    if not config.getoption("runshape"):
        return
    raw = RawSettings(
        root=str(config.rootpath),
        source=list(config.getini("runshape_source")),
        tests=list(config.getini("runshape_tests")),
        out=config.getoption("runshape_out"),
        backend=config.getini("runshape_backend"),
        framework=config.getini("runshape_framework"),
        app=config.getini("runshape_app"),
        boundaries=list(config.getini("runshape_boundaries")),
        coverage_active=_coverage_active(config),
        xdist_workers=_xdist_workers(config),
    )
    try:
        settings = validate(raw)
    except SettingsError as error:
        raise pytest.UsageError(str(error)) from None

    scope = CodeScope(settings.root, settings.source_roots, settings.test_roots, DEFAULT_BOUNDARIES)
    for boundary in settings.extra_boundaries:
        scope.add_boundary(boundary)
    catalog = SourceCatalog(settings.root)
    session = RecordingSession(
        settings=settings,
        scope=scope,
        catalog=catalog,
        recorder=ScenarioRecorder(scope, catalog),
        backend=_choose_backend(settings.backend),
        store=JsonTraceStore(settings.out_directory, config.getoption("runshape_run_name")),
    )
    config.pluginmanager.register(session, PLUGIN_NAME)


class RecordingSession:
    def __init__(
        self,
        settings: RecorderSettings,
        scope: CodeScope,
        catalog: SourceCatalog,
        recorder: ScenarioRecorder,
        backend: Any,
        store: JsonTraceStore,
    ) -> None:
        self._settings = settings
        self._scope = scope
        self._catalog = catalog
        self._recorder = recorder
        self._backend = backend
        self._store = store
        self._topology: Optional[FrameworkTopology] = None
        self._framework_checked = False
        self._problems: List[str] = []
        self._outcomes: Dict[str, str] = {}
        self._started = time.perf_counter()
        self._manifest_path: Optional[str] = None

    @pytest.hookimpl(hookwrapper=True)
    def pytest_runtest_protocol(self, item: pytest.Item, nextitem: Optional[pytest.Item]) -> Generator[None, Any, None]:
        self._introspect_framework_once()
        if sys.gettrace() is not None and self._backend.name == SettraceBackend.name:
            self._problems.append(f"{item.nodeid}: another tracer (debugger?) is active; not recorded")
            yield
            return
        self._outcomes[item.nodeid] = "passed"
        self._recorder.begin(item.nodeid)
        try:
            self._backend.start(self._recorder)
        except Exception as error:  # never let recording break the test run
            self._problems.append(f"{item.nodeid}: tracing could not start, not recorded: {error}")
            yield
            return
        try:
            yield
        finally:
            self._backend.stop()
            recording = self._recorder.finish(self._outcomes.pop(item.nodeid, "unknown"))
            try:
                self._store.write_scenario(recording)
            except OSError as error:
                self._problems.append(f"{item.nodeid}: could not write its trace: {error}")

    @pytest.hookimpl(hookwrapper=True, tryfirst=True)
    def pytest_runtest_setup(self, item: pytest.Item) -> Generator[None, Any, None]:
        self._recorder.set_phase(Phase.SETUP)
        yield

    @pytest.hookimpl(hookwrapper=True, tryfirst=True)
    def pytest_runtest_call(self, item: pytest.Item) -> Generator[None, Any, None]:
        self._recorder.set_phase(Phase.CALL)
        yield

    @pytest.hookimpl(hookwrapper=True, tryfirst=True)
    def pytest_runtest_teardown(self, item: pytest.Item, nextitem: Optional[pytest.Item]) -> Generator[None, Any, None]:
        self._recorder.set_phase(Phase.TEARDOWN)
        yield

    def pytest_runtest_logreport(self, report: pytest.TestReport) -> None:
        if report.nodeid not in self._outcomes:
            return
        expected_to_fail = hasattr(report, "wasxfail")
        if report.failed:
            self._outcomes[report.nodeid] = "failed" if report.when == "call" else "error"
        elif report.skipped:
            self._outcomes[report.nodeid] = "xfailed" if expected_to_fail else "skipped"
        elif report.when == "call" and expected_to_fail:
            self._outcomes[report.nodeid] = "xpassed"

    def pytest_sessionfinish(self, session: pytest.Session, exitstatus: int) -> None:
        directories = [os.path.join(self._settings.root, d) for d in self._settings.source_roots + self._settings.test_roots]
        self._manifest_path = self._store.write_manifest(
            root=self._settings.root,
            backend=self._backend.name,
            topology=self._topology,
            catalog=self._catalog.functions_under(directories),
            sources=self._catalog.sources_under(directories),
            catalog_problems=self._catalog.problems,
            session_problems=self._problems,
        )

    def pytest_terminal_summary(self, terminalreporter: Any) -> None:
        scenarios = self._store.summary.scenarios
        events = sum(s.event_count for s in scenarios)
        recorder_errors = sum(s.recorder_errors for s in scenarios)
        framework = self._topology.framework if self._topology else "none"
        terminalreporter.write_sep("-", "runshape")
        terminalreporter.write_line(
            f"runshape: recorded {len(scenarios)} scenarios, {events} events "
            f"(backend={self._backend.name}, framework={framework}, "
            f"recorder_errors={recorder_errors}, {time.perf_counter() - self._started:.1f}s)"
        )
        terminalreporter.write_line(f"runshape: manifest {self._manifest_path}")
        for problem in self._problems + [f"{p.file}: {p.reason}" for p in self._catalog.problems]:
            terminalreporter.write_line(f"runshape: WARNING {problem}", yellow=True)

    def _introspect_framework_once(self) -> None:
        if self._framework_checked:
            return
        self._framework_checked = True
        choice = self._settings.framework
        try:
            if choice is FrameworkChoice.FASTAPI or (choice is FrameworkChoice.AUTO and self._settings.app_import_path):
                app = fastapi_introspector.load_app(self._settings.app_import_path or "")
                self._topology = fastapi_introspector.introspect(app, self._scope)
            elif choice in (FrameworkChoice.DJANGO, FrameworkChoice.AUTO) and django_introspector.is_configured():
                self._topology = django_introspector.introspect(self._scope)
            elif choice is FrameworkChoice.DJANGO:
                self._problems.append("runshape_framework=django but Django settings are not configured")
        except Exception as error:  # degrade: record without framework landmarks, but say so loudly
            self._problems.append(f"framework introspection failed ({choice.value}): {type(error).__name__}: {error}")


def _choose_backend(choice: BackendChoice) -> Any:
    if choice is BackendChoice.SETTRACE:
        return SettraceBackend()
    if choice is BackendChoice.MONITORING or monitoring_backend.is_available():
        return MonitoringBackend()
    return SettraceBackend()


def _coverage_active(config: pytest.Config) -> bool:
    return config.pluginmanager.hasplugin("_cov") and not config.getoption("no_cov", default=False)


def _xdist_workers(config: pytest.Config) -> int:
    workers = config.getoption("numprocesses", default=None)
    if workers in (None, 0, "0"):
        return 0
    # "auto" and "logical" resolve to a count later; any of them means parallel workers.
    return 1 if isinstance(workers, str) else int(workers)

