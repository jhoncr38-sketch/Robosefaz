"""Leitura de metadados de um certificado A1 (PFX/P12) em memória.

O arquivo e a senha nunca são persistidos por este módulo.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime

from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

from app.utils.cnpj import extract_cnpjs, normalize_cnpj, validate_cnpj

# ICP-Brasil: OID do CNPJ da pessoa jurídica titular no SubjectAltName (otherName)
OID_ICP_CNPJ = "2.16.76.1.3.3"


class PfxError(ValueError):
    pass


@dataclass(slots=True)
class CertificateInfo:
    subject_name: str
    common_name: str
    issuer: str
    issuer_common_name: str
    serial_number: str
    thumbprint: str
    valid_from: datetime
    valid_until: datetime
    cnpj: str | None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["valid_from"] = self.valid_from.isoformat()
        d["valid_until"] = self.valid_until.isoformat()
        return d


def _cn(name: x509.Name) -> str:
    attrs = name.get_attributes_for_oid(NameOID.COMMON_NAME)
    return str(attrs[0].value) if attrs else name.rfc4514_string()


def _icp_cnpj(cert: x509.Certificate) -> str | None:
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return None
    for other in san.get_values_for_type(x509.OtherName):
        if other.type_id.dotted_string == OID_ICP_CNPJ:
            raw = other.value
            # valor DER: tag + tamanho + conteúdo (OCTET/PRINTABLE/UTF8 STRING)
            text = raw[2:].decode("latin-1", errors="ignore") if len(raw) > 2 else ""
            candidate = normalize_cnpj(text)
            if validate_cnpj(candidate):
                return candidate
    return None


def certificate_info(cert: x509.Certificate) -> CertificateInfo:
    subject_cn = _cn(cert.subject)
    cnpj = _icp_cnpj(cert)
    if not cnpj:
        found = extract_cnpjs(subject_cn.replace(":", " "))
        cnpj = found[0] if found else None
    return CertificateInfo(
        subject_name=subject_cn,
        common_name=subject_cn,
        issuer=cert.issuer.rfc4514_string(),
        issuer_common_name=_cn(cert.issuer),
        serial_number=format(cert.serial_number, "X"),
        thumbprint=cert.fingerprint(hashes.SHA1()).hex().upper(),  # noqa: S303 - thumbprint padrão Windows
        valid_from=cert.not_valid_before_utc,
        valid_until=cert.not_valid_after_utc,
        cnpj=cnpj,
    )


def inspect_pfx(data: bytes, password: str | None) -> CertificateInfo:
    if not data:
        raise PfxError("Arquivo vazio")
    try:
        _key, cert, _chain = pkcs12.load_key_and_certificates(
            data, password.encode() if password else None
        )
    except ValueError as exc:
        raise PfxError("Não foi possível abrir o certificado: senha incorreta ou arquivo inválido") from exc
    if cert is None:
        raise PfxError("O arquivo não contém certificado")
    return certificate_info(cert)
