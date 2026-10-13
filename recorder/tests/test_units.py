"""Recorder pieces exercised directly, for behaviours the end-to-end sample can't reach."""
import importlib
import sys
import textwrap

import pytest

from runshape_recorder.adapters.settrace_backend import SettraceBackend
from runshape_recorder.adapters.source_catalog import SourceCatalog
from runshape_recorder.domain.events import SpanResumed, SpanStarted
from runshape_recorder.domain.recorder import ScenarioRecorder
from runshape_recorder.domain.scope import CodeScope

BACKENDS = [SettraceBackend]
if sys.version_info >= (3, 12):
    from runshape_recorder.adapters.monitoring_backend import MonitoringBackend

    BACKENDS.append(MonitoringBackend)


def write_package(root, package, files):
    for name, source in files.items():
        path = root / package / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(source))


def test_catalog_names_modules_the_way_python_imports_them_in_a_src_layout(tmp_path, monkeypatch):
    # With runshape_source = src, src/shop/orders.py is imported as shop.orders, not
    # src.shop.orders; the viewer matches catalog entries to recorded calls by that name.
    write_package(tmp_path / "src", "shop", {"__init__.py": "", "orders.py": "def total(): return 1\n"})
    monkeypatch.syspath_prepend(str(tmp_path / "src"))

    functions = SourceCatalog(str(tmp_path)).functions_under([str(tmp_path / "src")])

    assert [(f.module, f.qualname, f.lines) for f in functions] == [("shop.orders", "total", (1,))]


def test_a_one_line_function_still_has_its_one_executable_line(tmp_path):
    write_package(tmp_path, "pkg", {"__init__.py": "", "m.py": "def one(): return 1\n\ndef two():\n    return 2\n"})

    functions = SourceCatalog(str(tmp_path)).functions_under([str(tmp_path / "pkg")])

    assert {f.qualname: f.lines for f in functions} == {"one": (1,), "two": (4,)}


@pytest.mark.parametrize("backend_class", BACKENDS, ids=lambda b: b.name)
def test_closing_a_generator_counts_as_resuming_it_on_every_backend(tmp_path, monkeypatch, backend_class):
    # gen.close() / task.cancel() resume a suspended frame by throwing into it; its
    # cleanup code (finally, except CancelledError) runs then, and must not go missing.
    write_package(tmp_path, "gens", {"__init__.py": """
        def numbers():
            try:
                yield 1
            finally:
                pass

        def drive():
            numbers_left = numbers()
            next(numbers_left)
            numbers_left.close()
        """})
    monkeypatch.syspath_prepend(str(tmp_path))
    gens = importlib.import_module("gens")
    recorder = ScenarioRecorder(CodeScope(str(tmp_path), ["gens"], []), SourceCatalog(str(tmp_path)))
    backend = backend_class()

    recorder.begin("close")
    backend.start(recorder)
    try:
        gens.drive()
    finally:
        backend.stop()
    recording = recorder.finish("passed")

    numbers_span = next(e.span for e in recording.events if isinstance(e, SpanStarted) and recording.functions[e.function].qualname == "numbers")
    assert [e for e in recording.events if isinstance(e, SpanResumed) and e.span == numbers_span] != []
    assert recording.recorder_errors == []
    sys.modules.pop("gens", None)


def test_source_snapshot_keeps_python_line_numbers_and_only_project_files(tmp_path):
    # A form feed (common in older stdlib-style code) is a line break to str.splitlines()
    # but not to Python; snapshot line N must be the line Python calls N.
    write_package(tmp_path, "pkg", {"__init__.py": "", "m.py": "x = 1  # \x0c page break\ndef f():\n    return 2\n"})
    write_package(tmp_path, "vendor", {"__init__.py": "", "lib.py": "def g():\n    return 3\n"})
    catalog = SourceCatalog(str(tmp_path))
    catalog.functions_under([str(tmp_path / "pkg")])
    catalog._compile(str(tmp_path / "vendor" / "lib.py"))  # as qualname() does for framework code on 3.9/3.10

    sources = catalog.sources_under([str(tmp_path / "pkg")])

    assert sorted(sources) == ["pkg/__init__.py", "pkg/m.py"]
    assert sources["pkg/m.py"][2] == "    return 2"  # line 3
