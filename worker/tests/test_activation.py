"""Ativação do computador: código, .env sem chave-mestra e senha no cofre (sem acessar o painel real)."""

from pathlib import Path

import httpx
import pytest

from app.config import Settings
from app.tools import activate as act


def test_normalize_code() -> None:
    assert act.normalize_code("abcd-efgh") == "ABCD-EFGH"
    assert act.normalize_code(" ABCDEFGH ") == "ABCD-EFGH"
    for bad in ("", "ABC", "ABCD-EFGH-IJ", "AB$D-EFGH"):
        with pytest.raises(act.ActivationError):
            act.normalize_code(bad)


def test_set_env_values_replaces_all_and_appends(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("# chave\nSUPABASE_SERVICE_ROLE_KEY=sb_secret_x\nA=1\nSUPABASE_SERVICE_ROLE_KEY=sb_secret_x\n", encoding="utf-8")
    act.set_env_values(env, {"SUPABASE_SERVICE_ROLE_KEY": "", "DEVICE_EMAIL": "robo@x"})
    text = env.read_text(encoding="utf-8")
    assert "sb_secret_x" not in text and text.count("SUPABASE_SERVICE_ROLE_KEY=\n") == 2
    assert "DEVICE_EMAIL=robo@x" in text and "# chave" in text and "A=1" in text


def _client(status: int, body: dict) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(status, json=body)))


def test_activate_writes_env_and_vault(settings: Settings, tmp_path: Path, monkeypatch) -> None:
    env = tmp_path / ".env"
    env.write_text("SUPABASE_URL=\nSUPABASE_SERVICE_ROLE_KEY=sb_secret_antiga\n", encoding="utf-8")
    monkeypatch.setattr(act, "ENV_FILE", env)
    saved: dict[str, str] = {}
    monkeypatch.setattr("app.services.device_auth.save_device_password", lambda s, p: saved.setdefault("pw", p))
    body = {
        "email": "robo-1@robos.jrsistema.com",
        "password": "segredo-do-computador",
        "supabase_url": "https://x.supabase.co",
        "publishable_key": "sb_publishable_x",
        "org_name": "Escritório Teste",
        "device_id": "d1",
    }
    result = act.activate("abcd-efgh", settings, "https://painel", client=_client(200, body))
    assert result["org_name"] == "Escritório Teste"
    assert saved["pw"] == "segredo-do-computador"
    text = env.read_text(encoding="utf-8")
    assert "segredo-do-computador" not in text, "a senha nunca vai para o .env"
    assert "sb_secret_antiga" not in text, "a chave-mestra sai do computador"
    assert "DEVICE_EMAIL=robo-1@robos.jrsistema.com" in text and "SUPABASE_ANON_KEY=sb_publishable_x" in text
    fresh = Settings(_env_file=env, secrets_file_path=settings.secrets_file_path)
    assert fresh.auth_mode == "device"


def test_activation_error_message_from_panel(settings: Settings) -> None:
    with pytest.raises(act.ActivationError, match="expirado"):
        act.request_activation("https://painel", "ABCD-EFGH", "PC", client=_client(400, {"error": "Código inválido, expirado ou já usado."}))


def test_auth_mode(tmp_path: Path) -> None:
    assert Settings(_env_file=None, supabase_url="u", supabase_service_role_key="k").auth_mode == "service"
    assert Settings(_env_file=None, supabase_url="u", supabase_anon_key="p", device_email="e").auth_mode == "device"
    device_wins = Settings(_env_file=None, supabase_url="u", supabase_anon_key="p", device_email="e", supabase_service_role_key="k")
    assert device_wins.auth_mode == "device"
    assert Settings(_env_file=None, supabase_url="", supabase_service_role_key="").auth_mode is None


def test_device_password_roundtrip_in_encrypted_vault(settings: Settings) -> None:
    from cryptography.fernet import Fernet

    from app.services.device_auth import device_credentials, load_device_password, save_device_password

    settings.secret_backend = "encrypted_file"
    settings.secret_encryption_key = Fernet.generate_key().decode()
    settings.device_email = "robo@x"
    assert load_device_password(settings) is None
    save_device_password(settings, "abc123")
    assert device_credentials(settings) == {"email": "robo@x", "password": "abc123"}
    raw = Path(settings.secrets_file).read_bytes()
    assert b"abc123" not in raw, "senha cifrada no arquivo"
