"""Default Chrome/Edge selection and the formal runtime's offline browser fallback."""
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from playwright.sync_api import Error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.generic import acquisition


@pytest.mark.parametrize("prog_id,expected", [("ChromeHTML", "chrome"), ("ChromeHTML.abcd", "chrome"),
                                               ("MSEdgeHTM", "msedge"), ("FirefoxURL", "firefox"), ("OtherBrowser", None)])
def test_windows_default_association(prog_id, expected, monkeypatch):
    class Key:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
    registry = SimpleNamespace(HKEY_CURRENT_USER=1, OpenKey=lambda *args: Key(),
                               QueryValueEx=lambda *args: (prog_id, 1))
    monkeypatch.setitem(sys.modules, "winreg", registry)
    assert acquisition.windows_default_browser_channel() == expected


@pytest.mark.parametrize("profile", [False, True])
@pytest.mark.parametrize("channel", ["chrome", "msedge", None])
def test_capture_and_login_use_default_or_bundle(profile, channel, tmp_path, monkeypatch):
    executable = tmp_path / "shipped browser.exe"
    executable.write_bytes(b"never executed fixture")
    launch = Mock(return_value="browser")
    playwright = SimpleNamespace(chromium=SimpleNamespace(executable_path=str(executable),
                                   launch=launch, launch_persistent_context=launch))
    monkeypatch.setattr(acquisition, "windows_default_browser_channel", lambda: channel)
    if profile:
        acquisition.launch_profile(playwright, tmp_path / "profile", headful=True)
    else:
        acquisition.launch_browser(playwright, headless=True)
    options = launch.call_args.kwargs
    assert options.get("channel") == channel
    assert options.get("executable_path") == (str(executable) if channel is None else None)
    assert options["headless"] is not profile
    if profile:
        assert options["user_data_dir"] == str(tmp_path / "profile")


def test_stale_default_falls_back_but_real_launch_failure_is_preserved(tmp_path, monkeypatch):
    executable = tmp_path / "browser.exe"
    executable.write_bytes(b"never executed fixture")
    launch = Mock(side_effect=[Error("Chromium distribution 'chrome' is not found"), "bundled"])
    playwright = SimpleNamespace(chromium=SimpleNamespace(executable_path=str(executable), launch=launch))
    monkeypatch.setattr(acquisition, "windows_default_browser_channel", lambda: "chrome")
    assert acquisition.launch_browser(playwright, headless=True) == "bundled"
    assert launch.call_args.kwargs["executable_path"] == str(executable)
    launch.reset_mock(side_effect=True)
    launch.side_effect = Error("profile is locked")
    with pytest.raises(Error, match="profile is locked"):
        acquisition.launch_browser(playwright, headless=True)
    assert launch.call_count == 1


def test_missing_bundle_has_recovery_message_and_stops_driver(tmp_path, monkeypatch):
    playwright = SimpleNamespace(chromium=SimpleNamespace(executable_path=str(tmp_path / "missing.exe")), stop=Mock())
    monkeypatch.setattr(acquisition, "windows_default_browser_channel", lambda: None)
    playwright.chromium.launch = Mock()
    from playwright import sync_api
    monkeypatch.setattr(sync_api, "sync_playwright", lambda: SimpleNamespace(start=lambda: playwright))
    with pytest.raises(RuntimeError, match="自带浏览器"):
        acquisition.BrowserSession(acquisition.AcquisitionPlan(mode="browser")).__enter__()
    playwright.stop.assert_called_once()


def test_shipped_python_can_launch_bundle_and_read_without_chrome(tmp_path):
    repo = Path(__file__).resolve().parents[2]
    package_setting = os.environ.get("T3_TEST_BROWSER_PACKAGE")
    if not package_setting:
        pytest.skip("Set T3_TEST_BROWSER_PACKAGE to check a formal package's portable runtime.")
    package = Path(package_setting)
    environment = dict(os.environ, PLAYWRIGHT_BROWSERS_PATH=str(package / "tools/playwright"))
    result = subprocess.run([str(package / "siteprobe/.venv/Scripts/python.exe"),
                             str(repo / "tools/release/check-browser.py"), str(repo / "siteprobe")],
                            cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS: shipped Python" in result.stdout
