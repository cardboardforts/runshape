"""runshape-review: record the tests on a base commit and on the working tree, for comparing.

    runshape-review --base origin/main [-- pytest arguments]

The base is checked out into a temporary git worktree (the working tree is never touched),
the tests run there and then here, each with --runshape. The base recording becomes the
"previous" run and the working tree's the "latest", so the viewer's compare mode shows
exactly what this branch changes in how the tests execute.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import List, Optional, Sequence

from runshape_recorder.settings import DEFAULT_OUT_DIRECTORY

# pytest exit codes 0 (all passed), 1 (some failed) and 5 (none collected) are results;
# anything else (usage error, internal error, interrupted) means there's no recording.
RECORDED_EXIT_CODES = {0, 1, 5}


class ReviewError(Exception):
    pass


@dataclass(frozen=True)
class Revision:
    label: str
    sha: str
    dirty: bool = False

    @property
    def run_name(self) -> str:
        return f"{self.label}-{self.sha[:12]}{'-dirty' if self.dirty else ''}"


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="runshape-review", description=__doc__.split("\n\n")[0])
    parser.add_argument("--base", required=True, help="commit, branch or tag to compare against (e.g. origin/main)")
    parser.add_argument("pytest_args", nargs="*", help="passed to pytest (put them after --)")
    args = parser.parse_args(argv)
    try:
        record_base_and_head(os.getcwd(), args.base, list(args.pytest_args))
    except ReviewError as error:
        print(f"runshape-review: {error}", file=sys.stderr)
        return 2
    return 0


def record_base_and_head(project: str, base_ref: str, pytest_args: List[str]) -> None:
    repository = _git(project, "rev-parse", "--show-toplevel")
    base = Revision("base", _git(project, "rev-parse", "--verify", f"{base_ref}^{{commit}}"))
    head_sha = _git(project, "rev-parse", "HEAD")
    dirty = _git(project, "status", "--porcelain") != ""
    head = Revision("head", head_sha, dirty)
    out_directory = os.path.join(project, DEFAULT_OUT_DIRECTORY)
    relative_project = os.path.relpath(os.path.realpath(project), os.path.realpath(repository))

    worktree = tempfile.mkdtemp(prefix="runshape-base-")
    try:
        _git(project, "worktree", "add", "--detach", "--quiet", worktree, base.sha)
        print(f"runshape-review: recording base {base.sha[:10]} in a temporary worktree")
        _record(os.path.join(worktree, relative_project), out_directory, base, pytest_args)
    finally:
        subprocess.run(["git", "-C", project, "worktree", "remove", "--force", worktree], capture_output=True)
        shutil.rmtree(worktree, ignore_errors=True)

    print(f"runshape-review: recording head {head.sha[:10]}{' (with uncommitted changes)' if dirty else ''}")
    _record(project, out_directory, head, pytest_args)
    print("runshape-review: done. In VS Code: Runshape: Open Runtime View, then tick 'Compare with previous recording'.")


def _record(directory: str, out_directory: str, revision: Revision, pytest_args: List[str]) -> None:
    command = [
        sys.executable,
        "-m",
        "pytest",
        "--runshape",
        f"--runshape-out={out_directory}",
        f"--runshape-run-name={revision.run_name}",
        *pytest_args,
    ]
    completed = subprocess.run(command, cwd=directory)
    if completed.returncode not in RECORDED_EXIT_CODES:
        raise ReviewError(f"pytest on {revision.label} exited with {completed.returncode}; no recording made")


def _git(directory: str, *args: str) -> str:
    completed = subprocess.run(["git", "-C", directory, *args], capture_output=True, text=True)
    if completed.returncode != 0:
        raise ReviewError(f"git {' '.join(args)} failed: {completed.stderr.strip()}")
    return completed.stdout.strip()


if __name__ == "__main__":
    sys.exit(main())
