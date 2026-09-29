r"""Faz o robô salvar as notas numa pasta do Google Drive.

    menu Iniciar → JR Sistema → Salvar notas no Google Drive   (salvar-notas-no-drive.bat)
    .venv\Scripts\python.exe -m app.tools.google_drive [--local]

1. acha o Google Drive deste computador (G:\Meu Drive ou a pasta do modo "Espelhar arquivos");
2. usa a pasta "JR Sistema - Notas" (a compartilhada, via atalho no Meu Drive, ou uma nova)
   e testa a gravação — como administrador, igual ao robô;
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
from collections.abc import Callable, Iterable
from pathlib import Path

from app.config import PROJECT_ROOT, Settings, get_settings
from app.downloads.organizer import NOTE_FILE, parse_note_path
from app.utils.files import ensure_dir

ENV_FILE = PROJECT_ROOT / ".env"
NOTES_FOLDER = "JR Sistema - Notas"
DRIVE_NAMES = ("Meu Drive", "My Drive")
DRIVE_DOWNLOAD_URL = "https://www.google.com/drive/download/"


def _same(a: Path, b: Path) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def drive_letters() -> list[Path]:
    if hasattr(os, "listdrives"):  # Python 3.12+ no Windows
        return [Path(d) for d in os.listdrives()]
    return [Path(f"{letter}:\\") for letter in string.ascii_uppercase if Path(f"{letter}:\\").exists()]


def find_drive_roots(roots: Iterable[Path] | None = None, home: Path | None = None) -> list[Path]:
    """Pastas "Meu Drive" do Google Drive para computador (unidade G: ou modo "Espelhar arquivos")."""
    roots = drive_letters() if roots is None else roots
    home = Path.home() if home is None else home
    found: list[Path] = []
    for base in [*roots, home]:
        for name in DRIVE_NAMES:
            path = base / name
            try:
                if path.is_dir() and not any(_same(path, f) for f in found):
                    found.append(path)
            except OSError:
                continue
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


def copy_notes(src: Path, dst: Path) -> tuple[int, int]:
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
    return copied, skipped


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


def _choose(roots: list[Path], ask: Callable[[str], str]) -> Path:
    if len(roots) == 1:
        return roots[0]
    print("Encontrei mais de um Google Drive neste computador:")
    for i, root in enumerate(roots, 1):
        print(f"  {i}) {root}")
    answer = ask(f"Qual usar? [1-{len(roots)}, Enter = 1] ")
    try:
        return roots[int(answer) - 1] if answer else roots[0]
    except (ValueError, IndexError):
        return roots[0]


def _drive_not_found() -> None:
    print("Não encontrei o Google Drive neste computador.")
    print()
    if drive_app_running():
        print("O Google Drive está aberto, mas a unidade dele não aparece para programas de administrador")
        print("(o robô roda assim). Isso acontece em alguns computadores e tem solução com um ajuste do")
        print("Windows: fale com o suporte do JR Sistema.")
    else:
        print(f"  1. Instale o Google Drive para computador: {DRIVE_DOWNLOAD_URL}")
        print("  2. Abra o Google Drive e entre na conta Google.")
        print("  3. Rode de novo: menu Iniciar → JR Sistema → Salvar notas no Google Drive.")


def _pick_target(settings: Settings, local: bool, ask: Callable[[str], str]) -> Path | None:
    if local:
        return settings.local_downloads_dir
    print("Procurando o Google Drive...")
    roots = find_drive_roots()
    if not roots:
        _drive_not_found()
        return None
    root = _choose(roots, ask)
    target = root / NOTES_FOLDER
    if target.is_dir():
        print(f"Pasta encontrada: {target}")
        return target
    print(f'Não encontrei a pasta "{NOTES_FOLDER}" em {root}.')
    print()
    print("Se ela foi compartilhada com você: abra drive.google.com → Compartilhados comigo →")
    print("botão direito na pasta → Organizar → Adicionar atalho → Meu Drive. Espere 1 minuto")
    print("e rode esta ferramenta de novo.")
    print()
    if ask(f'Ou criar uma pasta nova "{NOTES_FOLDER}" neste Drive? [s/N] ').lower() not in ("s", "sim"):
        return None
    target.mkdir()
    return target


def run(settings: Settings, *, local: bool = False, ask: Callable[[str], str] = _ask, env_file: Path = ENV_FILE) -> int:
    current = settings.downloads_dir
    print(f"Hoje as notas vão para: {current}")
    print()
    if not is_admin():
        print("Aviso: rode pelo menu Iniciar (ele pede permissão de administrador, igual ao robô).")
        print()

    target = _pick_target(settings, local, ask)
    if target is None:
        print()
        print(f"Nada foi mudado: o robô continua salvando em {current}")
        return 1

    print("Testando a gravação...")
    try:
        ensure_dir(target)
        probe_write(target)
    except OSError as exc:
        print(f"Não consegui gravar em {target}: {exc}")
        print()
        print("  - Se a pasta foi compartilhada com você, peça para mudar você de Leitor para Editor.")
        print("  - Confira se o Google Drive está aberto e conectado (ícone ao lado do relógio).")
        print()
        print(f"Nada foi mudado: o robô continua salvando em {current}")
        return 1
    print("Gravação OK.")

    if _same(current, target):
        print()
        print("O robô já salva nesta pasta. Está tudo certo.")
        return 0

    print()
    print("Copiando as notas já baixadas (nada é apagado nem sobrescrito)...")
    sources = [current]
    if not any(_same(settings.local_downloads_dir, p) for p in (current, target)):
        sources.append(settings.local_downloads_dir)  # notas do plano B e as antigas deste computador
    copied = skipped = 0
    for src in sources:
        try:
            c, s = copy_notes(src, target)
        except OSError as exc:
            print(f"Não consegui copiar de {src}: {exc}")
            print(f"Nada foi mudado na configuração: o robô continua salvando em {current}")
            return 1
        copied, skipped = copied + c, skipped + s
    print(f"{copied} nota(s) copiada(s); {skipped} já estava(m) lá.")
    # tudo o que estava na pasta local já foi para a pasta nova
    settings.pending_notes_file.unlink(missing_ok=True)

    previous = settings.download_base_path
    set_download_path(env_file, env_value(target))
    print()
    print("Religando o robô com a pasta nova (se ele estiver trabalhando, espera terminar)...")
    result = restart_and_confirm(settings, target)
    print()
    if result == "ok":
        print(f"Pronto! O robô já está salvando as notas em {target}")
        return 0
    if result == "stopped":
        print(f"Pronto! O robô está desligado; quando ligar, salva as notas em {target}")
        return 0
    if result == "timeout":
        print("A configuração foi trocada. O robô ainda está terminando um trabalho e passa a salvar")
        print(f"em {target} assim que terminar (nada se perde).")
        return 0
    # o robô (administrador) não enxergou a pasta: volta como estava
    set_download_path(env_file, env_value(Path(previous)))
    settings.update_flag.write_text("pasta-das-notas", encoding="utf-8")
    print("O robô não conseguiu enxergar a pasta nova, então voltei a configuração como estava.")
    print(f"Ele continua salvando em {current}. As notas copiadas continuam em {target}.")
    print("Fale com o suporte do JR Sistema: em alguns computadores o Windows esconde a unidade do")
    print("Google Drive de programas de administrador, e isso tem solução.")
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Faz o robô salvar as notas numa pasta do Google Drive.")
    parser.add_argument("--local", action="store_true", help="voltar a salvar só neste computador")
    args = parser.parse_args(argv)
    print("JR Sistema — " + ("Salvar notas só neste computador" if args.local else "Salvar notas no Google Drive"))
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
