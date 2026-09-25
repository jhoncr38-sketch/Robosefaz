"""Perfil de navegador individual por cliente/certificado.

storage/browser_profiles/{client_id}/
  ├── chrome/            -> user_data_dir do Chromium (persistent context)
  └── profile.json       -> vínculo cliente <-> certificado

Um perfil nunca é compartilhado entre clientes: o diretório é derivado do
client_id e o profile.json é conferido antes de cada uso.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from app.jobs.errors import AutomationError, ErrorCode
from app.jobs.models import Certificate, Client
from app.utils.files import ensure_dir, ensure_within

_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass(slots=True)
class ProfileBinding:
    client_id: str
    client_code: str
    certificate_id: str | None
    certificate_serial: str | None
    bound_at: str


class CertificateProfile:
    def __init__(self, base_dir: Path, client: Client, certificate: Certificate | None) -> None:
        profile_name = (certificate.browser_profile if certificate and certificate.browser_profile else client.id)
        if not _SAFE_ID.match(profile_name):
            raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Nome de perfil de navegador inválido.")
        if profile_name != client.id:
            # por segurança, o perfil deve ser o próprio client_id
            raise AutomationError(
                ErrorCode.INVALID_CONFIGURATION,
                "O perfil de navegador deve ser exclusivo do cliente (browser_profile = client_id).",
            )
        self.base_dir = base_dir
        self.client = client
        self.certificate = certificate
        self.root = ensure_within(base_dir, base_dir / profile_name)

    @property
    def user_data_dir(self) -> Path:
        return self.root / "chrome"

    @property
    def downloads_tmp_dir(self) -> Path:
        return self.root / "downloads_tmp"

    @property
    def binding_file(self) -> Path:
        return self.root / "profile.json"

    def read_binding(self) -> ProfileBinding | None:
        if not self.binding_file.exists():
            return None
        data = json.loads(self.binding_file.read_text(encoding="utf-8"))
        return ProfileBinding(**data)

    def prepare(self) -> tuple[Path, list[str]]:
        """Cria/valida o perfil. Retorna (user_data_dir, avisos)."""
        warnings: list[str] = []
        ensure_dir(self.user_data_dir)
        ensure_dir(self.downloads_tmp_dir)
        binding = self.read_binding()

        if binding and binding.client_id != self.client.id:
            raise AutomationError(
                ErrorCode.SECURITY_CLIENT_MISMATCH,
                "Perfil de navegador pertence a outro cliente; execução bloqueada.",
                metadata={"profile_client": binding.client_id, "job_client": self.client.id},
            )

        cert_id = self.certificate.id if self.certificate else None
        cert_serial = self.certificate.serial_number if self.certificate else None
        if binding and binding.certificate_id and cert_id and binding.certificate_id != cert_id:
            warnings.append("Certificado do cliente foi alterado; perfil revinculado ao novo certificado.")

        if binding is None or binding.certificate_id != cert_id:
            new_binding = ProfileBinding(
                client_id=self.client.id,
                client_code=self.client.client_code,
                certificate_id=cert_id,
                certificate_serial=cert_serial,
                bound_at=datetime.now(timezone.utc).isoformat(),
            )
            self.binding_file.write_text(json.dumps(asdict(new_binding), indent=2), encoding="utf-8")
        return self.user_data_dir, warnings
