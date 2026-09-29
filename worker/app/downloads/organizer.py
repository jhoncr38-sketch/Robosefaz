"""Organização dos arquivos baixados por competência e cliente.

{pasta das notas}/{ano}/{mês}/{nome da empresa}/{NFCE|NFE_EMITIDAS|NFE_RECEBIDAS}/
Nome: {client_code}_{YYYY-MM}_{TIPO}.zip  (sufixo _2, _3... para lotes múltiplos)

Mês primeiro (desde a 1.2.8): "todas as notas de 09/2026" e "LIA 08/2026" são uma
pasta só, que o Google Drive baixa inteira como ZIP.

A pasta do cliente tem só o nome da empresa (desde a 1.2.11). Quem é o dono da
pasta vem das notas dentro dela: o nome do arquivo sempre começa pelo código do
cliente. Assim, se o nome mudar no painel, o robô acha a pasta antiga e renomeia;
se duas empresas tiverem o mesmo nome, a segunda fica "NOME (CLI000013)".
Pastas antigas "CLI000001 - NOME" (até a 1.2.10) são renomeadas sozinhas.

Ao juntar pastas, nada é sobrescrito nem apagado: cópia idêntica de uma nota que
já está no lugar novo vai para _Duplicadas (fora dos meses; o usuário apaga se
quiser); arquivo diferente com o mesmo nome ganha _2, _3...

Notas no formato antigo (cliente/ano/mês/tipo) são movidas por `reorganize`:
só move, nunca apaga nota.
"""

from __future__ import annotations

import logging
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

from app.jobs.models import DocumentType, DownloadedFile
from app.utils.competence import Competence
from app.utils.files import ensure_dir, ensure_within, move_atomic, sha256_file, sniff_kind

log = logging.getLogger("downloads")

_CLIENT_CODE = re.compile(r"^[A-Z0-9]{3,20}$")
_CLIENT_FOLDER = re.compile(r"^(?P<code>[A-Z0-9]{3,20})(?: - (?P<name>.+))?$")
_YEAR = re.compile(r"^\d{4}$")
_MONTH = re.compile(r"^(0[1-9]|1[0-2])$")
_DOC_VALUES = {d.value for d in DocumentType}
DUPLICATES_FOLDER = "_Duplicadas"
_INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')
# arquivo de nota do robô: CLI000001_2026-08_NFCE.zip (lotes: _2, _3...)
NOTE_FILE = re.compile(r"^[A-Z0-9]{3,20}_\d{4}-\d{2}_(NFCE|NFE_EMITIDAS|NFE_RECEBIDAS)(_\d+)?\.(zip|xml)$", re.IGNORECASE)


def safe_folder_name(name: str | None, max_len: int = 60) -> str:
    """Nome de empresa válido como pasta do Windows (sem < > : " / \\ | ? *)."""
    cleaned = _INVALID_CHARS.sub(" ", name or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()[:max_len]
    return cleaned.rstrip(" .")


@dataclass(frozen=True, slots=True)
class NotePath:
    """Nota identificada pelo caminho relativo à pasta das notas (formato novo ou antigo)."""

    client_folder: str
    client_code: str
    client_name: str | None
    year: str
    month: str
    document_type: str
    filename: str

    @property
    def competence(self) -> str:
        return f"{self.year}-{self.month}"

    @property
    def parts(self) -> tuple[str, str, str, str, str]:
        """Caminho no formato atual: ano/mês/cliente/tipo/arquivo."""
        return (self.year, self.month, self.client_folder, self.document_type, self.filename)


def note_code(filename: str) -> str | None:
    """Código do cliente pelo nome do arquivo de nota (CLI000001_2026-08_NFCE.zip -> CLI000001)."""
    return filename.split("_", 1)[0] if NOTE_FILE.match(filename) else None


def client_name_from_folder(folder: str, client_code: str) -> str | None:
    """Nome da empresa pela pasta: "NOME", "NOME (CÓDIGO)" ou o antigo "CÓDIGO - NOME"."""
    if folder == client_code:
        return None
    if folder.startswith(f"{client_code} - "):
        return folder[len(client_code) + 3 :] or None
    if folder.endswith(f" ({client_code})"):
        return folder[: -(len(client_code) + 3)] or None
    return folder


def parse_note_path(parts: tuple[str, ...] | list[str]) -> NotePath | None:
    """ano/mês/cliente/tipo/arquivo (atual) ou cliente/ano/mês/tipo/arquivo (antigo, até a 1.2.7)."""
    if len(parts) != 5 or parts[3] not in _DOC_VALUES:
        return None
    code = note_code(parts[4])
    if code is None or not _CLIENT_CODE.match(code):
        return None
    if _YEAR.match(parts[0]) and _MONTH.match(parts[1]):
        year, month, folder = parts[0], parts[1], parts[2]
    elif _YEAR.match(parts[1]) and _MONTH.match(parts[2]):
        folder, year, month = parts[0], parts[1], parts[2]
    else:
        return None
    return NotePath(folder, code, client_name_from_folder(folder, code), year, month, parts[3], parts[4])


class InvalidDownloadError(ValueError):
    pass


class EmptyExportError(InvalidDownloadError):
    """O SIAT entregou um ZIP sem nenhum arquivo: não houve nota no período."""


def is_empty_zip(path: Path) -> bool:
    try:
        with zipfile.ZipFile(path) as zf:
            return not zf.namelist()
    except (zipfile.BadZipFile, OSError):
        return False


class DownloadFolderUnavailable(OSError):
    """Pasta de downloads inacessível (ex.: unidade externa ou de rede desconectada)."""


@dataclass(frozen=True, slots=True)
class DownloadTarget:
    folder: Path
    filename: str

    @property
    def path(self) -> Path:
        return self.folder / self.filename


def _remove_empty_dirs(root: Path) -> None:
    """Apaga pastas que ficaram vazias (só com desktop.ini do Windows) depois de mover as notas."""
    if not root.is_dir():
        return
    for folder in sorted((p for p in root.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        _rmdir_if_empty(folder)
    _rmdir_if_empty(root)


def _rmdir_if_empty(folder: Path) -> None:
    try:
        entries = list(folder.iterdir())
        if any(e.name.lower() != "desktop.ini" for e in entries):
            return
        for e in entries:
            e.unlink()
        folder.rmdir()
    except OSError:
        pass  # em uso (ex.: aberta no Explorer): fica para a próxima


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

        `filepath` foi gravado pela máquina que baixou; em outra máquina (pasta em
        outra letra/usuário) ou depois de reorganizar, vale o caminho padrão
        ano/mês/cliente/tipo.
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

    def month_dir(self, competence: str) -> Path:
        comp = Competence.parse(competence)
        return self.base_dir / comp.year_str / comp.month_str

    def _month_dirs(self) -> list[Path]:
        if not self.base_dir.is_dir():
            return []
        out: list[Path] = []
        for year in self.base_dir.iterdir():
            if year.is_dir() and _YEAR.match(year.name):
                out += [m for m in year.iterdir() if m.is_dir() and _MONTH.match(m.name)]
        return sorted(out)

    @staticmethod
    def _note_codes(folder: Path) -> set[str]:
        """Códigos dos clientes das notas dentro da pasta (tipo/arquivo)."""
        codes: set[str] = set()
        try:
            for f in folder.glob("*/*"):
                code = note_code(f.name)
                if code:
                    codes.add(code)
        except OSError:
            pass
        return codes

    @classmethod
    def _belongs_to(cls, folder: Path, client_code: str) -> bool:
        name = folder.name
        if name == client_code or name.startswith(f"{client_code} - ") or name.endswith(f" ({client_code})"):
            return True
        return client_code in cls._note_codes(folder)

    @classmethod
    def _existing_client_dirs(cls, client_code: str, parent: Path) -> list[Path]:
        """Pastas deste cliente no mês (pelo nome antigo com código ou pelas notas dentro)."""
        if not parent.is_dir():
            return []
        try:
            dirs = [d for d in parent.iterdir() if d.is_dir()]
        except OSError:
            return []
        return sorted(d for d in dirs if cls._belongs_to(d, client_code))

    def _client_dir_in(self, parent: Path, client_code: str, client_name: str | None) -> Path:
        if not _CLIENT_CODE.match(client_code or ""):
            raise ValueError(f"client_code inválido: {client_code!r}")
        safe = safe_folder_name(client_name)
        if safe:
            folder = parent / safe
            if folder.is_dir():
                codes = self._note_codes(folder)
                if codes and client_code not in codes:
                    folder = parent / f"{safe} ({client_code})"  # outra empresa com o mesmo nome
            return ensure_within(self.base_dir, folder)
        existing = self._existing_client_dirs(client_code, parent)
        return existing[0] if existing else ensure_within(self.base_dir, parent / client_code)

    def client_dir(self, client_code: str, client_name: str | None, competence: str) -> Path:
        """Pasta do cliente no mês: o nome da empresa; sem nome, a que já existir para o código."""
        return self._client_dir_in(self.month_dir(competence), client_code, client_name)

    def _place(self, file: Path, target: Path) -> bool:
        """Move `file` para `target` sem sobrescrever nem apagar nada.

        Já existe lá a mesma coisa: a cópia vai para _Duplicadas. Existe outro
        arquivo com o mesmo nome: este ganha _2, _3... -> se moveu.
        """
        try:
            if target.exists():
                if target.is_file() and sha256_file(target) == sha256_file(file):
                    target = self.base_dir / DUPLICATES_FOLDER / file.relative_to(self.base_dir)
                    if target.exists():
                        return False
                else:
                    n = 2
                    while (alt := target.with_name(f"{target.stem}_{n}{target.suffix}")).exists():
                        n += 1
                    target = alt
            ensure_dir(target.parent)
            file.rename(target)
            return True
        except (OSError, ValueError) as exc:
            log.warning("Não foi possível mover %s para %s: %s", file, target, exc)
            return False

    def _merge_into(self, src: Path, dst: Path) -> None:
        """Junta a pasta antiga do cliente na atual (só move; veja _place)."""
        for file in sorted(p for p in src.rglob("*") if p.is_file()):
            if file.name.lower() != "desktop.ini":
                self._place(file, dst / file.relative_to(src))
        _remove_empty_dirs(src)

    def _sync_in(self, parent: Path, client_code: str, client_name: str | None) -> Path | None:
        """Deixa a pasta do cliente neste mês com o nome atual da empresa."""
        if not safe_folder_name(client_name) or not _CLIENT_CODE.match(client_code or ""):
            return None
        desired = self._client_dir_in(parent, client_code, client_name)
        existing = [d for d in self._existing_client_dirs(client_code, parent) if d != desired]
        if not existing:
            return desired if desired.is_dir() else None
        for old in existing:
            if not desired.exists():
                try:
                    old.rename(desired)
                    continue
                except OSError:
                    return old  # pasta em uso (ex.: aberta no Explorer): tenta de novo depois
            self._merge_into(old, desired)
        return desired

    def sync_client_dir(self, client_code: str, client_name: str | None, competence: str | None = None) -> list[Path]:
        """Nome da empresa nas pastas do cliente (num mês ou em todos)."""
        parents = [self.month_dir(competence)] if competence else self._month_dirs()
        return [d for p in parents if (d := self._sync_in(p, client_code, client_name)) is not None]

    def sync_client_names(self, names: dict[str, str | None]) -> int:
        """Todas as pastas de todos os meses de uma vez (início do robô). -> quantas renomeou ou juntou."""
        changed = 0
        for month in self._month_dirs():
            try:
                entries = [d for d in month.iterdir() if d.is_dir()]
            except OSError:
                continue
            codes: set[str] = set()
            for d in entries:
                m = _CLIENT_FOLDER.match(d.name)
                if m and m["code"] in names:
                    codes.add(m["code"])  # formato antigo "CÓDIGO - NOME"
                codes |= self._note_codes(d) & names.keys()
            for code in sorted(codes):
                before = set(p.name for p in entries)
                self._sync_in(month, code, names[code])
                after = set(p.name for p in month.iterdir() if p.is_dir())
                changed += int(before != after)
                entries = [month / n for n in after]
        return changed

    def folder_for(
        self, client_code: str, competence: str, document_type: DocumentType | str, client_name: str | None = None
    ) -> Path:
        doc = DocumentType(document_type)
        folder = self.client_dir(client_code, client_name, competence) / doc.value
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

    def reorganize(self) -> int:
        """Move o formato antigo (cliente/ano/mês/...) para ano/mês/cliente/...

        Leva as notas e também o que estiver junto delas no mês (ex.: XMLs que
        alguém descompactou ali), mantendo as subpastas. Só move (no Google Drive,
        mover mantém o arquivo e o link); se já existe no lugar novo, fica onde
        está. -> quantos arquivos moveu.
        """
        if not self.base_dir.is_dir():
            return 0
        moved = 0
        for client in sorted(self.base_dir.iterdir()):
            if not client.is_dir() or _YEAR.match(client.name) or not _CLIENT_FOLDER.match(client.name):
                continue
            for file in sorted(client.rglob("*")):
                if not file.is_file() or file.name.lower() == "desktop.ini":
                    continue
                rel = file.relative_to(client).parts  # (ano, mês, ...)
                if len(rel) < 3 or not _YEAR.match(rel[0]) or not _MONTH.match(rel[1]):
                    continue  # fora de ano/mês: não é do robô, fica
                target = self.base_dir.joinpath(rel[0], rel[1], client.name, *rel[2:])
                moved += int(self._place(file, target))
            _remove_empty_dirs(client)
        if moved:
            log.info("%s nota(s) reorganizada(s) em ano/mês/cliente em %s.", moved, self.base_dir)
        return moved

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
        if kind == "zip" and is_empty_zip(source):
            raise EmptyExportError("O SIAT entregou um ZIP vazio: nenhuma nota no período.")
        checksum = sha256_file(source)
        ext = {"zip": ".zip", "xml": ".xml"}.get(kind) or source.suffix or ".zip"
        self.check_available()
        try:
            if client_name:
                month = self.month_dir(competence)
                # renomeia/junta só na 1ª nota do cliente no mês (ou se o nome mudou)
                if not self.client_dir(client_code, client_name, competence).is_dir():
                    self._sync_in(month, client_code, client_name)
                # pasta antiga em uso (não renomeou): grava nela em vez de criar uma segunda pasta do cliente
                if not self.client_dir(client_code, client_name, competence).is_dir() and self._existing_client_dirs(
                    client_code, month
                ):
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
