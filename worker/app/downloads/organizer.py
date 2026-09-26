"""Organização dos arquivos baixados por cliente e competência.

storage/downloads/{client_code} - {nome da empresa}/{year}/{month}/{NFCE|NFE_EMITIDAS|NFE_RECEBIDAS}/
Nome: {client_code}_{YYYY-MM}_{TIPO}.zip  (sufixo _2, _3... para lotes múltiplos)

A pasta do cliente começa sempre pelo código (CLI000001 - LIA PAPELARIA): o
nome pode mudar ou se repetir, o código não. Se o nome mudar no painel, a
pasta existente é renomeada; pastas antigas só com o código também.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from app.jobs.models import DocumentType, DownloadedFile
from app.utils.competence import Competence
from app.utils.files import ensure_dir, ensure_within, move_atomic, sha256_file, sniff_kind

_CLIENT_CODE = re.compile(r"^[A-Z0-9]{3,20}$")
_INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')


def safe_folder_name(name: str | None, max_len: int = 60) -> str:
    """Nome de empresa válido como pasta do Windows (sem < > : " / \\ | ? *)."""
    cleaned = _INVALID_CHARS.sub(" ", name or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()[:max_len]
    return cleaned.rstrip(" .")


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

    def _existing_client_dirs(self, client_code: str) -> list[Path]:
        if not self.base_dir.is_dir():
            return []
        prefix = re.compile(rf"^{re.escape(client_code)}( - .+)?$")
        return sorted(d for d in self.base_dir.iterdir() if d.is_dir() and prefix.match(d.name))

    def client_dir(self, client_code: str, client_name: str | None = None) -> Path:
        """Pasta do cliente: 'CLI000001 - NOME'; sem nome, a pasta que já existir para o código."""
        if not _CLIENT_CODE.match(client_code or ""):
            raise ValueError(f"client_code inválido: {client_code!r}")
        safe = safe_folder_name(client_name)
        if safe:
            return ensure_within(self.base_dir, self.base_dir / f"{client_code} - {safe}")
        existing = self._existing_client_dirs(client_code)
        return existing[0] if existing else self.base_dir / client_code

    def sync_client_dir(self, client_code: str, client_name: str | None) -> Path | None:
        """Renomeia a pasta existente do cliente para 'CÓDIGO - NOME' (nome novo ou pasta antiga só com código)."""
        desired = self.client_dir(client_code, client_name)
        existing = [d for d in self._existing_client_dirs(client_code) if d != desired]
        if not existing:
            return desired if desired.is_dir() else None
        if desired.exists():
            return desired  # já existe a certa; a antiga fica (não mistura arquivos)
        try:
            existing[0].rename(desired)
            return desired
        except OSError:
            return existing[0]  # pasta em uso (ex.: aberta no Explorer): tenta de novo depois

    def folder_for(
        self, client_code: str, competence: str, document_type: DocumentType | str, client_name: str | None = None
    ) -> Path:
        comp = Competence.parse(competence)
        doc = DocumentType(document_type)
        folder = self.client_dir(client_code, client_name) / comp.year_str / comp.month_str / doc.value
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
        self,
        client_code: str,
        competence: str,
        document_type: DocumentType | str,
        *,
        ext: str = ".zip",
        client_name: str | None = None,
    ) -> DownloadTarget:
        folder = self.folder_for(client_code, competence, document_type, client_name)
        seq = 1
        while True:
            name = self.filename_for(client_code, competence, document_type, sequence=seq, ext=ext)
            if not (folder / name).exists():
                return DownloadTarget(folder, name)
            seq += 1

    def store(
        self,
        source: Path,
        client_code: str,
        competence: str,
        document_type: DocumentType | str,
        client_name: str | None = None,
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
            if client_name:
                self.sync_client_dir(client_code, client_name)
                # pasta antiga em uso (não renomeou): grava nela em vez de criar uma segunda pasta do cliente
                if not self.client_dir(client_code, client_name).is_dir() and self._existing_client_dirs(client_code):
                    client_name = None
            return self._store(source, client_code, competence, document_type, checksum, ext, client_name)
        except DownloadFolderUnavailable:
            raise
        except OSError as exc:
            raise DownloadFolderUnavailable(f"Falha ao gravar em {self.base_dir}: {exc}") from exc

    def _store(
        self,
        source: Path,
        client_code: str,
        competence: str,
        document_type: DocumentType | str,
        checksum: str,
        ext: str,
        client_name: str | None = None,
    ) -> DownloadedFile:
        folder = ensure_dir(self.folder_for(client_code, competence, document_type, client_name))

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

        target = self.target_for(client_code, competence, document_type, ext=ext, client_name=client_name)
        final = move_atomic(source, target.path)
        return DownloadedFile(
            document_type=DocumentType(document_type),
            filename=final.name,
            filepath=str(final),
            size=final.stat().st_size,
            checksum=checksum,
        )
