r"""Ativa este computador com o código gerado no painel (Computadores → Adicionar computador).

    .venv\Scripts\python.exe -m app.tools.activate [CÓDIGO] [--painel https://jrsistema.com]

1. envia o código ao painel, que devolve o login técnico deste computador;
2. guarda a senha no cofre do Windows (nunca no .env);
3. grava no .env: SUPABASE_URL, a chave pública e DEVICE_EMAIL, e APAGA a
   chave-mestra (SUPABASE_SERVICE_ROLE_KEY), se houver;
4. se o robô estiver ligado, pede para ele religar já no modo ativado.

Saída: 0 = ativado; 1 = erro.
"""

from __future__ import annotations

import argparse
import json
import re
import socket
import sys
from pathlib import Path

import httpx

from app.config import PROJECT_ROOT, Settings, get_settings
from app.tools.ui import ConsoleUI, ToolUI

ENV_FILE = PROJECT_ROOT / ".env"
_CODE = re.compile(r"^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$")


class ActivationError(RuntimeError):
    pass


def normalize_code(code: str) -> str:
    raw = re.sub(r"\s+", "", code or "").upper()
    if not _CODE.match(raw):
        raise ActivationError("Código inválido. Ele tem 8 caracteres, no formato ABCD-EFGH.")
    raw = raw.replace("-", "")
    return f"{raw[:4]}-{raw[4:]}"


def format_code(text: str) -> str:
    """Arruma o código enquanto é digitado: só letras e números, maiúsculo, com o traço (ABCD-EFGH)."""
    raw = re.sub(r"[^A-Za-z0-9]", "", text or "").upper()[:8]
    return f"{raw[:4]}-{raw[4:]}" if len(raw) > 4 else raw


def set_env_values(path: Path, values: dict[str, str]) -> None:
    """Troca TODAS as ocorrências de cada chave (o .env repete chaves) e acrescenta as que faltarem."""
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    seen: set[str] = set()
    for i, line in enumerate(lines):
        key = line.split("=", 1)[0].strip()
        if "=" in line and not line.lstrip().startswith("#") and key in values:
            lines[i] = f"{key}={values[key]}"
            seen.add(key)
    lines += [f"{k}={v}" for k, v in values.items() if k not in seen]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def request_activation(panel_url: str, code: str, name: str, client: httpx.Client | None = None) -> dict:
    url = panel_url.rstrip("/") + "/api/devices/activate"
    own = client is None
    client = client or httpx.Client(timeout=60)
    try:
        r = client.post(url, json={"code": code, "name": name})
    except httpx.HTTPError as exc:
        raise ActivationError(f"Não foi possível falar com o painel ({panel_url}): {exc}") from exc
    finally:
        if own:
            client.close()
    try:
        data = r.json()
    except ValueError:
        data = {}
    if r.status_code != 200:
        raise ActivationError(data.get("error") or f"O painel recusou a ativação (HTTP {r.status_code}).")
    for field in ("email", "password", "supabase_url", "publishable_key"):
        if not data.get(field):
            raise ActivationError("Resposta incompleta do painel.")
    return data


def activate(code: str, settings: Settings, panel_url: str | None = None, client: httpx.Client | None = None) -> dict:
    from app.services.device_auth import save_device_password

    data = request_activation(panel_url or settings.panel_url, normalize_code(code), socket.gethostname(), client)
    save_device_password(settings, data["password"])
    set_env_values(
        ENV_FILE,
        {
            "SUPABASE_URL": data["supabase_url"],
            "NEXT_PUBLIC_SUPABASE_URL": data["supabase_url"],
            "SUPABASE_ANON_KEY": data["publishable_key"],
            "NEXT_PUBLIC_SUPABASE_ANON_KEY": data["publishable_key"],
            "DEVICE_EMAIL": data["email"],
            "SUPABASE_SERVICE_ROLE_KEY": "",  # a chave-mestra sai deste computador
        },
    )
    # robô ligado: encerra com calma e o serviço o religa (já no modo ativado)
    flag = settings.update_flag
    if settings.status_file.exists():
        flag.parent.mkdir(parents=True, exist_ok=True)
        flag.write_text("ativacao", encoding="utf-8")
    return {"org_name": data.get("org_name"), "device_id": data.get("device_id")}


TITLE = "Ativar este computador"
SUBTITLE = "Liga este computador ao escritório do painel. Gere o código em Computadores → Adicionar computador."


def run(settings: Settings, ui: ToolUI, code: str | None = None, panel_url: str | None = None) -> int:
    """Pede o código (até 3 tentativas), ativa e mostra o resultado."""
    ui.info(f"Computador: {socket.gethostname()}")
    for _attempt in range(3):
        if not code:
            code = ui.ask_text(
                "Código de ativação",
                "8 caracteres, no formato ABCD-EFGH. Ele vale 30 minutos e só pode ser usado uma vez.",
                transform=format_code,
            )
            if code is None:
                ui.done(False, "Nada foi mudado", "Este computador continua como estava.")
                return 1
        ui.status("Ativando este computador no painel…")
        try:
            result = activate(code, settings, panel_url)
        except ActivationError as exc:
            ui.status("")
            ui.fail(str(exc))
            code = None
            continue
        ui.done(
            True,
            f"Computador ativado no escritório {result['org_name']}",
            "O robô vai religar sozinho em alguns segundos, já com o acesso deste computador.",
        )
        return 0
    ui.done(
        False,
        "Não foi possível ativar",
        "Gere um código novo no painel (Computadores → Adicionar computador) e tente de novo.",
    )
    return 1


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Ativar este computador no JR Sistema Robô")
    parser.add_argument("code", nargs="?", help="código de 8 caracteres (Computadores → Adicionar computador)")
    parser.add_argument("--painel", help="endereço do painel (padrão: PANEL_URL)")
    parser.add_argument("--json", action="store_true", help="saída em JSON (instalador)")
    parser.add_argument("--gui", action="store_true", help="janela em vez da tela preta")
    args = parser.parse_args(argv)
    settings = get_settings()

    if args.json:  # instalador: sem perguntas, resposta numa linha
        try:
            result = activate(args.code or "", settings, args.painel)
        except ActivationError as exc:
            print(json.dumps({"ok": False, "error": str(exc)}))
            return 1
        print(json.dumps({"ok": True, **result}))
        return 0
    if args.gui:
        from app.tools.gui import run_in_window

        return run_in_window(TITLE, SUBTITLE, lambda ui: run(settings, ui, args.code, args.painel), height=460)
    print(f"{TITLE} no JR Sistema Robô")
    print("No painel: Computadores → Adicionar computador. Digite o código mostrado (ex.: ABCD-EFGH).")
    return run(settings, ConsoleUI(), args.code, args.painel)


if __name__ == "__main__":
    raise SystemExit(main())
