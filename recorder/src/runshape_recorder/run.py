"""python -m runshape_recorder.run [pytest arguments]: pytest with the recorder on.

Runshape's CLI runs this with the recorder on PYTHONPATH, so a project records without
installing it. Where it is installed, pytest already loads it by its entry point, and naming
it again with -p would register it twice.
"""
from __future__ import annotations

import os
import sys
from importlib import metadata
from typing import List, Sequence

import pytest

ENTRY_POINT_GROUP = "pytest11"
ENTRY_POINT_NAME = "runshape"
PLUGIN_MODULE = "runshape_recorder.pytest_plugin"
# pytest's own switch: with it set, no entry point is loaded, installed or not.
NO_AUTOLOAD = "PYTEST_DISABLE_PLUGIN_AUTOLOAD"


def pytest_arguments(args: Sequence[str], loaded_by_pytest: bool) -> List[str]:
    load = [] if loaded_by_pytest else ["-p", PLUGIN_MODULE]
    return [*load, "--runshape", *args]


def loaded_by_pytest() -> bool:
    if os.environ.get(NO_AUTOLOAD):
        return False
    entry_points = metadata.entry_points()
    # Python 3.9's entry_points() is a dict of groups; 3.10+ selects.
    if hasattr(entry_points, "select"):
        group = entry_points.select(group=ENTRY_POINT_GROUP)
    else:
        group = entry_points.get(ENTRY_POINT_GROUP, [])  # type: ignore[attr-defined]
    return any(entry.name == ENTRY_POINT_NAME for entry in group)


def main() -> int:
    return int(pytest.main(pytest_arguments(sys.argv[1:], loaded_by_pytest())))


if __name__ == "__main__":
    sys.exit(main())
