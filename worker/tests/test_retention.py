"""Limpeza automática: histórico some 60 dias após o download; os ZIPs ficam."""

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.jobs.retention import RetentionService, sweep_screenshots
from fakes import FakeRepo

NOW = datetime(2026, 12, 1, 12, 0, tzinfo=timezone.utc)


def _file(base: Path, rel: str, age_days: float, content: bytes = b"PK\x03\x04zip") -> Path:
    path = base / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    ts = (NOW - timedelta(days=age_days)).timestamp()
    os.utime(path, (ts, ts))
    return path


def test_sweep_screenshots_removes_only_old_images(tmp_path: Path) -> None:
    old = _file(tmp_path, "job-antigo/20260801_step.png", 61, b"png")
    recent = _file(tmp_path, "job-novo/20261120_step.png", 10, b"png")
    other = _file(tmp_path, "anotacao.txt", 400, b"txt")

    assert sweep_screenshots(tmp_path, NOW - timedelta(days=60)) == 1
    assert not old.exists() and recent.exists() and other.exists()
    assert not (tmp_path / "job-antigo").exists()  # pasta vazia removida


async def test_run_deletes_old_history_but_never_the_zips(settings) -> None:
    repo = FakeRepo()
    zip_old = _file(settings.downloads_dir, "CLI000001/2026/08/NFCE/CLI000001_2026-08_NFCE.zip", 70)
    zip_new = _file(settings.downloads_dir, "CLI000002/2026/10/NFCE/CLI000002_2026-10_NFCE.zip", 5)
    repo.downloads = [
        {"id": "d-old", "filepath": str(zip_old), "downloaded_at": NOW - timedelta(days=70)},
        {"id": "d-new", "filepath": str(zip_new), "downloaded_at": NOW - timedelta(days=5)},
    ]
    repo.jobs = {
        "old-done": {"id": "old-done", "status": "completed", "finished_at": NOW - timedelta(days=70)},
        "old-failed": {"id": "old-failed", "status": "failed", "finished_at": None, "created_at": NOW - timedelta(days=65)},
        "old-waiting": {"id": "old-waiting", "status": "waiting_sefaz", "created_at": NOW - timedelta(days=90)},
        "new-done": {"id": "new-done", "status": "completed", "finished_at": NOW - timedelta(days=3)},
    }
    repo.tasks = {"t1": {"id": "t1", "job_id": "old-done"}, "t2": {"id": "t2", "job_id": "new-done"}}

    report = await RetentionService(repo, settings).run(now=NOW)

    # os ZIPs ficam no computador até o usuário apagar
    assert zip_old.exists() and zip_new.exists()
    assert [d["id"] for d in repo.downloads] == ["d-new"]
    assert set(repo.jobs) == {"old-waiting", "new-done"}  # job em andamento nunca é apagado
    assert set(repo.tasks) == {"t2"}
    assert report.downloads == 1 and report.jobs == 2

    calls = {(c[0], (c[3] or {}).get("level")): c for c in repo.retention_calls}
    assert calls[("automation_logs", "DEBUG")][2] == NOW - timedelta(days=7)
    assert calls[("automation_logs", None)][2] == NOW - timedelta(days=60)
    audit = calls[("audit_logs", None)]
    assert audit[4] == {"entity": ["download", "automation_job"]}  # auditoria de segurança fica


async def test_retention_disabled(settings) -> None:
    settings.retention_days = 0
    repo = FakeRepo()
    report = await RetentionService(repo, settings).run(now=NOW)
    assert report.total == 0 and repo.retention_calls == []
