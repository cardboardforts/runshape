#!/usr/bin/env python3
"""Package-to-package import matrix for a Python codebase, read with ast (nothing imported).

    python3 import_matrix.py <package dir> [--depth 2]

Prints, for each pair of packages at the given depth, how many import statements go from
one to the other, then every import that points "up" against the most common direction
between that pair, with the file and line, so offenders can be cited directly.

`from pkg import name` counts as an import of pkg.name when that is a module. Imports under
`if TYPE_CHECKING:` are left out: they're type-only, the usual way to break a cycle on purpose.
"""
import argparse
import ast
import os
import sys
from collections import Counter, defaultdict


def package_of(module: str, depth: int) -> str:
    return ".".join(module.split(".")[:depth])


def module_name(root_parent: str, path: str) -> str:
    relative = os.path.relpath(path, root_parent)[: -len(".py")]
    parts = relative.split(os.sep)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def is_type_checking(test: ast.expr) -> bool:
    return (isinstance(test, ast.Name) and test.id == "TYPE_CHECKING") or (isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING")


def runtime_imports(node: ast.AST):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.If) and is_type_checking(child.test):
            for other in child.orelse:
                yield from runtime_imports(ast.Module(body=[other], type_ignores=[]))
            continue
        if isinstance(child, (ast.Import, ast.ImportFrom)):
            yield child
        yield from runtime_imports(child)


def imports_in(path: str, module: str, known_modules: set):
    with open(path, "rb") as handle:
        tree = ast.parse(handle.read(), path)
    for node in runtime_imports(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name, node.lineno
            continue
        if node.level:  # relative import: resolve against this module's package
            base = module.split(".")[: -node.level] if not path.endswith("__init__.py") else module.split(".")[: len(module.split(".")) - node.level + 1]
            target = ".".join(base + ([node.module] if node.module else []))
        else:
            target = node.module or ""
        for alias in node.names:
            submodule = f"{target}.{alias.name}"
            yield (submodule if submodule in known_modules else target), node.lineno


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("package", help="the top-level package directory, e.g. app")
    parser.add_argument("--depth", type=int, default=2, help="package depth to group by (default 2: app.api, app.db, ...)")
    args = parser.parse_args()
    root = os.path.realpath(args.package)
    top = os.path.basename(root)
    parent = os.path.dirname(root)

    paths = []
    for directory, subdirectories, files in os.walk(root):
        subdirectories[:] = sorted(d for d in subdirectories if d not in {"__pycache__", "migrations", "tests"})
        paths.extend(os.path.join(directory, name) for name in sorted(files) if name.endswith(".py"))
    known_modules = {module_name(parent, path) for path in paths}

    counts = Counter()
    sites = defaultdict(list)
    for path in paths:
        module = module_name(parent, path)
        source = package_of(module, args.depth)
        try:
            found = list(imports_in(path, module, known_modules))
        except SyntaxError as error:
            print(f"skipped {path}: {error}", file=sys.stderr)
            continue
        for target, line in found:
            if target != top and not target.startswith(top + "."):
                continue
            destination = package_of(target, args.depth)
            if destination == source:
                continue
            counts[(source, destination)] += 1
            sites[(source, destination)].append(f"{os.path.relpath(path, parent)}:{line} imports {target}")

    print("imports  from -> to")
    for (source, destination), count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
        print(f"{count:7d}  {source} -> {destination}")
    print("\nagainst the dominant direction (cycles between packages):")
    flagged = False
    for (source, destination), count in sorted(counts.items()):
        reverse = counts.get((destination, source), 0)
        if 0 < count < reverse:
            flagged = True
            for site in sites[(source, destination)]:
                print(f"  {site}   ({source} -> {destination}: {count} vs {reverse} the other way)")
        elif count == reverse:  # no dominant direction to be against: show both sides
            flagged = True
            for site in sites[(source, destination)]:
                print(f"  {site}   ({source} -> {destination}: {count} vs {reverse}, an even cycle)")
    if not flagged:
        print("  none")
    return 0


if __name__ == "__main__":
    sys.exit(main())
