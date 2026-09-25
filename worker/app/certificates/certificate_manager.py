"""Verifica se o cliente possui certificado utilizável antes de iniciar o robô."""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from app.certificates.windows_store import StoreCertificate, find_in_store, list_user_certificates
from app.jobs.errors import AutomationError, ErrorCode
from app.jobs.models import Certificate, Client
from app.utils.cnpj import extract_cnpjs, normalize_cnpj

EXPIRING_DAYS = 30


@dataclass(slots=True)
class CertificateCheck:
    certificate: Certificate
    status: str
    days_left: int
    installed: bool | None
    warnings: list[str] = field(default_factory=list)


def certificate_status(valid_until: datetime, *, now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    if valid_until.tzinfo is None:
        valid_until = valid_until.replace(tzinfo=timezone.utc)
    if valid_until <= now:
        return "expired"
    if valid_until <= now + timedelta(days=EXPIRING_DAYS):
        return "expiring"
    return "valid"


class CertificateManager:
    def __init__(self, *, require_installed: bool | None = None, store_loader=list_user_certificates) -> None:  # noqa: ANN001
        # Em Windows exigimos que o certificado A1 esteja instalado no
        # repositório do usuário (é de lá que Chrome/Web PKI o leem).
        self.require_installed = sys.platform == "win32" if require_installed is None else require_installed
        self._store_loader = store_loader

    async def ensure_ready(
        self, client: Client, certificate: Certificate | None, *, now: datetime | None = None
    ) -> CertificateCheck:
        if certificate is None or not certificate.active:
            raise AutomationError(
                ErrorCode.CERTIFICATE_REQUIRED,
                f"Cliente {client.client_code} não possui certificado digital ativo configurado.",
            )
        if certificate.client_id != client.id:
            raise AutomationError(
                ErrorCode.INVALID_CONFIGURATION,
                "Certificado associado a outro cliente.",
            )

        now = now or datetime.now(timezone.utc)
        status = certificate_status(certificate.valid_until, now=now)
        valid_until = certificate.valid_until
        if valid_until.tzinfo is None:
            valid_until = valid_until.replace(tzinfo=timezone.utc)
        days_left = max(0, (valid_until - now).days)

        if status == "expired":
            raise AutomationError(
                ErrorCode.CERTIFICATE_EXPIRED,
                f"Certificado de {client.display_name} venceu em {valid_until:%d/%m/%Y}.",
            )

        warnings: list[str] = []
        if status == "expiring":
            warnings.append(f"Certificado vence em {days_left} dia(s).")

        subject_cnpjs = extract_cnpjs((certificate.subject_name or "").replace(":", " "))
        if subject_cnpjs and normalize_cnpj(client.cnpj) not in subject_cnpjs:
            # Pode ser certificado de procurador/contador; a validação do
            # contribuinte no portal continua obrigatória.
            warnings.append("CNPJ do certificado difere do cliente (procuração/contador?).")

        installed: bool | None = None
        if self.require_installed and (certificate.thumbprint or certificate.serial_number):
            store: list[StoreCertificate] = await self._store_loader()
            match = find_in_store(store, thumbprint=certificate.thumbprint, serial_number=certificate.serial_number)
            installed = match is not None
            if not installed:
                raise AutomationError(
                    ErrorCode.CERTIFICATE_REQUIRED,
                    "Certificado não encontrado no repositório do Windows (Cert:\\CurrentUser\\My). "
                    "Instale o A1 antes de executar a automação.",
                )
            if not match.has_private_key:
                raise AutomationError(
                    ErrorCode.CERTIFICATE_REQUIRED,
                    "Certificado instalado sem chave privada; reinstale o arquivo PFX.",
                )

        return CertificateCheck(
            certificate=certificate, status=status, days_left=days_left, installed=installed, warnings=warnings
        )
