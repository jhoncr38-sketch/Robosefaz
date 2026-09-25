"""Armazenamento seguro de segredos de certificados (senha do PFX/PIN).

Backends:
- keyring: Windows Credential Manager (ou o cofre nativo do SO).
- encrypted_file: arquivo JSON cifrado com Fernet (AES-128-CBC + HMAC),
  chave em SECRET_ENCRYPTION_KEY. Usado quando o keyring não está disponível.

O banco nunca recebe a senha; apenas o flag `has_secret`.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Protocol

from cryptography.fernet import Fernet, InvalidToken

SERVICE_NAME = "siat-automation"


def secret_username(certificate_id: str) -> str:
    return f"certificate/{certificate_id}"


class SecretBackendError(RuntimeError):
    pass


class SecretBackend(Protocol):
    name: str

    def set(self, username: str, secret: str) -> None: ...
    def get(self, username: str) -> str | None: ...
    def delete(self, username: str) -> bool: ...


class KeyringBackend:
    name = "keyring"

    def __init__(self) -> None:
        import keyring
        from keyring.backends import fail

        backend = keyring.get_keyring()
        if isinstance(backend, fail.Keyring):
            raise SecretBackendError("Nenhum cofre de credenciais do sistema disponível")
        self._keyring = keyring

    def set(self, username: str, secret: str) -> None:
        self._keyring.set_password(SERVICE_NAME, username, secret)

    def get(self, username: str) -> str | None:
        return self._keyring.get_password(SERVICE_NAME, username)

    def delete(self, username: str) -> bool:
        from keyring.errors import PasswordDeleteError

        try:
            self._keyring.delete_password(SERVICE_NAME, username)
            return True
        except PasswordDeleteError:
            return False


class EncryptedFileBackend:
    name = "encrypted_file"

    def __init__(self, path: Path, key: str) -> None:
        if not key:
            raise SecretBackendError("SECRET_ENCRYPTION_KEY não configurada")
        try:
            self._fernet = Fernet(key.encode())
        except (ValueError, TypeError) as exc:
            raise SecretBackendError(
                "SECRET_ENCRYPTION_KEY inválida (gere com: python -m app.tools.generate_key)"
            ) from exc
        self._path = path
        self._lock = threading.Lock()

    def _read(self) -> dict[str, str]:
        if not self._path.exists():
            return {}
        raw = self._path.read_bytes()
        if not raw:
            return {}
        try:
            return json.loads(self._fernet.decrypt(raw))
        except InvalidToken as exc:
            raise SecretBackendError("Não foi possível decifrar o arquivo de segredos (chave incorreta?)") from exc

    def _write(self, data: dict[str, str]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_bytes(self._fernet.encrypt(json.dumps(data).encode()))
        os.replace(tmp, self._path)

    def set(self, username: str, secret: str) -> None:
        with self._lock:
            data = self._read()
            data[username] = secret
            self._write(data)

    def get(self, username: str) -> str | None:
        with self._lock:
            return self._read().get(username)

    def delete(self, username: str) -> bool:
        with self._lock:
            data = self._read()
            existed = data.pop(username, None) is not None
            if existed:
                self._write(data)
            return existed


class CertificateSecretManager:
    """Abstração para salvar/obter/remover a senha de um certificado."""

    def __init__(self, backend: SecretBackend) -> None:
        self._backend = backend

    @property
    def backend_name(self) -> str:
        return self._backend.name

    @classmethod
    def from_settings(cls, settings) -> "CertificateSecretManager":  # noqa: ANN001
        mode = (settings.secret_backend or "auto").lower()
        if mode in {"auto", "keyring"}:
            try:
                return cls(KeyringBackend())
            except Exception as exc:
                if mode == "keyring":
                    raise SecretBackendError(f"Keyring indisponível: {exc}") from exc
        return cls(EncryptedFileBackend(settings.secrets_file, settings.secret_encryption_key))

    def save_secret(self, certificate_id: str, secret: str) -> None:
        if not secret:
            raise ValueError("Segredo vazio")
        self._backend.set(secret_username(certificate_id), secret)

    def get_secret(self, certificate_id: str) -> str | None:
        return self._backend.get(secret_username(certificate_id))

    def delete_secret(self, certificate_id: str) -> bool:
        return self._backend.delete(secret_username(certificate_id))

    def has_secret(self, certificate_id: str) -> bool:
        return self.get_secret(certificate_id) is not None
