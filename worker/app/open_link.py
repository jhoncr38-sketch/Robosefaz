r"""Abre a pasta de uma nota a partir do painel (link siatrobo://abrir/<id>).

O instalador registra o protocolo "siatrobo" no Windows deste usuário. Ao
clicar em "Abrir pasta" no painel, o navegador chama:

    pythonw.exe worker\abrir_nota.pyw "siatrobo://abrir/<id do download>"

Segurança: o link só carrega o ID (UUID) do download. O caminho vem do banco
e só é aberto se for um arquivo de nota do robô (CLI000001_2026-08_NFCE.zip);
nada do link é executado ou usado como caminho.
"""

from __future__ import annotations

import ctypes
import re
import subprocess
import sys
from pathlib import Path

from app.config import Settings, get_settings
from app.downloads.fallback import organizer_for
from app.downloads.organizer import NOTE_FILE as _NOTE_FILE
from app.downloads.organizer import DownloadOrganizer

_LINK = re.compile(r"^siatrobo://abrir/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/?$", re.IGNORECASE)
TITLE = "JR Sistema Robô"


def parse_link(link: str) -> str | None:
    m = _LINK.match(link.strip())
    return m.group(1).lower() if m else None


def resolve_file(row: dict, organizer: DownloadOrganizer) -> Path | None:
    """Arquivo da nota neste computador.

    Primeiro na pasta das notas atual (ex.: Google Drive, depois de trocar a pasta);
    senão, no caminho gravado na hora do download.
    """
    client_code = (row.get("clients") or {}).get("client_code") or ""
    try:
        current = organizer.locate(row["filepath"], client_code, row["competence"], row["document_type"], row["filename"])
        if _NOTE_FILE.match(current.name) and current.is_file():
            return current
    except (ValueError, KeyError):
        pass
    stored = Path(row.get("filepath") or "")
    return stored if _NOTE_FILE.match(stored.name) and stored.is_file() else None


def explorer_select_command(path: Path) -> str:
    """Linha de comando do Explorer com o arquivo selecionado.

    O Explorer só entende /select com as aspas em volta do CAMINHO
    (/select,"C:\\...\\CLI000001 - EMPRESA\\x.zip"). Passar uma lista ao
    subprocess põe aspas no argumento inteiro e, com espaços no caminho, o
    Explorer ignora o pedido e abre Documentos. Caminhos do Windows não têm aspas.
    """
    text = str(path)
    if '"' in text:
        raise ValueError("Caminho inválido")
    return f'explorer.exe /select,"{text}"'


def _message(text: str, error: bool = False) -> None:
    flags = 0x10 if error else 0x40  # MB_ICONERROR | MB_ICONINFORMATION
    ctypes.windll.user32.MessageBoxW(None, text, TITLE, flags | 0x10000)  # MB_SETFOREGROUND


def open_download(download_id: str, settings: Settings) -> None:
    from app.services.supabase_client import create_sync_client

    if not settings.supabase_configured:
        _message("Este computador não está ativado. Ative-o pelo menu Iniciar → JR Sistema.", error=True)
        return
    db = create_sync_client(settings)
    rows = (
        db.table("downloads")
        .select("filepath, filename, competence, document_type, clients(client_code)")
        .eq("id", download_id)
        .limit(1)
        .execute()
    ).data
    if not rows:
        _message("Este download não existe mais (o histórico é apagado 60 dias depois do download).", error=True)
        return
    path = resolve_file(rows[0], organizer_for(settings))
    if path is None:
        folder = settings.downloads_dir
        folder.mkdir(parents=True, exist_ok=True)
        subprocess.Popen(["explorer.exe", str(folder)])  # noqa: S603, S607
        _message(
            f"O arquivo {rows[0]['filename']} não está neste computador.\n\n"
            "Ele fica no computador que fez o download (ou foi apagado da pasta). "
            "Abri a pasta de notas deste computador."
        )
        return
    subprocess.Popen(explorer_select_command(path))  # noqa: S603


def open_notes_folder(settings: Settings) -> None:
    """Menu Iniciar → JR Sistema → Pasta das notas (a pasta configurada, ex.: Google Drive)."""
    folder = settings.downloads_dir
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError:
        _message(
            f"A pasta das notas não está disponível agora:\n{folder}\n\n"
            "Se ela fica no Google Drive, confira se o Google Drive está aberto. Abri a pasta local do robô.",
            error=True,
        )
        folder = settings.local_downloads_dir
        folder.mkdir(parents=True, exist_ok=True)
    subprocess.Popen(["explorer.exe", str(folder)])  # noqa: S603, S607


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "--pasta":
        open_notes_folder(get_settings())
        return
    download_id = parse_link(argv[0]) if argv else None
    if download_id is None:
        _message("Link inválido.", error=True)
        return
    try:
        open_download(download_id, get_settings())
    except Exception as exc:  # noqa: BLE001 - sem internet etc.
        _message(f"Não foi possível abrir a nota: {exc}", error=True)


if __name__ == "__main__":
    main()
