"""import_matrix.py on a small package whose two subpackages import each other."""
import subprocess
import sys
import textwrap
from pathlib import Path

SCRIPT = Path(__file__).with_name("import_matrix.py")


def write(root: Path, files: dict) -> None:
    for name, source in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(source))


def test_submodules_imported_from_a_package_count_as_those_submodules(tmp_path):
    write(tmp_path, {
        "app/__init__.py": "",
        "app/api/__init__.py": "",
        "app/db/__init__.py": "",
        # `from .. import db` names the app.db package, not app itself.
        "app/api/routes.py": "from .. import db\nfrom app import db as again\n",
        "app/db/models.py": """
            from typing import TYPE_CHECKING
            from app.api import routes
            if TYPE_CHECKING:  # type-only: the usual way to break a cycle on purpose
                from app.api.routes import Thing
            """,
    })

    output = subprocess.run([sys.executable, str(SCRIPT), str(tmp_path / "app")], capture_output=True, text=True, check=True).stdout

    assert output.splitlines() == [
        "imports  from -> to",
        "      2  app.api -> app.db",
        "      1  app.db -> app.api",
        "",
        "against the dominant direction (cycles between packages):",
        "  app/db/models.py:3 imports app.api.routes   (app.db -> app.api: 1 vs 2 the other way)",
    ]


def test_an_even_cycle_flags_both_directions(tmp_path):
    write(tmp_path, {
        "app/__init__.py": "",
        "app/api/__init__.py": "from app.db import x\n",
        "app/db/__init__.py": "from app.api import y\n",
    })

    output = subprocess.run([sys.executable, str(SCRIPT), str(tmp_path / "app")], capture_output=True, text=True, check=True).stdout

    assert output.splitlines()[-2:] == [
        "  app/api/__init__.py:1 imports app.db   (app.api -> app.db: 1 vs 1, an even cycle)",
        "  app/db/__init__.py:1 imports app.api   (app.db -> app.api: 1 vs 1, an even cycle)",
    ]
