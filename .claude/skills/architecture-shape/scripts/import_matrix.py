#!/usr/bin/env python3
"""Package-to-package import matrix for a Python codebase, read with ast (nothing imported).

    python3 import_matrix.py <package dir> [--depth 2]

Prints, for each pair of packages at the given depth, how many import statements go from
one to the other, then every import that points "up" against the most common direction
between that pair, with the file and line, so offenders can be cited directly.
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


def imports_in(path: str, module: str):
    with open(path, "rb") as handle:
        tree = ast.parse(handle.read(), path)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name, node.lineno
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # relative import: resolve against this module's package
                base = module.split(".")[: -node.level] if not path.endswith("__init__.py") else module.split(".")[: len(module.split(".")) - node.level + 1]
                target = ".".join(base + ([node.module] if node.module else []))
            else:
                target = node.module or ""
            yield target, node.lineno


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("package", help="the top-level package directory, e.g. app")
    parser.add_argument("--depth", type=int, default=2, help="package depth to group by (default 2: app.api, app.db, ...)")
    args = parser.parse_args()
    root = os.path.realpath(args.package)
    top = os.path.basename(root)
    parent = os.path.dirname(root)

    counts = Counter()
    sites = defaultdict(list)
    for directory, subdirectories, files in os.walk(root):
        subdirectories[:] = [d for d in subdirectories if d not in {"__pycache__", "migrations", "tests"}]
        for name in files:
            if not name.endswith(".py"):
                continue
            path = os.path.join(directory, name)
            module = module_name(parent, path)
            source = package_of(module, args.depth)
            try:
                found = list(imports_in(path, module))
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
        if 0 < count < reverse or (count == reverse and source > destination and count > 0):
            flagged = True
            for site in sites[(source, destination)]:
                print(f"  {site}   ({source} -> {destination}: {count} vs {reverse} the other way)")
    if not flagged:
        print("  none")
    return 0


if __name__ == "__main__":
    sys.exit(main())
