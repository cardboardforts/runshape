"""runshape-review end to end: a git repo with a committed base and an uncommitted change."""
import json
import shutil
import subprocess

from runshape_recorder import review
from test_recording import SAMPLE_SHOP


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def test_records_the_base_in_a_worktree_and_the_working_tree_as_latest(tmp_path, monkeypatch):
    repo = tmp_path / "shop"
    shutil.copytree(SAMPLE_SHOP, repo)
    git(repo, "init", "-q")
    git(repo, "add", ".")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "base")
    # The branch's change, not committed: an extra call on every order.
    service = repo / "shop" / "service.py"
    service.write_text(service.read_text().replace("        order = Order(items)\n", "        items = sorted(items)\n        order = Order(items)\n"))
    monkeypatch.chdir(repo)

    exit_code = review.main(["--base", "HEAD", "--", "-q", "-p", "no:cacheprovider"])

    traces = repo / ".runshape" / "traces"
    latest = json.loads((traces / "latest.json").read_text())["run"]
    previous = json.loads((traces / "previous.json").read_text())["run"]
    assert exit_code == 0
    assert previous.startswith("base-") and not previous.endswith("-dirty")
    assert latest.startswith("head-") and latest.endswith("-dirty")  # uncommitted changes, recorded as such
    base_source = json.loads((traces / previous / "manifest.json").read_text())["sources"]["shop/service.py"]
    head_source = json.loads((traces / latest / "manifest.json").read_text())["sources"]["shop/service.py"]
    assert "        items = sorted(items)" not in base_source
    assert "        items = sorted(items)" in head_source
    # The working tree is left as it was, and no worktree is left behind.
    assert "items = sorted(items)" in service.read_text()
    worktrees = subprocess.run(["git", "worktree", "list"], cwd=repo, capture_output=True, text=True).stdout
    assert len(worktrees.strip().splitlines()) == 1


def test_an_unknown_base_is_reported_without_recording_anything(tmp_path, monkeypatch, capsys):
    repo = tmp_path / "shop"
    shutil.copytree(SAMPLE_SHOP, repo)
    git(repo, "init", "-q")
    monkeypatch.chdir(repo)

    exit_code = review.main(["--base", "no-such-branch"])

    assert exit_code == 2
    assert "no-such-branch" in capsys.readouterr().err
    assert not (repo / ".runshape").exists()


def committed_shop(tmp_path, layout="flat"):
    repo = tmp_path / "shop"
    shutil.copytree(SAMPLE_SHOP, repo, ignore=shutil.ignore_patterns("__pycache__"))
    if layout == "src":
        (repo / "src").mkdir()
        for package in ("shop", "fakedb"):
            (repo / package).rename(repo / "src" / package)
        ini = repo / "pytest.ini"
        ini.write_text(ini.read_text().replace("runshape_source = shop", "runshape_source = src/shop"))
    git(repo, "init", "-q")
    git(repo, "add", ".")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "base")
    return repo


def test_a_src_layout_found_through_pythonpath_is_imported_from_the_base_checkout_on_the_base(tmp_path, monkeypatch):
    # PYTHONPATH (or an editable install) points at the working tree's src. Inherited as is,
    # the base run would import the branch's code from there — outside the worktree, so not
    # even recorded — and the review would show the branch's own calls as changes.
    repo = committed_shop(tmp_path, layout="src")
    service = repo / "src" / "shop" / "service.py"
    service.write_text(service.read_text().replace("        order = Order(items)\n", "        items = sorted(items)\n        order = Order(items)\n"))
    monkeypatch.chdir(repo)
    monkeypatch.setenv("PYTHONPATH", str(repo / "src"))

    assert review.main(["--base", "HEAD", "--", "-q", "-p", "no:cacheprovider"]) == 0

    # The manifest's source snapshot is read from the checkout either way; only the recorded
    # calls show which code actually ran.
    traces = repo / ".runshape" / "traces"
    for side in ("previous", "latest"):
        run = json.loads((traces / f"{side}.json").read_text())["run"]
        recorded = "".join(path.read_text() for path in (traces / run / "scenarios").iterdir())
        assert "OrderService.place_order" in recorded, f"{run} recorded no app code"


def test_a_second_review_of_a_clean_tree_is_still_clean_despite_its_own_recordings(tmp_path, monkeypatch, capsys):
    # The first review leaves .runshape/ and __pycache__/ behind, untracked; they aren't changes.
    repo = committed_shop(tmp_path)
    monkeypatch.chdir(repo)

    for _ in range(2):
        assert review.main(["--base", "HEAD", "--", "-q"]) == 0
        latest = json.loads((repo / ".runshape" / "traces" / "latest.json").read_text())["run"]
        assert not latest.endswith("-dirty"), latest


def test_failing_tests_and_a_project_missing_from_the_base_are_reported(tmp_path, monkeypatch, capsys):
    repo = committed_shop(tmp_path)
    tests = repo / "tests" / "test_orders.py"
    tests.write_text(tests.read_text() + "\n\ndef test_broken():\n    assert False\n")
    git(repo, "add", ".")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "a failing test")
    monkeypatch.chdir(repo)

    assert review.main(["--base", "HEAD", "--", "-q"]) == 0
    # Recorded anyway — failures are results — but the caller hears that the base had them,
    # since a worktree lacks untracked files (.env, local fixtures) the tests may need.
    err = capsys.readouterr().err
    assert "some tests failed on base" in err and "some tests failed on head" in err

    # A project directory the branch adds has no base to compare against.
    package = repo / "packages" / "new"
    shutil.copytree(repo / "shop", package / "shop")
    (package / "pytest.ini").write_text((repo / "pytest.ini").read_text())
    monkeypatch.chdir(package)

    assert review.main(["--base", "HEAD"]) == 2
    assert "packages/new does not exist at base" in capsys.readouterr().err
