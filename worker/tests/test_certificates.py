"""Certificados: gestor, seletor, perfil, cofre de segredos, PFX e política do Chrome."""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

from app.browser.profile_lock import ProfileLock
from app.certificates.certificate_manager import CertificateManager, certificate_status
from app.certificates.certificate_profile import CertificateProfile
from app.certificates.certificate_selector import CertificateSelector
from app.certificates.chrome_policy import ChromeCertificatePolicyService, PolicyEntry, PolicyWriteNotAllowed, url_pattern
from app.certificates.pfx_inspector import PfxError, inspect_pfx
from app.certificates.secret_manager import CertificateSecretManager, EncryptedFileBackend, SecretBackendError
from app.certificates.windows_store import StoreCertificate, find_in_store
from app.jobs.errors import AutomationError, ErrorCode
from fakes import make_certificate, make_client

NOW = datetime(2026, 8, 15, tzinfo=timezone.utc)


class TestCertificateManager:
    def test_status(self) -> None:
        assert certificate_status(NOW + timedelta(days=90), now=NOW) == "valid"
        assert certificate_status(NOW + timedelta(days=12), now=NOW) == "expiring"
        assert certificate_status(NOW - timedelta(seconds=1), now=NOW) == "expired"

    async def test_requires_certificate(self) -> None:
        client = make_client()
        with pytest.raises(AutomationError) as e:
            await CertificateManager(require_installed=False).ensure_ready(client, None)
        assert e.value.code == ErrorCode.CERTIFICATE_REQUIRED

    async def test_expired(self) -> None:
        client = make_client()
        cert = make_certificate(client, valid_until=NOW - timedelta(days=1), valid_from=NOW - timedelta(days=400))
        with pytest.raises(AutomationError) as e:
            await CertificateManager(require_installed=False).ensure_ready(client, cert, now=NOW)
        assert e.value.code == ErrorCode.CERTIFICATE_EXPIRED

    async def test_expiring_warning_and_other_cnpj_warning(self) -> None:
        client = make_client()
        cert = make_certificate(client, subject_name="CONTADOR LTDA:11444777000161", valid_until=NOW + timedelta(days=5))
        check = await CertificateManager(require_installed=False).ensure_ready(client, cert, now=NOW)
        assert check.status == "expiring" and check.days_left == 5
        assert len(check.warnings) == 2

    async def test_certificate_of_other_client_is_rejected(self) -> None:
        a, b = make_client(), make_client(client_code="CLI000002")
        with pytest.raises(AutomationError) as e:
            await CertificateManager(require_installed=False).ensure_ready(a, make_certificate(b))
        assert e.value.code == ErrorCode.INVALID_CONFIGURATION

    async def test_must_be_installed_in_store(self) -> None:
        client = make_client()
        cert = make_certificate(client, thumbprint="AA11")

        async def empty_store() -> list[StoreCertificate]:
            return []

        async def store_with_cert() -> list[StoreCertificate]:
            return [StoreCertificate("CN=X", "CN=Y", "AA11", "ABC123", True, None, None)]

        with pytest.raises(AutomationError):
            await CertificateManager(require_installed=True, store_loader=empty_store).ensure_ready(client, cert)
        check = await CertificateManager(require_installed=True, store_loader=store_with_cert).ensure_ready(client, cert)
        assert check.installed is True

    def test_find_in_store_by_serial(self) -> None:
        store = [StoreCertificate("CN=X", "CN=Y", "FF", "00ABC123", True, None, None)]
        assert find_in_store(store, thumbprint=None, serial_number="abc123") is not None
        assert find_in_store(store, thumbprint="EE", serial_number=None) is None


class TestCertificateSelector:
    ROWS = [
        "EMPRESA A LTDA:11222333000181 - AC TESTE RFB v5 - a@a.com",
        "EMPRESA B LTDA:11444777000161 - AC TESTE RFB v5 - b@b.com",
    ]

    def test_selects_by_subject(self) -> None:
        client = make_client()
        cert = make_certificate(client)
        r = CertificateSelector(cert, client.cnpj).choose(self.ROWS)
        assert r.index == 0

    def test_selects_by_cnpj_when_subject_differs(self) -> None:
        client = make_client(cnpj="11444777000161")
        cert = make_certificate(client, subject_name="NOME DIFERENTE", issuer=None)
        assert CertificateSelector(cert, client.cnpj).choose(self.ROWS).index == 1

    def test_ambiguous_requires_manual(self) -> None:
        client = make_client()
        cert = make_certificate(client)
        r = CertificateSelector(cert, client.cnpj).choose(self.ROWS + [self.ROWS[0]])
        assert not r.found and r.candidates == 2

    def test_not_listed(self) -> None:
        client = make_client(cnpj="11222333000181")
        cert = make_certificate(client, subject_name="OUTRA EMPRESA:99999999000191")
        assert not CertificateSelector(cert, "04252011000110").choose(self.ROWS).found
        assert not CertificateSelector(cert, client.cnpj).choose([]).found


class TestProfile:
    def test_profile_per_client_and_binding(self, tmp_path: Path) -> None:
        client = make_client()
        cert = make_certificate(client)
        user_data_dir, warnings = CertificateProfile(tmp_path, client, cert).prepare()
        assert user_data_dir == (tmp_path / client.id / "chrome").resolve()
        assert json.loads((tmp_path / client.id / "profile.json").read_text())["certificate_id"] == cert.id
        assert warnings == []

        new_cert = make_certificate(client)
        _, warnings = CertificateProfile(tmp_path, client, new_cert).prepare()
        assert warnings and "revinculado" in warnings[0]

    def test_profile_of_other_client_is_blocked(self, tmp_path: Path) -> None:
        a = make_client()
        CertificateProfile(tmp_path, a, make_certificate(a)).prepare()
        b = make_client(client_code="CLI000002")
        binding = tmp_path / a.id / "profile.json"
        data = json.loads(binding.read_text())
        data["client_id"] = b.id  # simula perfil adulterado
        binding.write_text(json.dumps(data))
        with pytest.raises(AutomationError) as e:
            CertificateProfile(tmp_path, a, make_certificate(a)).prepare()
        assert e.value.code == ErrorCode.SECURITY_CLIENT_MISMATCH

    def test_shared_profile_name_rejected(self, tmp_path: Path) -> None:
        a = make_client()
        with pytest.raises(AutomationError):
            CertificateProfile(tmp_path, a, make_certificate(a, browser_profile="perfil-compartilhado"))

    def test_profile_lock(self, tmp_path: Path) -> None:
        lock = ProfileLock(tmp_path, "job:1")
        lock.acquire()
        with pytest.raises(AutomationError) as e:
            ProfileLock(tmp_path, "job:2").acquire()
        assert e.value.code == ErrorCode.PROFILE_IN_USE
        lock.release()
        with ProfileLock(tmp_path, "job:3"):
            pass


class TestSecretManager:
    def test_encrypted_file_roundtrip(self, tmp_path: Path) -> None:
        path = tmp_path / "s.enc"
        mgr = CertificateSecretManager(EncryptedFileBackend(path, Fernet.generate_key().decode()))
        mgr.save_secret("cert-1", "minha-senha-secreta")
        assert mgr.get_secret("cert-1") == "minha-senha-secreta"
        assert mgr.has_secret("cert-1")
        assert b"minha-senha-secreta" not in path.read_bytes()  # nunca em texto puro
        assert mgr.delete_secret("cert-1") is True
        assert mgr.get_secret("cert-1") is None
        assert mgr.delete_secret("cert-1") is False

    def test_wrong_key(self, tmp_path: Path) -> None:
        path = tmp_path / "s.enc"
        CertificateSecretManager(EncryptedFileBackend(path, Fernet.generate_key().decode())).save_secret("c", "x")
        with pytest.raises(SecretBackendError):
            CertificateSecretManager(EncryptedFileBackend(path, Fernet.generate_key().decode())).get_secret("c")

    def test_requires_key(self, tmp_path: Path) -> None:
        with pytest.raises(SecretBackendError):
            EncryptedFileBackend(tmp_path / "x", "")
        with pytest.raises(SecretBackendError):
            EncryptedFileBackend(tmp_path / "x", "nao-e-fernet")

    def test_rejects_empty_secret(self, tmp_path: Path) -> None:
        mgr = CertificateSecretManager(EncryptedFileBackend(tmp_path / "s", Fernet.generate_key().decode()))
        with pytest.raises(ValueError):
            mgr.save_secret("c", "")


def _make_pfx(password: bytes) -> bytes:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "EMPRESA A LTDA:11222333000181")])
    issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "AC TESTE RFB v5")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(0xABC123)
        .not_valid_before(NOW - timedelta(days=1))
        .not_valid_after(NOW + timedelta(days=365))
        .sign(key, hashes.SHA256())
    )
    return pkcs12.serialize_key_and_certificates(
        b"a1", key, cert, None, serialization.BestAvailableEncryption(password)
    )


class TestPfxInspector:
    def test_reads_metadata(self) -> None:
        info = inspect_pfx(_make_pfx(b"1234"), "1234")
        assert info.subject_name == "EMPRESA A LTDA:11222333000181"
        assert info.issuer_common_name == "AC TESTE RFB v5"
        assert info.serial_number == "ABC123"
        assert info.cnpj == "11222333000181"
        assert len(info.thumbprint) == 40
        assert info.valid_until > info.valid_from

    def test_wrong_password(self) -> None:
        with pytest.raises(PfxError):
            inspect_pfx(_make_pfx(b"1234"), "errada")
        with pytest.raises(PfxError):
            inspect_pfx(b"", None)


class TestChromePolicy:
    def test_entry_json(self) -> None:
        client = make_client()
        cert = make_certificate(client)
        entry = ChromeCertificatePolicyService.entry_for_certificate(cert, "https://siatweb.sefaz.pi.gov.br/painel")
        data = json.loads(entry.to_policy_json())
        assert data == {
            "pattern": "https://siatweb.sefaz.pi.gov.br",
            "filter": {"SUBJECT": {"CN": cert.subject_name}, "ISSUER": {"CN": "AC TESTE RFB v5"}},
        }

    def test_requires_filter_and_valid_url(self) -> None:
        with pytest.raises(ValueError):
            PolicyEntry(pattern="https://x").to_policy_json()
        with pytest.raises(ValueError):
            url_pattern("nao-e-url")

    def test_reg_file(self) -> None:
        svc = ChromeCertificatePolicyService(channel="chrome")
        reg = svc.render_reg_file([PolicyEntry("https://siatweb.sefaz.pi.gov.br", subject_cn="EMPRESA \"A\"")])
        assert reg.startswith("Windows Registry Editor Version 5.00")
        assert "HKEY_CURRENT_USER\\Software\\Policies\\Google\\Chrome\\AutoSelectCertificateForUrls" in reg
        value_line = next(line for line in reg.splitlines() if line.startswith('"1"='))
        raw = value_line[len('"1"="') : -1]
        decoded = json.loads(re.sub(r"\\(.)", lambda m: m.group(1), raw))  # desfaz o escape do .reg
        assert decoded["filter"]["SUBJECT"]["CN"] == 'EMPRESA "A"'

    async def test_job_removes_stale_entry_of_other_client(self, tmp_path: Path, monkeypatch) -> None:
        """Sobra de um robô interrompido não pode fazer o Chrome escolher o certificado de outro cliente."""
        registry = _FakeWinreg()
        pattern = "https://[*.]sefaz.pi.gov.br"
        stale = PolicyEntry(pattern, subject_cn="OUTRO CLIENTE:28100366000151").to_policy_json()
        other_site = PolicyEntry("https://outro.site.com.br", subject_cn="NAO MEXER").to_policy_json()
        registry.values.update({"1": stale, "7": other_site})
        svc = ChromeCertificatePolicyService(allow_write=True, state_file=tmp_path / "s.json")
        monkeypatch.setattr(svc, "_winreg", lambda: registry)
        cert = make_certificate(make_client(), subject_name="ALESSANDRO DE ARAUJO BARBOSA:36145344000136")

        async with svc.applied_for_job(cert, pattern):
            during = [json.loads(v) for n, v in registry.values.items() if n != "7"]
            assert len(during) == 1  # só a entrada do cliente do job
            assert during[0]["filter"]["SUBJECT"]["CN"] == "ALESSANDRO DE ARAUJO BARBOSA:36145344000136"
        assert registry.values == {"7": other_site}  # outros endereços ficam intactos

    def test_write_requires_confirmation_and_flag(self, tmp_path: Path) -> None:
        entry = PolicyEntry("https://siatweb.sefaz.pi.gov.br", subject_cn="X")
        with pytest.raises(PolicyWriteNotAllowed):
            ChromeCertificatePolicyService(allow_write=True, state_file=tmp_path / "s.json").apply([entry])
        with pytest.raises(PolicyWriteNotAllowed):
            ChromeCertificatePolicyService(allow_write=False).apply([entry], confirm=True)


class _FakeWinreg:
    """Registro em memória com a API usada por ChromeCertificatePolicyService."""

    HKEY_CURRENT_USER = "HKCU"
    HKEY_LOCAL_MACHINE = "HKLM"
    KEY_SET_VALUE = 2
    REG_SZ = 1

    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def __enter__(self) -> "_FakeWinreg":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def OpenKey(self, *_a: object) -> "_FakeWinreg":  # noqa: N802
        return self

    def CreateKeyEx(self, *_a: object) -> "_FakeWinreg":  # noqa: N802
        return self

    def EnumValue(self, _key: object, index: int) -> tuple[str, str, int]:  # noqa: N802
        items = list(self.values.items())
        if index >= len(items):
            raise OSError("fim")
        name, value = items[index]
        return name, value, self.REG_SZ

    def SetValueEx(self, _key: object, name: str, _r: int, _t: int, value: str) -> None:  # noqa: N802
        self.values[name] = value

    def DeleteValue(self, _key: object, name: str) -> None:  # noqa: N802
        if name not in self.values:
            raise FileNotFoundError(name)
        del self.values[name]
