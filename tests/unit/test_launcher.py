from pathlib import Path

import pytest

from scripts import dev


def test_missing_prerequisite_is_actionable(monkeypatch):
    monkeypatch.setattr(dev.shutil, "which", lambda _: None)
    with pytest.raises(RuntimeError, match="Missing prerequisite: mailpit"):
        dev.executable("mailpit")


def test_wrong_node_version_is_rejected(monkeypatch):
    monkeypatch.setattr(dev, "executable", lambda name: name)
    monkeypatch.setattr(dev.subprocess, "check_output", lambda *args, **kwargs: "v22.0.0")
    with pytest.raises(RuntimeError, match="Node.js 24 LTS required"):
        dev.check_node()


def test_stop_without_owned_stack_does_not_signal_processes(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(dev, "LOCK", tmp_path / "absent.lock")
    with pytest.raises(RuntimeError, match="no processes were stopped"):
        dev.stop()


def test_occupied_ports_remove_only_own_lock(tmp_path: Path, monkeypatch):
    local = tmp_path / "local"
    website = tmp_path / "website"
    astro = website / "node_modules" / "astro" / "package.json"
    astro.parent.mkdir(parents=True)
    astro.write_text('{"bin": "./astro.js"}')
    (astro.parent / "astro.js").touch()
    monkeypatch.setattr(dev, "LOCAL", local)
    monkeypatch.setattr(dev, "LOCK", local / "stack.lock")
    monkeypatch.setattr(dev, "STOP", local / "stop.request")
    monkeypatch.setattr(dev, "WEBSITE", website)
    monkeypatch.setattr(dev, "check_node", lambda: None)
    monkeypatch.setattr(dev, "executable", lambda name: name)

    def occupied():
        raise OSError("Address already in use")

    monkeypatch.setattr(dev, "assert_ports_free", occupied)
    with pytest.raises(OSError, match="Address already in use"):
        dev.up()
    assert not dev.LOCK.exists()


def test_existing_stack_lock_is_preserved(tmp_path: Path, monkeypatch):
    local = tmp_path / "local"
    local.mkdir()
    lock = local / "stack.lock"
    lock.write_text("existing launcher")
    astro = tmp_path / "website" / "node_modules" / "astro" / "package.json"
    astro.parent.mkdir(parents=True)
    astro.write_text('{"bin": "./astro.js"}')
    (astro.parent / "astro.js").touch()
    monkeypatch.setattr(dev, "LOCAL", local)
    monkeypatch.setattr(dev, "LOCK", lock)
    monkeypatch.setattr(dev, "WEBSITE", tmp_path / "website")
    monkeypatch.setattr(dev, "check_node", lambda: None)
    monkeypatch.setattr(dev, "executable", lambda name: name)
    with pytest.raises(RuntimeError, match="Stack lock exists"):
        dev.up()
    assert lock.read_text() == "existing launcher"
