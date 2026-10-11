"""A sweep cannot infer ownership from a newly appearing session directory."""
from src.generic import registry
import verify_doors


def test_sweep_preserves_sessions_created_by_other_processes(tmp_path, monkeypatch):
    monkeypatch.setattr(registry, "adapter_root", lambda: tmp_path)
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    before = verify_doors.sessions_before()
    concurrent = sessions / "another-process"
    concurrent.mkdir()
    (concurrent / "state.json").write_text("important", encoding="utf-8")

    assert verify_doors.drop_new_sessions(before) == []
    assert (concurrent / "state.json").read_text(encoding="utf-8") == "important"
