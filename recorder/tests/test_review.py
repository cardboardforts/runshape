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
