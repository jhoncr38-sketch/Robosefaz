"""Login técnico do computador ativado (sem chave-mestra no computador do cliente).

A ativação (app.tools.activate) troca o código gerado no painel por um e-mail
e uma senha de uso exclusivo deste computador. O e-mail fica no .env
(DEVICE_EMAIL) e a senha no cofre do Windows (ou no arquivo cifrado, se o
cofre não estiver disponível). Com esse login o banco só entrega os dados do
escritório do computador, e desativar o computador no painel corta o acesso.
"""

from __future__ import annotations

from app.certificates.secret_manager import backend_from_settings
from app.config import Settings

SECRET_USERNAME = "device/login"


def save_device_password(settings: Settings, password: str) -> None:
    if not password:
        raise ValueError("Senha vazia")
    backend_from_settings(settings).set(SECRET_USERNAME, password)


def load_device_password(settings: Settings) -> str | None:
    try:
        return backend_from_settings(settings).get(SECRET_USERNAME)
    except Exception:  # noqa: BLE001 - cofre indisponível: trata como "não ativado"
        return None


def device_credentials(settings: Settings) -> dict[str, str]:
    password = load_device_password(settings)
    if not settings.device_email or not password:
        raise RuntimeError(
            "Computador ativado, mas a senha de acesso não está no cofre do Windows. "
            "Ative este computador de novo (menu Iniciar → SIAT Robô → Ativar este computador)."
        )
    return {"email": settings.device_email, "password": password}
