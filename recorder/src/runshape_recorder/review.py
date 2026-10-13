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
from typing import Dict, List, Optional, Sequence

from runshape_recorder.settings import DEFAULT_OUT_DIRECTORY

# pytest exit codes 0 (all passed), 1 (some failed) and 5 (none collected) are results;
# anything else (usage error, internal error, interrupted) means there's no recording.
RECORDED_EXIT_CODES = {0, 1, 5}
SOME_TESTS_FAILED = 1
# A src layout is importable only through the environment (PYTHONPATH or an editable
# install); each side puts its own checkout's src first so it can't import the other's.
SRC_LAYOUT_DIRECTORY = "src"
# Not changes to the code: what earlier runs leave behind.
NOT_CHANGES = (f":(exclude){DEFAULT_OUT_DIRECTORY}", ":(exclude,glob)**/__pycache__/**")


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
    dirty = _git(project, "status", "--porcelain", "--", ".", *NOT_CHANGES) != ""
    head = Revision("head", head_sha, dirty)
    out_directory = os.path.join(project, DEFAULT_OUT_DIRECTORY)
    relative_project = os.path.relpath(os.path.realpath(project), os.path.realpath(repository))

    worktree = tempfile.mkdtemp(prefix="runshape-base-")
    try:
        _git(project, "worktree", "add", "--detach", "--quiet", worktree, base.sha)
        base_project = os.path.join(worktree, relative_project)
        if not os.path.isdir(base_project):
            raise ReviewError(f"{relative_project} does not exist at base {base.sha[:10]}; there is nothing to compare against")
        print(f"runshape-review: recording base {base.sha[:10]} in a temporary worktree")
        _record(base_project, out_directory, base, pytest_args, _environment(repository, worktree, base_project))
    finally:
        subprocess.run(["git", "-C", project, "worktree", "remove", "--force", worktree], capture_output=True)
        shutil.rmtree(worktree, ignore_errors=True)

    print(f"runshape-review: recording head {head.sha[:10]}{' (with uncommitted changes)' if dirty else ''}")
    _record(project, out_directory, head, pytest_args, _environment(repository, repository, project))
    print("runshape-review: done. In VS Code: Runshape: Open Runtime View, then tick 'Compare with previous recording'.")


def _environment(repository: str, checkout: str, directory: str) -> Dict[str, str]:
    """PYTHONPATH entries inside the repository point into `checkout` instead."""
    environment = dict(os.environ)
    entries = []
    src = os.path.join(directory, SRC_LAYOUT_DIRECTORY)
    if _holds_packages(src):
        entries.append(src)
    for entry in environment.get("PYTHONPATH", "").split(os.pathsep):
        if entry == "":
            continue
        inside = os.path.relpath(os.path.realpath(entry), os.path.realpath(repository))
        outside = inside == os.pardir or inside.startswith(os.pardir + os.sep)
        entries.append(entry if outside else os.path.join(checkout, inside))
    environment["PYTHONPATH"] = os.pathsep.join(entries)
    return environment


def _holds_packages(directory: str) -> bool:
    """A src layout's src/ holds importable packages; some projects' src/ holds other things."""
    if not os.path.isdir(directory):
        return False
    for name in os.listdir(directory):
        path = os.path.join(directory, name)
        if name.endswith(".py"):
            return True
        # A package, or a namespace package (PEP 420: modules, no __init__.py).
        if os.path.isdir(path) and any(child.endswith(".py") for child in os.listdir(path)):
            return True
    return False


def _record(directory: str, out_directory: str, revision: Revision, pytest_args: List[str], environment: Dict[str, str]) -> None:
    command = [
        sys.executable,
        "-m",
        "pytest",
        "--runshape",
        f"--runshape-out={out_directory}",
        f"--runshape-run-name={revision.run_name}",
        *pytest_args,
    ]
    completed = subprocess.run(command, cwd=directory, env=environment)
    if completed.returncode not in RECORDED_EXIT_CODES:
        raise ReviewError(f"pytest on {revision.label} exited with {completed.returncode}; no recording made")
    if completed.returncode == SOME_TESTS_FAILED:
        print(
            f"runshape-review: some tests failed on {revision.label}; recorded anyway. The base checkout has only"
            " committed files, so a test needing an untracked one (.env, local fixtures) fails there for that alone.",
            file=sys.stderr,
        )


def _git(directory: str, *args: str) -> str:
    try:
        completed = subprocess.run(["git", "-C", directory, *args], capture_output=True, text=True)
    except FileNotFoundError:
        raise ReviewError("git is not installed or not on PATH") from None
    if completed.returncode != 0:
        raise ReviewError(f"git {' '.join(args)} failed: {completed.stderr.strip()}")
    return completed.stdout.strip()


if __name__ == "__main__":
    sys.exit(main())
