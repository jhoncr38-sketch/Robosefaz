r"""Atualização automática do robô a partir das Releases do GitHub.

    .venv\Scripts\python.exe -m app.updater --check      # só consulta (grava storage\update-status.json)
    .venv\Scripts\python.exe -m app.updater --download   # baixa e confere a versão nova

Chamado pelo instalador\robo-servico.ps1:
- ao ligar, ANTES do robô pegar qualquer trabalho;
- quando o robô para por ociosidade para atualizar (arquivo storage\atualizar.flag).

Segurança: só instala o .exe da última Release do repositório configurado,
depois de conferir o SHA-256 informado pelo GitHub (ou publicado nas notas da
Release). Arquivo divergente é apagado e nada é instalado.

Saída de --download: 0 = nada a fazer; 10 = instalador pronto (caminho em
storage\updates\pendente.json); 1 = erro.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import httpx

from app import __version__
from app.config import Settings, get_settings

log = logging.getLogger("updater")

READY = 10
_ASSET = re.compile(r"^Instalar-SIAT-Robo-(\d+\.\d+\.\d+)\.exe$")
_BODY_SHA = re.compile(r"sha-?256[^0-9a-f]{0,40}([0-9a-f]{64})", re.IGNORECASE)


def parse_version(text: str) -> tuple[int, ...]:
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)


def is_newer(candidate: str, current: str = __version__) -> bool:
    return parse_version(candidate) > parse_version(current)


@dataclass
class Release:
    version: str
    url: str
    sha256: str | None
    size: int
    name: str


def pick_release(data: dict) -> Release | None:
    """Instalador da Release e seu SHA-256 (campo digest do GitHub ou linha 'SHA-256' nas notas)."""
    if data.get("draft") or data.get("prerelease"):
        return None
    for asset in data.get("assets", []):
        m = _ASSET.match(asset.get("name", ""))
        if not m:
            continue
        digest = (asset.get("digest") or "").lower()
        sha = digest.removeprefix("sha256:") if digest.startswith("sha256:") else None
        if sha is None:
            found = _BODY_SHA.search(data.get("body") or "")
            sha = found.group(1).lower() if found else None
        return Release(m.group(1), asset["browser_download_url"], sha, int(asset.get("size") or 0), asset["name"])
    return None


def latest_release(settings: Settings, client: httpx.Client | None = None) -> Release | None:
    url = f"https://api.github.com/repos/{settings.update_repo}/releases/latest"
    own = client is None
    client = client or httpx.Client(timeout=30, follow_redirects=True)
    try:
        r = client.get(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "siat-robo-updater"})
        r.raise_for_status()
        return pick_release(r.json())
    finally:
        if own:
            client.close()


def _status_file(settings: Settings) -> Path:
    return settings.status_file.with_name("update-status.json")


def write_status(settings: Settings, latest: Release | None, error: str | None = None) -> None:
    """Estado lido pelo ícone da bandeja ("Versão nova disponível")."""
    data = {
        "current": __version__,
        "latest": latest.version if latest else None,
        "available": bool(latest and is_newer(latest.version)),
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "error": error,
    }
    path = _status_file(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def read_status(settings: Settings) -> dict:
    try:
        return json.loads(_status_file(settings).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def download(settings: Settings, release: Release, client: httpx.Client | None = None) -> Path:
    """Baixa o instalador e confere o SHA-256; arquivo divergente é apagado."""
    if not release.sha256:
        raise RuntimeError("A Release não informa o SHA-256 do instalador; atualização recusada.")
    folder = settings.status_file.parent / "updates"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / release.name
    if target.is_file() and _sha256(target) == release.sha256:
        return target
    part = target.with_suffix(".part")
    own = client is None
    client = client or httpx.Client(timeout=300, follow_redirects=True)
    try:
        with client.stream("GET", release.url, headers={"User-Agent": "siat-robo-updater"}) as r:
            r.raise_for_status()
            with part.open("wb") as fh:
                for chunk in r.iter_bytes(1 << 20):
                    fh.write(chunk)
    finally:
        if own:
            client.close()
    if _sha256(part) != release.sha256:
        part.unlink(missing_ok=True)
        raise RuntimeError("SHA-256 do instalador baixado não confere; arquivo descartado.")
    part.replace(target)
    for old in folder.glob("Instalar-SIAT-Robo-*.exe"):
        if old != target:
            old.unlink(missing_ok=True)
    return target


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Atualização automática do SIAT Robô")
    parser.add_argument("--check", action="store_true", help="só consulta a versão mais nova")
    parser.add_argument("--download", action="store_true", help="baixa e confere a versão nova")
    args = parser.parse_args(argv)
    settings = get_settings()
    if not settings.update_enabled:
        return 0
    try:
        release = latest_release(settings)
    except Exception as exc:  # noqa: BLE001 - sem internet: tenta na próxima vez
        write_status(settings, None, error=str(exc))
        print(f"Não foi possível consultar atualizações: {exc}", file=sys.stderr)
        return 1
    write_status(settings, release)
    if args.check or release is None or not is_newer(release.version):
        return 0
    try:
        installer = download(settings, release)
    except Exception as exc:  # noqa: BLE001
        write_status(settings, release, error=str(exc))
        print(f"Falha ao baixar a atualização: {exc}", file=sys.stderr)
        return 1
    pending = settings.status_file.parent / "updates" / "pendente.json"
    pending.parent.mkdir(parents=True, exist_ok=True)
    pending.write_text(json.dumps({**asdict(release), "path": str(installer)}), encoding="utf-8")
    print(f"Versão {release.version} pronta para instalar: {installer}")
    return READY


if __name__ == "__main__":
    raise SystemExit(main())
