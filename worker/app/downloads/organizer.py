"""Organização dos arquivos baixados por cliente e competência.

storage/downloads/{client_code}/{year}/{month}/{NFCE|NFE_EMITIDAS|NFE_RECEBIDAS}/
Nome: {client_code}_{YYYY-MM}_{TIPO}.zip  (sufixo _2, _3... para lotes múltiplos)
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from app.jobs.models import DocumentType, DownloadedFile
from app.utils.competence import Competence
from app.utils.files import ensure_dir, ensure_within, move_atomic, sha256_file, sniff_kind

_CLIENT_CODE = re.compile(r"^[A-Z0-9]{3,20}$")


class InvalidDownloadError(ValueError):
    pass


class DownloadFolderUnavailable(OSError):
    """Pasta de downloads inacessível (ex.: unidade externa ou de rede desconectada)."""


@dataclass(frozen=True, slots=True)
class DownloadTarget:
    folder: Path
    filename: str

    @property
    def path(self) -> Path:
        return self.folder / self.filename


class DownloadOrganizer:
    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir

    def check_available(self) -> None:
        """Falha cedo se a unidade da pasta (ex.: disco externo ou unidade de rede) não estiver montada."""
        anchor = Path(self.base_dir.anchor) if self.base_dir.anchor else None
        if anchor is not None and not anchor.exists():
            raise DownloadFolderUnavailable(f"Unidade {self.base_dir.anchor} indisponível para {self.base_dir}")
        try:
            ensure_dir(self.base_dir)
        except OSError as exc:
            raise DownloadFolderUnavailable(f"Não foi possível acessar {self.base_dir}: {exc}") from exc

    def locate(
        self, filepath: str, client_code: str, competence: str, document_type: DocumentType | str, filename: str
    ) -> Path:
        """Arquivo no disco DESTE computador.

        `filepath` foi gravado pela máquina que baixou; em outra máquina (pasta do
        pasta em outra letra/usuário) vale o caminho padrão cliente/ano/mês/tipo.
        """
        try:
            stored = ensure_within(self.base_dir, Path(filepath))
            if stored.is_file():
                return stored
        except ValueError:
            pass
        if Path(filename).name != filename:
            raise ValueError(f"Nome de arquivo inválido: {filename!r}")
        return ensure_within(self.base_dir, self.folder_for(client_code, competence, document_type) / filename)

    def folder_for(self, client_code: str, competence: str, document_type: DocumentType | str) -> Path:
        if not _CLIENT_CODE.match(client_code or ""):
            raise ValueError(f"client_code inválido: {client_code!r}")
        comp = Competence.parse(competence)
        doc = DocumentType(document_type)
        folder = self.base_dir / client_code / comp.year_str / comp.month_str / doc.value
        return ensure_within(self.base_dir, folder)

    def filename_for(
        self, client_code: str, competence: str, document_type: DocumentType | str, *, sequence: int = 1, ext: str = ".zip"
    ) -> str:
        comp = Competence.parse(competence)
        doc = DocumentType(document_type)
        ext = ext if ext.startswith(".") else f".{ext}"
        suffix = "" if sequence <= 1 else f"_{sequence}"
        return f"{client_code}_{comp.key}_{doc.value}{suffix}{ext.lower()}"

    def target_for(
        self, client_code: str, competence: str, document_type: DocumentType | str, *, ext: str = ".zip"
    ) -> DownloadTarget:
        folder = self.folder_for(client_code, competence, document_type)
        seq = 1
        while True:
            name = self.filename_for(client_code, competence, document_type, sequence=seq, ext=ext)
            if not (folder / name).exists():
                return DownloadTarget(folder, name)
            seq += 1

    def store(
        self, source: Path, client_code: str, competence: str, document_type: DocumentType | str
    ) -> DownloadedFile:
        """Move o arquivo baixado para o destino definitivo, evitando duplicatas idênticas."""
        if not source.exists():
            raise FileNotFoundError(source)
        kind = sniff_kind(source)
        if kind == "html":
            # portal devolveu uma página (sessão expirada/erro) em vez do arquivo
            raise InvalidDownloadError("O portal retornou uma página HTML em vez do arquivo exportado.")
        checksum = sha256_file(source)
        ext = {"zip": ".zip", "xml": ".xml"}.get(kind) or source.suffix or ".zip"
        self.check_available()
        try:
            return self._store(source, client_code, competence, document_type, checksum, ext)
        except DownloadFolderUnavailable:
            raise
        except OSError as exc:
            raise DownloadFolderUnavailable(f"Falha ao gravar em {self.base_dir}: {exc}") from exc

    def _store(
        self, source: Path, client_code: str, competence: str, document_type: DocumentType | str, checksum: str, ext: str
    ) -> DownloadedFile:
        folder = ensure_dir(self.folder_for(client_code, competence, document_type))

        for existing in sorted(folder.glob(f"{client_code}_*{ext}")):
            if existing.is_file() and sha256_file(existing) == checksum:
                source.unlink(missing_ok=True)
                return DownloadedFile(
                    document_type=DocumentType(document_type),
                    filename=existing.name,
                    filepath=str(existing),
                    size=existing.stat().st_size,
                    checksum=checksum,
                )

        target = self.target_for(client_code, competence, document_type, ext=ext)
        final = move_atomic(source, target.path)
        return DownloadedFile(
            document_type=DocumentType(document_type),
            filename=final.name,
            filepath=str(final),
            size=final.stat().st_size,
            checksum=checksum,
        )
