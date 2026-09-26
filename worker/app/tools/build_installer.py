r"""Gera o instalador Instalar-SIAT-Robo-<versão>.exe (Inno Setup).

    .venv\Scripts\python.exe -m app.tools.build_installer     (ou gerar-instalador.bat)

1. separa em dist\stage os mesmos arquivos do pacote ZIP (sem .env, notas,
   perfis do Chrome, cofre, logs);
2. desenha o ícone do robô (instalador\robo.ico);
3. embute o instalador oficial do Python 3.12 (baixado de python.org uma vez,
   com a assinatura da Python Software Foundation conferida);
4. compila instalador\siat-robo.iss com o Inno Setup 6 (ISCC.exe).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

from app import __version__
from app.config import PROJECT_ROOT, get_settings
from app.tools.build_package import EMPTY_DIRS, _files
from app.tray_icons import save_ico

PYTHON_VERSION = "3.12.10"
PYTHON_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-amd64.exe"
ISS = PROJECT_ROOT / "instalador" / "siat-robo.iss"


def _iscc() -> Path:
    candidates = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Inno Setup 6" / "ISCC.exe",
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Inno Setup 6" / "ISCC.exe",
        Path(os.environ.get("ProgramFiles", "")) / "Inno Setup 6" / "ISCC.exe",
    ]
    for c in candidates:
        if c.is_file():
            return c
    raise SystemExit("Inno Setup 6 não encontrado. Instale com: winget install JRSoftware.InnoSetup --scope user")


def _python_installer() -> Path:
    target = PROJECT_ROOT / "instalador" / "cache" / f"python-{PYTHON_VERSION}-amd64.exe"
    if not target.is_file():
        target.parent.mkdir(parents=True, exist_ok=True)
        print(f"Baixando {PYTHON_URL} ...")
        urllib.request.urlretrieve(PYTHON_URL, target)  # noqa: S310 - URL fixa do python.org
    ps = (
        f"$s = Get-AuthenticodeSignature -LiteralPath '{target}'; "
        "if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'Python Software Foundation') { exit 1 }"
    )
    if subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=False).returncode != 0:  # noqa: S603, S607
        target.unlink(missing_ok=True)
        raise SystemExit("Assinatura do instalador do Python inválida; arquivo descartado.")
    return target


def _stage() -> Path:
    stage = PROJECT_ROOT / "dist" / "stage"
    if stage.exists():
        shutil.rmtree(stage)
    for src in _files():
        dst = stage / src.relative_to(PROJECT_ROOT)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    for rel in EMPTY_DIRS:
        (stage / rel).mkdir(parents=True, exist_ok=True)
        (stage / rel / ".gitkeep").write_text("", encoding="utf-8")
    save_ico(stage / "instalador" / "robo.ico")
    return stage


def build() -> Path:
    settings = get_settings()
    stage = _stage()
    python_exe = _python_installer()
    out_dir = PROJECT_ROOT / "dist"
    cmd = [
        str(_iscc()),
        "/Q",
        f"/DAppVersion={__version__}",
        f"/DStageDir={stage}",
        f"/DPythonExe={python_exe}",
        f"/DOutputDir={out_dir}",
        f"/DSupabaseUrl={settings.supabase_url}",
        f"/DPanelUrl={settings.panel_url}",
        str(ISS),
    ]
    proc = subprocess.run(cmd, check=False)  # noqa: S603
    if proc.returncode != 0:
        raise SystemExit(f"Falha ao compilar o instalador (código {proc.returncode}).")
    shutil.rmtree(stage, ignore_errors=True)
    return out_dir / f"Instalar-SIAT-Robo-{__version__}.exe"


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    exe = build()
    print(f"Instalador gerado: {exe} ({exe.stat().st_size // (1024 * 1024)} MB)")
