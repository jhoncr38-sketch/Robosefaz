from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.certificates.certificate_manager import CertificateManager  # noqa: E402
from app.config import Settings  # noqa: E402
from app.downloads.organizer import DownloadOrganizer  # noqa: E402
from app.jobs.base_runner import RunnerDeps  # noqa: E402
from fakes import FakeProvider, FakeRepo, registry_with  # noqa: E402


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        _env_file=None,
        supabase_url="",
        supabase_service_role_key="",
        download_base_path=str(tmp_path / "downloads"),
        browser_profile_base_path=str(tmp_path / "profiles"),
        error_screenshot_path=str(tmp_path / "errors"),
        step_screenshot_path=str(tmp_path / "shots"),
        secrets_file_path=str(tmp_path / "secrets" / "s.enc"),
        log_file_path="",
        stop_flag_path=str(tmp_path / "parar-robo.flag"),
        status_file_path=str(tmp_path / "worker-status.json"),
        automation_dry_run=False,
        automation_screenshots=False,
        manual_action_timeout=2_000,
        retry_delays="10,30,60",
        max_attempts=3,
    )


@pytest.fixture
def repo() -> FakeRepo:
    return FakeRepo()


@pytest.fixture
def provider() -> FakeProvider:
    return FakeProvider()


@pytest.fixture
def deps(repo: FakeRepo, provider: FakeProvider, settings: Settings) -> RunnerDeps:
    return RunnerDeps.build(
        repo,  # type: ignore[arg-type]
        registry_with(provider),
        settings,
        "test-worker",
        certificate_manager=CertificateManager(require_installed=False),
        organizer=DownloadOrganizer(settings.downloads_dir),
    )
