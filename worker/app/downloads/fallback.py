"""Plano B da pasta das notas (ex.: pasta no Google Drive).

Se a pasta configurada estiver fora do ar (Google Drive fechado, sem login, disco
externo desligado), a nota é salva na pasta local do robô (storage/downloads) e
anotada em storage/notas-para-enviar.json. A rotina de manutenção chama
`send_pending` a cada 5 min: quando a pasta volta, as notas anotadas são copiadas
para lá. A cópia local fica (o robô nunca apaga notas).
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
from pathlib import Path

from app.config import Settings
from app.downloads.organizer import DownloadFolderUnavailable, DownloadOrganizer
from app.jobs.models import DocumentType, DownloadedFile
from app.utils.files import ensure_dir

log = logging.getLogger("downloads")

_CLIENT_FOLDER = re.compile(r"^(?P<code>[A-Z0-9]{3,20})(?: - (?P<name>.+))?$")
_lock = threading.Lock()


# pastas do Google Drive para computador (unidade G: ou modo "Espelhar arquivos")
_DRIVE_PARTS = {"meu drive", "my drive", "drives compartilhados", "shared drives"}


def notes_folder_kind(path: Path) -> str:
    """"google_drive" ou "local" — o painel mostra o botão Baixar (Google Drive) quando é Drive."""
    return "google_drive" if any(part.lower() in _DRIVE_PARTS for part in path.parts) else "local"


def organizer_for(settings: Settings) -> DownloadOrganizer:
    """Organizador da pasta das notas; com plano B quando ela não é a pasta local do robô."""
    base, local = settings.downloads_dir, settings.local_downloads_dir
    if os.path.normcase(str(base)) == os.path.normcase(str(local)):
        return DownloadOrganizer(base)
    return FallbackOrganizer(base, local, settings.pending_notes_file)


def read_pending(path: Path) -> list[str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [str(x) for x in data if isinstance(x, str)] if isinstance(data, list) else []


def _write_pending(path: Path, items: list[str]) -> None:
    if not items:
        path.unlink(missing_ok=True)
        return
    ensure_dir(path.parent)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def add_pending(path: Path, rel: str) -> None:
    with _lock:
        items = read_pending(path)
        if rel not in items:
            _write_pending(path, [*items, rel])


def remove_pending(path: Path, done: set[str]) -> None:
    # relê a lista: notas anotadas enquanto o envio rodava continuam nela
    with _lock:
        _write_pending(path, [x for x in read_pending(path) if x not in done])


class FallbackOrganizer(DownloadOrganizer):
    def __init__(self, base_dir: Path, local_dir: Path, pending_file: Path) -> None:
        super().__init__(base_dir)
        self.local = DownloadOrganizer(local_dir)
        self.pending_file = pending_file

    def check_available(self) -> None:
        # não recria a pasta do zero (ex.: "Meu Drive" some quando o Google Drive fecha ou troca de conta)
        if not self.base_dir.is_dir() and not self.base_dir.parent.is_dir():
            raise DownloadFolderUnavailable(f"Pasta {self.base_dir} indisponível")
        super().check_available()

    def store(
        self,
        source: Path,
        client_code: str,
        competence: str,
        document_type: DocumentType | str,
        client_name: str | None = None,
    ) -> DownloadedFile:
        try:
            return super().store(source, client_code, competence, document_type, client_name)
        except DownloadFolderUnavailable as exc:
            if not source.exists():
                raise
            stored = self.local.store(source, client_code, competence, document_type, client_name)
            rel = Path(stored.filepath).relative_to(self.local.base_dir).as_posix()
            add_pending(self.pending_file, rel)
            log.warning("Pasta das notas indisponível (%s): nota salva em %s até ela voltar.", exc, stored.filepath)
            return stored.model_copy(update={"saved_locally": True})

    def locate(
        self, filepath: str, client_code: str, competence: str, document_type: DocumentType | str, filename: str
    ) -> Path:
        """Na pasta das notas; se ainda não chegou lá (plano B), na pasta local."""
        found = super().locate(filepath, client_code, competence, document_type, filename)
        if found.is_file():
            return found
        try:
            local = self.local.locate(filepath, client_code, competence, document_type, filename)
        except ValueError:
            return found
        return local if local.is_file() else found

    def send_pending(self) -> int:
        """Copia para a pasta das notas as notas do plano B. Devolve quantas foram enviadas."""
        items = read_pending(self.pending_file)
        if not items:
            return 0
        try:
            self.check_available()
        except DownloadFolderUnavailable:
            return 0
        done: set[str] = set()
        sent = 0
        for rel in items:
            src = self.local.base_dir / rel
            parts = Path(rel).parts
            match = _CLIENT_FOLDER.match(parts[0]) if len(parts) == 5 else None
            if not src.is_file() or match is None:
                done.add(rel)  # apagada da pasta local ou caminho estranho: esquece
                continue
            tmp = ensure_dir(self.pending_file.parent / "enviando") / src.name
            try:
                shutil.copy2(src, tmp)
                # super(): sem o plano B aqui (senão a nota voltaria para a pasta local)
                super().store(tmp, match["code"], f"{parts[1]}-{parts[2]}", parts[3], match["name"])
            except DownloadFolderUnavailable:
                break  # caiu de novo: tenta na próxima rodada
            except (OSError, ValueError) as exc:
                log.warning("Não foi possível enviar %s para a pasta das notas: %s", rel, exc)
                continue
            finally:
                tmp.unlink(missing_ok=True)
            done.add(rel)
            sent += 1
        if done:
            remove_pending(self.pending_file, done)
        if sent:
            log.info("%s nota(s) do plano B enviada(s) para %s.", sent, self.base_dir)
        return sent
