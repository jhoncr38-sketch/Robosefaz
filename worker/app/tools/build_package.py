r"""Gera o pacote de instalação do robô para outro computador.

    .venv\Scripts\python.exe -m app.tools.build_package

Cria `dist\SIAT-Robo-AAAAMMDD.zip` na pasta do sistema com SOMENTE o que o
robô precisa. Nunca inclui: .env (chaves), storage\ (notas, perfis do Chrome
com sessão do SIAT, cofre de senhas, logs, prints), .venv (é recriado pelo
instalador) nem o painel (que roda na Vercel).
"""

from __future__ import annotations

import zipfile
from datetime import date
from pathlib import Path

from app.config import PROJECT_ROOT

INCLUDE_DIRS = ["worker/app", "worker/config", "instalador"]
INCLUDE_FILES = [
    "worker/requirements.txt",
    "worker/abrir_nota.pyw",
    ".env.example",
    "instalar-robo.bat",
    "iniciar-robo.bat",
    "parar-robo.bat",
    "status-robo.bat",
    "desinstalar-robo.bat",
    "docs/instalacao-robo.md",
]
EMPTY_DIRS = ["storage/downloads", "storage/logs"]
_SKIP_PARTS = {"__pycache__", ".pytest_cache", "cache"}  # instalador/cache: Python embutido no .exe
_SKIP_SUFFIXES = {".pyc", ".pyo", ".iss"}
# segredos e dados que nunca podem sair deste computador
_FORBIDDEN_NAMES = {".env", "siat_selectors.json"}
_FORBIDDEN_SUFFIXES = {".pfx", ".p12", ".pem", ".key"}


def _files() -> list[Path]:
    out: list[Path] = []
    for rel in INCLUDE_DIRS:
        for path in sorted((PROJECT_ROOT / rel).rglob("*")):
            if not path.is_file() or _SKIP_PARTS & set(path.relative_to(PROJECT_ROOT).parts) or path.suffix in _SKIP_SUFFIXES:
                continue
            out.append(path)
    out += [PROJECT_ROOT / rel for rel in INCLUDE_FILES]
    for path in out:
        if path.name in _FORBIDDEN_NAMES or path.suffix.lower() in _FORBIDDEN_SUFFIXES:
            raise SystemExit(f"Arquivo sensível no pacote, abortando: {path}")
        if not path.is_file():
            raise SystemExit(f"Arquivo não encontrado: {path}")
    return out


def build(dest_dir: Path | None = None) -> Path:
    dest_dir = dest_dir or PROJECT_ROOT / "dist"
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / f"SIAT-Robo-{date.today():%Y%m%d}.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in _files():
            zf.write(path, Path("SIAT-Robo") / path.relative_to(PROJECT_ROOT))
        for rel in EMPTY_DIRS:
            zf.writestr(f"SIAT-Robo/{rel}/", "")  # pasta vazia (sem arquivo .gitkeep visível ao usuário)
    return target


if __name__ == "__main__":
    pkg = build()
    with zipfile.ZipFile(pkg) as zf:
        count = len(zf.namelist())
    print(f"Pacote gerado: {pkg} ({count} arquivos, {pkg.stat().st_size // 1024} KB)")
