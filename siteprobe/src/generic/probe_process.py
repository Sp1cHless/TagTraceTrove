"""Disposable probe processes: timeout also terminates owned browser descendants."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


def execute(command: list[str], *, seconds: float, payload: dict[str, Any] | None = None,
            cwd: Path | None = None) -> dict:
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, encoding="utf-8",
                               errors="replace",
                               cwd=cwd,
                               start_new_session=os.name != "nt",
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    try:
        stdout, stderr = process.communicate(json.dumps(payload) if payload is not None else None,
                                             timeout=max(0.001, seconds))
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            import signal
            os.killpg(process.pid, signal.SIGKILL)
        process.kill()
        process.communicate()
        raise
    if process.returncode:
        raise ValueError((stderr or stdout or "probe process failed")[-1500:])
    return json.loads(stdout)


def worker(action: str, payload: dict[str, Any], *, seconds: float) -> dict:
    # Running a file inside generic/ puts generic/select.py ahead of the stdlib select module.
    # Module invocation from the package root avoids that import collision in a fresh interpreter.
    return execute([sys.executable, "-m", "src.generic.probe_worker", action],
                   seconds=seconds, payload=payload, cwd=Path(__file__).resolve().parents[2])
