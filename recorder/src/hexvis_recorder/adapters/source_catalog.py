"""Static catalog of every function in the project, built by compiling source files.

This is the "floor" the runtime trace is drawn on: it includes functions no scenario ever
calls, and the executable lines of each, which is what makes untested code visible.
Compiling (rather than importing) means building the catalog runs no project code.
"""
from __future__ import annotations

import dis
import os
import sys
import warnings
from dataclasses import dataclass
from types import CodeType
from typing import Dict, Iterator, List, Tuple

CO_OPTIMIZED = 0x1  # set on function bodies, never on module or class bodies
SKIPPED_DIRECTORIES = {"__pycache__", ".venv", "venv", "node_modules", ".git", "migrations"}


@dataclass(frozen=True)
class CatalogFunction:
    file: str
    module: str
    qualname: str
    first_line: int
    last_line: int
    lines: Tuple[int, ...]


@dataclass(frozen=True)
class CatalogProblem:
    file: str
    reason: str


class SourceCatalog:
    def __init__(self, root: str) -> None:
        self._root = os.path.realpath(root)
        self._by_location: Dict[Tuple[str, int, str], str] = {}
        self._compiled_files: Dict[str, List[CatalogFunction]] = {}
        # Source text as recorded, so a later run can be compared by what the code said,
        # not by line numbers that move whenever anything above them changes.
        self.sources: Dict[str, List[str]] = {}
        self.problems: List[CatalogProblem] = []

    def qualname(self, code: CodeType) -> str:
        """CodeNamer port: co_qualname exists only from 3.11; derive it from source before that."""
        qualname = getattr(code, "co_qualname", None)
        if qualname:
            return qualname
        filename = os.path.realpath(code.co_filename)
        if filename not in self._compiled_files:
            self._compile(filename)
        return self._by_location.get((filename, code.co_firstlineno, code.co_name), code.co_name)

    def sources_under(self, directories: List[str]) -> Dict[str, List[str]]:
        """Source of the catalogued (project) files only. On Python < 3.11 qualname() also
        compiles framework files to name their functions; their source isn't ours to copy."""
        prefixes = [self._relative(os.path.realpath(d)).rstrip(os.sep) + os.sep for d in directories]
        return {file: lines for file, lines in self.sources.items() if any(file.startswith(p) for p in prefixes)}

    def functions_under(self, directories: List[str]) -> List[CatalogFunction]:
        functions: List[CatalogFunction] = []
        for filename in sorted(_python_files(directories)):
            if filename not in self._compiled_files:
                self._compile(filename)
            functions.extend(self._compiled_files[filename])
        return functions

    def _compile(self, filename: str) -> None:
        self._compiled_files[filename] = []
        try:
            with open(filename, "rb") as source, warnings.catch_warnings():
                # Compiling surfaces the project's own SyntaxWarnings; they aren't ours to report.
                warnings.simplefilter("ignore")
                raw = source.read()
                module_code = compile(raw, filename, "exec", dont_inherit=True)
        except (OSError, SyntaxError, ValueError) as error:
            self.problems.append(CatalogProblem(self._relative(filename), f"{type(error).__name__}: {error}"))
            return
        relative = self._relative(filename)
        # Split on newlines only: str.splitlines() also breaks on form feeds, U+2028 and other
        # characters Python's tokenizer doesn't count as line ends, shifting every later line.
        text = raw.decode("utf-8", errors="replace")
        self.sources[relative] = [line.rstrip("\r") for line in text.split("\n")]
        module = _module_name(filename, self._root)
        for code, qualname in _walk(module_code, ""):
            self._by_location[(filename, code.co_firstlineno, code.co_name)] = qualname
            lines = _executable_lines(code)
            self._compiled_files[filename].append(
                CatalogFunction(relative, module, qualname, code.co_firstlineno, _last_line(code), lines)
            )

    def _relative(self, filename: str) -> str:
        return os.path.relpath(filename, self._root)


def _walk(code: CodeType, prefix: str) -> Iterator[Tuple[CodeType, str]]:
    for const in code.co_consts:
        if not isinstance(const, CodeType):
            continue
        qualname = getattr(const, "co_qualname", None) or prefix + const.co_name
        if const.co_flags & CO_OPTIMIZED:
            yield const, qualname
            yield from _walk(const, qualname + ".<locals>.")
        else:
            yield from _walk(const, qualname + ".")


def _executable_lines(code: CodeType) -> Tuple[int, ...]:
    lines = {line for _, line in dis.findlinestarts(code) if line is not None}
    # The def/decorator line executes in the enclosing scope, not in the function — unless
    # the whole function is on that line (`def f(): return 1`).
    if len(lines) > 1:
        lines.discard(code.co_firstlineno)
    return tuple(sorted(lines))


def _last_line(code: CodeType) -> int:
    last = code.co_firstlineno
    for _, line in dis.findlinestarts(code):
        if line is not None and line > last:
            last = line
    for const in code.co_consts:
        if isinstance(const, CodeType):
            last = max(last, _last_line(const))
    return last


def _module_name(filename: str, root: str) -> str:
    """The name Python imports the file as: relative to the sys.path entry it lives under
    (so src/pkg/m.py is pkg.m in a src layout), falling back to the project root."""
    base = root
    for entry in sys.path:
        directory = os.path.realpath(entry or os.getcwd())
        if filename.startswith(directory + os.sep) and len(directory) > len(base) and directory.startswith(root):
            base = directory
    relative_path = os.path.relpath(filename, base)
    without_suffix = relative_path[: -len(".py")] if relative_path.endswith(".py") else relative_path
    parts = without_suffix.split(os.sep)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _python_files(directories: List[str]) -> Iterator[str]:
    for directory in directories:
        for current, subdirectories, files in os.walk(directory):
            subdirectories[:] = [d for d in subdirectories if d not in SKIPPED_DIRECTORIES]
            for name in files:
                if name.endswith(".py"):
                    yield os.path.realpath(os.path.join(current, name))

