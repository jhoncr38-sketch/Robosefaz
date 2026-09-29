r"""Faz o robô salvar as notas numa pasta do Google Drive.

    ícone do robô / menu Iniciar → Salvar notas no Google Drive   (janela: --gui)
    .venv\Scripts\python.exe -m app.tools.google_drive [--gui] [--local]

1. acha o Google Drive deste computador (G:\Meu Drive, um por conta, ou a pasta do
   modo "Espelhar arquivos");
2. usa a pasta "JR Sistema - Notas" (a compartilhada, via atalho no Meu Drive, ou
   uma nova) e testa a gravação — como administrador, igual ao robô;
3. copia as notas já baixadas para lá (sem apagar nem sobrescrever nada);
4. troca DOWNLOAD_BASE_PATH no .env e religa o robô;
5. confere no log do robô que ele passou a usar a pasta nova; se ele não enxergar, desfaz.

--local volta a salvar só neste computador (storage\downloads).

Saída: 0 = pronto; 1 = nada foi mudado.
"""

from __future__ import annotations

import argparse
import ctypes
import os
import shutil
import string
import subprocess
import sys
import time
import uuid
import webbrowser
from collections.abc import Callable, Iterable
from pathlib import Path

from app.config import PROJECT_ROOT, Settings, get_settings
from app.downloads.organizer import NOTE_FILE, parse_note_path
from app.tools.ui import Choice, ConsoleUI, ToolUI
from app.utils.files import ensure_dir

ENV_FILE = PROJECT_ROOT / ".env"
NOTES_FOLDER = "JR Sistema - Notas"
DRIVE_NAMES = ("Meu Drive", "My Drive")
DRIVE_DOWNLOAD_URL = "https://www.google.com/drive/download/"
TITLE = "Salvar notas no Google Drive"
SUBTITLE = (
    "As notas ficam numa pasta do Google Drive: a equipe baixa de qualquer lugar e todos os "
    "computadores com robô usam a mesma pasta."
)


def _same(a: Path, b: Path) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def drive_letters() -> list[Path]:
    if hasattr(os, "listdrives"):  # Python 3.12+ no Windows
        return [Path(d) for d in os.listdrives()]
    return [Path(f"{letter}:\\") for letter in string.ascii_uppercase if Path(f"{letter}:\\").exists()]


def find_drive_roots(roots: Iterable[Path] | None = None, home: Path | None = None) -> list[Path]:
    """Pastas "Meu Drive" do Google Drive para computador (unidade G:, uma por conta, ou "Espelhar arquivos")."""
    roots = drive_letters() if roots is None else roots
    home = Path.home() if home is None else home
    found: list[Path] = []

    def add(path: Path) -> None:
        try:
            if path.is_dir() and not any(_same(path, f) for f in found):
                found.append(path)
        except OSError:
            pass

    for base in [*roots, home]:
        for name in DRIVE_NAMES:
            add(base / name)
    # com mais de uma conta, o Drive pode mostrar cada uma numa subpasta da unidade
    # (".Encrypted", "$RECYCLE.BIN" e afins são internos: não são contas)
    for base in roots:
        try:
            children = [c for c in base.iterdir() if c.is_dir() and not c.name.startswith((".", "$"))]
        except OSError:
            continue
        for child in children[:50]:
            for name in DRIVE_NAMES:
                if child.name != name:
                    add(child / name)
    return found


def drive_app_running() -> bool:
    try:
        out = subprocess.run(  # noqa: S603, S607
            ["tasklist", "/FI", "IMAGENAME eq GoogleDriveFS.exe", "/NH"],
            capture_output=True,
            text=True,
            timeout=15,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "googledrivefs.exe" in out.lower()


def env_value(path: Path | str) -> str:
    """Valor para o .env: entre aspas simples (espaços; sem escapes) e com barras normais."""
    text = Path(path).as_posix() if isinstance(path, Path) else path
    if "'" in text:
        raise ValueError(f"Caminho com apóstrofo não é suportado: {text}")
    return f"'{text}'"


def probe_write(folder: Path) -> None:
    """Grava, lê e apaga um arquivo de teste (OSError se não der)."""
    probe = folder / f".teste-jr-sistema-{uuid.uuid4().hex}.tmp"
    probe.write_text("ok", encoding="utf-8")
    try:
        if probe.read_text(encoding="utf-8") != "ok":
            raise OSError("o arquivo de teste voltou diferente")
    finally:
        probe.unlink(missing_ok=True)


def count_notes(src: Path) -> int:
    """Quantas notas há em `src` (para o andamento com contagem)."""
    if not src.is_dir():
        return 0
    return sum(1 for f in src.rglob("*") if f.is_file() and NOTE_FILE.match(f.name))


def copy_notes(src: Path, dst: Path, on_progress: Callable[[int], None] | None = None) -> tuple[int, int]:
    """Copia as notas de `src` para `dst` em ano/mês/cliente/tipo. Nunca sobrescreve. -> (copiadas, já existiam)."""
    copied = skipped = 0
    if not src.is_dir() or _same(src, dst):
        return 0, 0
    for file in sorted(src.rglob("*")):
        if not file.is_file() or not NOTE_FILE.match(file.name):
            continue
        rel = file.relative_to(src)
        note = parse_note_path(rel.parts)
        target = dst.joinpath(*note.parts) if note else dst / rel
        if target.exists() or (dst / rel).exists():
            skipped += 1
            continue
        ensure_dir(target.parent)
        tmp = target.with_name(target.name + ".part")
        shutil.copy2(file, tmp)
        os.replace(tmp, target)
        copied += 1
        if on_progress is not None:
            on_progress(copied)
    return copied, skipped


def _account_changed(settings: Settings, target: Path) -> bool:
    """Mesmo caminho (ex.: G:\\Meu Drive\\...), mas outra conta do Google conectada no lugar."""
    from app.downloads.drive_ids import drivefs_databases, linked_account, probe_account

    previous = linked_account(settings.drive_link_file)
    if previous is None:
        return False
    db = probe_account(target, drivefs_databases(), timeout=20)
    return db is not None and db.parent.name != previous


def set_download_path(env_file: Path, value: str) -> None:
    from app.tools.activate import set_env_values

    set_env_values(env_file, {"DOWNLOAD_BASE_PATH": value})


def _read_from(path: Path | None, offset: int) -> str:
    if path is None or not path.is_file():
        return ""
    with path.open("rb") as fh:
        size = path.stat().st_size
        fh.seek(offset if offset <= size else 0)  # log recomeçado: lê do início
        return fh.read().decode("utf-8", errors="replace")


def restart_and_confirm(settings: Settings, target: Path, timeout: float = 150) -> str:
    """Religa o robô e lê o log dele. -> "ok" | "unavailable" | "stopped" | "timeout"."""
    from app.tray import read_local_status

    if read_local_status(settings.status_file)[0] == "stopped":
        return "stopped"
    log_file = settings.log_file
    offset = log_file.stat().st_size if log_file and log_file.is_file() else 0
    # mesmo sinal do "Atualizar agora": o robô termina o trabalho atual, encerra e o serviço o religa
    settings.update_flag.write_text("pasta-das-notas", encoding="utf-8")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(2)
        for line in _read_from(log_file, offset).splitlines():
            if "Downloads serão salvos em" in line:
                folder = line.split("Downloads serão salvos em", 1)[1].strip()
                return "ok" if _same(Path(folder), target) else "unavailable"
            if "Pasta de downloads indisponível" in line:
                return "unavailable"
    return "timeout"


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError):
        return False


def _ask(question: str) -> str:
    try:
        return input(question).strip()
    except EOFError:
        return ""


def _drive_not_found(ui: ToolUI) -> None:
    if drive_app_running():
        ui.done(
            False,
            "Não encontrei a unidade do Google Drive",
            "O Google Drive está aberto, mas a unidade dele não aparece para programas de administrador "
            "(o robô roda assim). Isso acontece em alguns computadores e tem solução com um ajuste do "
            "Windows: fale com o suporte do JR Sistema.",
        )
        return
    ui.done(
        False,
        "Não encontrei o Google Drive neste computador",
        "1. Instale o Google Drive para computador.\n"
        "2. Abra o Google Drive e entre na conta Google.\n"
        "3. Rode esta ferramenta de novo.\n\n"
        f"Download: {DRIVE_DOWNLOAD_URL}",
        actions=[("Baixar o Google Drive", lambda: webbrowser.open(DRIVE_DOWNLOAD_URL))],
    )


def _choose_root(roots: list[Path], ui: ToolUI) -> Path | None:
    if len(roots) == 1:
        return roots[0]
    has = [(root / NOTES_FOLDER).is_dir() for root in roots]
    choices = [
        Choice(
            str(root),
            badge=f'já tem a pasta "{NOTES_FOLDER}"' if h else "",
            detail="" if h else f'A pasta "{NOTES_FOLDER}" ainda não existe aqui: ela seria criada.',
        )
        for root, h in zip(roots, has, strict=True)
    ]
    default = has.index(True) if True in has else 0
    picked = ui.choose(
        "Encontrei mais de um Google Drive (mais de uma conta) neste computador. Em qual as notas devem ficar?",
        choices,
        default=default,
    )
    return roots[picked] if picked is not None else None


def _pick_target(settings: Settings, local: bool, ui: ToolUI) -> Path | None:
    if local:
        return settings.local_downloads_dir
    ui.status("Procurando o Google Drive…")
    roots = find_drive_roots()
    ui.status("")
    if not roots:
        _drive_not_found(ui)
        return None
    root = _choose_root(roots, ui)
    if root is None:
        return None
    target = root / NOTES_FOLDER
    if target.is_dir():
        ui.ok(f"Pasta encontrada: {target}")
        return target
    if not ui.confirm(
        f'Não encontrei a pasta "{NOTES_FOLDER}" em {root}. Criar uma pasta nova aqui?',
        "Se a pasta foi compartilhada com você por outro computador, cancele e faça antes: "
        "drive.google.com → Compartilhados comigo → botão direito na pasta → Organizar → "
        "Adicionar atalho → Meu Drive. Espere 1 minuto e rode esta ferramenta de novo.",
        yes="Criar a pasta",
        no="Cancelar",
    ):
        return None
    target.mkdir()
    ui.ok(f"Pasta criada: {target}")
    return target


def run(
    settings: Settings,
    *,
    local: bool = False,
    ask: Callable[[str], str] = _ask,
    env_file: Path = ENV_FILE,
    ui: ToolUI | None = None,
) -> int:
    ui = ui or ConsoleUI(ask)
    current = settings.downloads_dir
    ui.info(f"Hoje as notas vão para: {current}")
    if not is_admin():
        ui.warn("Rode pelo ícone do robô ou pelo menu Iniciar: eles pedem permissão de administrador, igual ao robô.")

    target = _pick_target(settings, local, ui)
    if target is None:
        ui.done(False, "Nada foi mudado", f"O robô continua salvando em {current}")
        return 1

    ui.status("Testando a gravação…")
    try:
        ensure_dir(target)
        probe_write(target)
    except OSError as exc:
        ui.done(
            False,
            f"Não consegui gravar em {target}",
            f"{exc}\n\n"
            "• Se a pasta foi compartilhada com você, peça para mudar você de Leitor para Editor.\n"
            "• Confira se o Google Drive está aberto e conectado (ícone ao lado do relógio).\n\n"
            f"Nada foi mudado: o robô continua salvando em {current}",
        )
        return 1
    ui.ok("Gravação OK.")

    if _same(current, target) and not _account_changed(settings, target):
        ui.done(True, "O robô já salva nesta pasta", "Está tudo certo.")
        return 0

    sources = [current]
    if not any(_same(settings.local_downloads_dir, p) for p in (current, target)):
        sources.append(settings.local_downloads_dir)  # notas do plano B e as antigas deste computador
    total = sum(count_notes(src) for src in sources)
    ui.status(f"Copiando as notas já baixadas: {total} nota(s). Nada é apagado nem sobrescrito.")
    copied = skipped = 0
    seen = 0  # copiadas + já existentes, para a contagem andar até o fim
    for src in sources:
        base = seen

        def advance(n: int, base: int = base) -> None:
            ui.progress(base + n, total)
            ui.status(f"Copiando as notas já baixadas… {base + n} de {total}")

        try:
            c, s = copy_notes(src, target, on_progress=advance)
        except OSError as exc:
            ui.done(
                False,
                f"Não consegui copiar as notas de {src}",
                f"{exc}\n\nNada foi mudado na configuração: o robô continua salvando em {current}",
            )
            return 1
        copied, skipped = copied + c, skipped + s
        seen += c + s
    ui.progress(total, total)
    ui.ok(f"{copied} nota(s) copiada(s); {skipped} já estava(m) lá.")
    # tudo o que estava na pasta local já foi para a pasta nova
    settings.pending_notes_file.unlink(missing_ok=True)

    previous = settings.download_base_path
    set_download_path(env_file, env_value(target))
    ui.status("Religando o robô com a pasta nova (se ele estiver trabalhando, espera terminar)…")
    result = restart_and_confirm(settings, target)
    if result == "ok":
        ui.done(True, "Pronto!", f"O robô já está salvando as notas em {target}")
        return 0
    if result == "stopped":
        ui.done(True, "Pronto!", f"O robô está desligado; quando ligar, salva as notas em {target}")
        return 0
    if result == "timeout":
        ui.done(
            True,
            "Configuração trocada",
            f"O robô ainda está terminando um trabalho e passa a salvar em {target} assim que terminar "
            "(nada se perde).",
        )
        return 0
    # o robô (administrador) não enxergou a pasta: volta como estava
    set_download_path(env_file, env_value(Path(previous)))
    settings.update_flag.write_text("pasta-das-notas", encoding="utf-8")
    ui.done(
        False,
        "O robô não conseguiu enxergar a pasta nova",
        f"Voltei a configuração como estava: ele continua salvando em {current}. As notas copiadas "
        f"continuam em {target}.\n\nFale com o suporte do JR Sistema: em alguns computadores o Windows "
        "esconde a unidade do Google Drive de programas de administrador, e isso tem solução.",
    )
    return 1


def run_gui(local: bool) -> int:
    from app.tools.gui import relaunch_as_admin, run_in_window

    if not is_admin():
        return relaunch_as_admin(["-m", "app.tools.google_drive", "--gui", *(["--local"] if local else [])])
    title = "Salvar notas só neste computador" if local else TITLE
    subtitle = "As notas voltam para a pasta do robô neste computador (storage\\downloads)." if local else SUBTITLE
    return run_in_window(title, subtitle, lambda ui: run(get_settings(), local=local, ui=ui))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Faz o robô salvar as notas numa pasta do Google Drive.")
    parser.add_argument("--local", action="store_true", help="voltar a salvar só neste computador")
    parser.add_argument("--gui", action="store_true", help="janela em vez da tela preta")
    args = parser.parse_args(argv)
    if args.gui:
        return run_gui(args.local)
    print("JR Sistema — " + ("Salvar notas só neste computador" if args.local else TITLE))
    print("=" * 70)
    try:
        return run(get_settings(), local=args.local)
    except Exception as exc:  # noqa: BLE001 - mensagem clara em vez de rastro de erro
        print()
        print(f"Erro inesperado: {exc}")
        print("Nada foi apagado. Se a mensagem continuar, fale com o suporte do JR Sistema.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
