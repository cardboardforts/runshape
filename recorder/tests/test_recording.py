"""End-to-end: run the sample shop's own test suite with --runshape and read back the traces.

The sample shop is a tiny hexagonal app (tests/sample_shop): a composition root wires an
OrderService to a SqlOrderRepository adapter, which talks to `fakedb` — configured as a
"postgres" boundary whose only traffic is execute(). Each of its tests becomes one
scenario file. Both tracing backends
must produce the same recording; on Python < 3.12 only settrace exists.
"""
import json
import pathlib
import shutil
import sys
from textwrap import dedent

import pytest

from trace_text import call_tree

SAMPLE_SHOP = pathlib.Path(__file__).parent / "sample_shop"
BACKENDS = ["settrace"] + (["monitoring"] if sys.version_info >= (3, 12) else [])


@pytest.fixture
def shop(pytester):
    shutil.copytree(SAMPLE_SHOP, pytester.path, dirs_exist_ok=True)
    return pytester


def record(shop, *args):
    result = shop.runpytest_subprocess("--runshape", *args)
    traces = shop.path / ".runshape" / "traces"
    run_directory = traces / json.loads((traces / "latest.json").read_text())["run"]
    manifest = json.loads((run_directory / "manifest.json").read_text())
    scenarios = {s["nodeid"]: json.loads((run_directory / s["file"]).read_text()) for s in manifest["scenarios"]}
    return result, manifest, scenarios


@pytest.mark.parametrize("backend", BACKENDS)
def test_each_test_becomes_a_scenario_with_calls_objects_wiring_and_boundaries(shop, backend):
    result, manifest, scenarios = record(shop, "-o", f"runshape_backend={backend}")

    result.assert_outcomes(passed=4, xfailed=1)
    assert manifest["backend"] == backend
    # A known bug (xfail) is recorded like any test but must not read as a pass or a skip.
    assert [s["outcome"] for s in manifest["scenarios"]] == ["passed"] * 4 + ["xfailed"]
    assert all(s["recorderErrors"] == 0 for s in manifest["scenarios"])

    # The composition root shows up as wiring: OrderService holds the repository adapter.
    # Of the driver, only execute() is traffic: not is_closed() (housekeeping), not _send()
    # (nested inside execute), and not the test's own SELECT (the harness, not the app).
    # SQL text is kept, bound parameters never are. Order.total runs inside save()
    # before execute() is called, so it is listed first.
    assert call_tree(scenarios["tests/test_orders.py::test_place_order"]) == dedent(
        """
        test_place_order
          compose
            SqlOrderRepository.__init__ @SqlOrderRepository#0
              + new SqlOrderRepository#0
            OrderService.__init__ @OrderService#1
              + new OrderService#1
              ~ OrderService#1.repository -> SqlOrderRepository#0
          OrderService.place_order @OrderService#1
            Order.__init__ @Order#2
              + new Order#2
            SqlOrderRepository.save @SqlOrderRepository#0
              Order.total @Order#2
              => postgres: fakedb.FakeDb.execute('INSERT INTO orders (total) VALUES (?)')
          Order.total @Order#2
        """
    ).strip()

    # A coroutine that suspends once is one span, resumed — not two calls.
    assert call_tree(scenarios["tests/test_orders.py::test_place_order_later"]) == dedent(
        """
        test_place_order_later
          compose
            SqlOrderRepository.__init__ @SqlOrderRepository#0
              + new SqlOrderRepository#0
            OrderService.__init__ @OrderService#1
              + new OrderService#1
              ~ OrderService#1.repository -> SqlOrderRepository#0
          OrderService.place_order_later @OrderService#1 (resumed x1)
            OrderService.place_order @OrderService#1
              Order.__init__ @Order#2
                + new Order#2
              SqlOrderRepository.save @SqlOrderRepository#0
                Order.total @Order#2
                => postgres: fakedb.FakeDb.execute('INSERT INTO orders (total) VALUES (?)')
          Order.total @Order#2
        """
    ).strip()


@pytest.mark.parametrize("backend", BACKENDS)
def test_work_handed_to_another_thread_stays_under_the_span_that_handed_it_off(shop, backend):
    _, _, scenarios = record(shop, "-o", f"runshape_backend={backend}")

    # place_order runs on a worker thread, so its own stack has no recorded caller. The
    # recorder parents it to the span most recently running on another thread — the
    # coroutine awaiting the worker. This is what keeps FastAPI's sync dependencies
    # (run in a threadpool) inside the request that needed them.
    tree = call_tree(scenarios["tests/test_orders.py::test_place_order_in_worker_thread"])
    assert tree.splitlines()[7:] == [
        "  OrderService.place_order_in_worker_thread @OrderService#1 (resumed x1)",
        "    OrderService.place_order @OrderService#1",
        "      Order.__init__ @Order#2",
        "        + new Order#2",
        "      SqlOrderRepository.save @SqlOrderRepository#0",
        "        Order.total @Order#2",
        "        => postgres: fakedb.FakeDb.execute('INSERT INTO orders (total) VALUES (?)')",
        "  Order.total @Order#2",
    ]


@pytest.mark.parametrize("backend", BACKENDS)
def test_line_events_show_which_branch_each_scenario_took(shop, backend):
    _, _, scenarios = record(shop, "-o", f"runshape_backend={backend}")

    # place_order: line 11 is the empty-items guard, 12 its early return.
    rejected = call_tree(scenarios["tests/test_orders.py::test_rejects_empty_order"], show_lines=True)
    assert "OrderService.place_order @OrderService#1 lines=[11, 12]" in rejected

    # Order.total: [4, 7] sums to 11, over the bulk threshold, so the discount line (13) runs.
    placed = call_tree(scenarios["tests/test_orders.py::test_place_order"], show_lines=True)
    assert "Order.total @Order#2 lines=[11, 12, 13]" in placed


def test_manifest_catalogs_every_project_function_including_uncalled_ones(shop):
    _, manifest, _ = record(shop)

    by_name = {f["qualname"]: f for f in manifest["catalog"] if f["file"].startswith("shop")}
    # OrderRepository.save is abstract and never runs; it is still on the floor plan.
    assert sorted(by_name) == [
        "Order.__init__",
        "Order.total",
        "OrderRepository.save",
        "OrderService.__init__",
        "OrderService.place_order",
        "OrderService.place_order_in_worker_thread",
        "OrderService.place_order_later",
        "SqlOrderRepository.__init__",
        "SqlOrderRepository.save",
        "compose",
    ]
    assert by_name["Order.total"] == {
        "file": "shop/domain.py",
        "module": "shop.domain",
        "qualname": "Order.total",
        "firstLine": 10,
        "lastLine": 14,
        "lines": [11, 12, 13, 14],
    }
    assert manifest["framework"] is None
    # The source as it was when recorded, for comparing runs by code rather than line numbers.
    assert manifest["sources"]["shop/domain.py"][9:13] == [
        "    def total(self):",
        "        subtotal = sum(self.items)",
        "        if subtotal >= BULK_DISCOUNT_THRESHOLD:",
        "            return subtotal - 1",
    ]


def test_each_run_remembers_the_one_before_it_as_the_baseline_for_comparison(shop):
    traces = shop.path / ".runshape" / "traces"
    record(shop)
    first_run = json.loads((traces / "latest.json").read_text())["run"]

    # Usually within the same second: run directories are named by time, so this also
    # checks the second run gets its own directory instead of writing into the first.
    record(shop)
    second_run = json.loads((traces / "latest.json").read_text())["run"]

    assert second_run != first_run
    assert json.loads((traces / "previous.json").read_text()) == {"run": first_run}
    assert len(list((traces / first_run / "scenarios").iterdir())) == 5


def test_misconfiguration_reports_every_problem_at_once(shop):
    result = shop.runpytest_subprocess(
        "--runshape",
        "-o", "runshape_source=",
        "-o", "runshape_backend=fast",
        "-o", "runshape_boundaries=nonsense",
    )

    assert result.ret == pytest.ExitCode.USAGE_ERROR
    result.stderr.fnmatch_lines(
        [
            "*runshape is misconfigured:",
            "*runshape_source is required*",
            "*runshape_backend='fast' is not one of: auto, settrace, monitoring",
            "*runshape_boundaries entry 'nonsense' must look like 'module.prefix = system' or*",
        ]
    )


def test_runshape_run_records_whether_or_not_the_plugin_is_installed(shop, monkeypatch):
    # Runshape's CLI runs `python -m runshape_recorder.run` with the recorder on PYTHONPATH and
    # the project's own interpreter, where the plugin may or may not be installed. Here it is
    # installed; PYTEST_DISABLE_PLUGIN_AUTOLOAD stands in for a venv where it isn't.
    installed = shop.run(sys.executable, "-m", "runshape_recorder.run", "--runshape-run-name=installed", "-p", "no:cacheprovider")
    monkeypatch.setenv("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
    not_installed = shop.run(sys.executable, "-m", "runshape_recorder.run", "--runshape-run-name=not-installed", "-p", "no:cacheprovider")

    traces = shop.path / ".runshape" / "traces"
    assert [installed.ret, not_installed.ret] == [0, 0]
    assert sorted(path.name for path in traces.iterdir()) == ["installed", "latest.json", "not-installed", "previous.json"]
    assert len(json.loads((traces / "not-installed" / "manifest.json").read_text())["scenarios"]) == 5
