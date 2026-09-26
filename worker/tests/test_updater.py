"""Atualização automática: versão, escolha do instalador e conferência do SHA-256 (sem acessar o GitHub)."""

import hashlib
import json

import httpx
import pytest

from app import updater
from app.updater import READY, Release, download, is_newer, parse_version, pick_release

EXE = b"MZ instalador de teste"
SHA = hashlib.sha256(EXE).hexdigest()


def _release_json(version: str = "9.9.9", *, digest: bool = True, body: str = "") -> dict:
    return {
        "tag_name": f"v{version}",
        "draft": False,
        "prerelease": False,
        "body": body,
        "assets": [
            {"name": "SIAT-Robo-20260926.zip", "browser_download_url": "https://x/zip", "size": 10},
            {
                "name": f"Instalar-SIAT-Robo-{version}.exe",
                "browser_download_url": f"https://x/Instalar-SIAT-Robo-{version}.exe",
                "size": len(EXE),
                **({"digest": f"sha256:{SHA}"} if digest else {}),
            },
        ],
    }


def test_versions() -> None:
    assert parse_version("v1.0.10") == (1, 0, 10)
    assert is_newer("1.0.10", "1.0.9")
    assert not is_newer("1.0.5", "1.0.5")
    assert not is_newer("1.0.4", "1.0.5")
    assert not is_newer("lixo", "1.0.5")


def test_pick_release_uses_github_digest_or_notes() -> None:
    rel = pick_release(_release_json())
    assert rel is not None and rel.version == "9.9.9" and rel.sha256 == SHA
    by_notes = pick_release(_release_json(digest=False, body=f"Notas\n\nSHA-256: {SHA}\n"))
    assert by_notes is not None and by_notes.sha256 == SHA
    assert pick_release(_release_json(digest=False)).sha256 is None  # sem conferência -> download recusa
    assert pick_release({**_release_json(), "prerelease": True}) is None
    assert pick_release({"assets": []}) is None


def _client(content: bytes) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200, content=content)))


def test_download_checks_sha(settings) -> None:
    rel = Release("9.9.9", "https://x/i.exe", SHA, len(EXE), "Instalar-SIAT-Robo-9.9.9.exe")
    path = download(settings, rel, client=_client(EXE))
    assert path.read_bytes() == EXE


def test_tampered_download_is_discarded(settings) -> None:
    rel = Release("9.9.9", "https://x/i.exe", SHA, len(EXE), "Instalar-SIAT-Robo-9.9.9.exe")
    with pytest.raises(RuntimeError, match="SHA-256"):
        download(settings, rel, client=_client(b"MZ arquivo adulterado"))
    folder = settings.status_file.parent / "updates"
    assert not list(folder.glob("*.exe")) and not list(folder.glob("*.part"))


def test_download_refuses_release_without_sha(settings) -> None:
    rel = Release("9.9.9", "https://x/i.exe", None, len(EXE), "Instalar-SIAT-Robo-9.9.9.exe")
    with pytest.raises(RuntimeError, match="SHA-256"):
        download(settings, rel, client=_client(EXE))


def test_main_prepares_installer_only_when_newer(settings, monkeypatch) -> None:
    settings.update_enabled = True
    monkeypatch.setattr(updater, "get_settings", lambda: settings)
    monkeypatch.setattr(updater, "download", lambda s, rel: settings.status_file.parent / rel.name)

    monkeypatch.setattr(updater, "latest_release", lambda s: pick_release(_release_json("9.9.9")))
    assert updater.main(["--download"]) == READY
    pending = json.loads((settings.status_file.parent / "updates" / "pendente.json").read_text(encoding="utf-8"))
    assert pending["version"] == "9.9.9"
    assert updater.read_status(settings)["available"] is True

    monkeypatch.setattr(updater, "latest_release", lambda s: pick_release(_release_json("0.0.1")))
    assert updater.main(["--download"]) == 0
    assert updater.read_status(settings)["available"] is False


def test_disabled_does_nothing(settings, monkeypatch) -> None:
    monkeypatch.setattr(updater, "get_settings", lambda: settings)  # update_enabled=False nos testes
    monkeypatch.setattr(updater, "latest_release", lambda s: pytest.fail("não deveria consultar o GitHub"))
    assert updater.main(["--download"]) == 0
