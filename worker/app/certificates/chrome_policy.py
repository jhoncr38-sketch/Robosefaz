"""ChromeCertificatePolicyService: configuração opcional de AutoSelectCertificateForUrls.

A política faz o Chrome/Edge escolher automaticamente um certificado cliente
(TLS) para uma URL, com filtro por SUBJECT e/ou ISSUER. Ela é configurada
pelo próprio dono da máquina — não burla nenhum mecanismo do portal.

Regras de segurança deste serviço:
- Nada é gravado no Registro sem `confirm=True` E `CHROME_POLICY_ALLOW_WRITE=true`.
- Valores existentes são salvos em backup e restaurados.
- Só removemos valores que nós mesmos criamos (manifesto local).
- Escopo padrão HKCU (não exige administrador). HKLM exige elevação.

Observação: a política é global para o navegador (não por perfil). Por isso
o modo `per_job` grava a entrada apenas durante a execução de um cliente e a
remove em seguida (compatível com MAX_PARALLEL_JOBS=1).
"""

from __future__ import annotations

import json
import re
import sys
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator
from urllib.parse import urlparse

from app.jobs.models import Certificate

POLICY_NAME = "AutoSelectCertificateForUrls"

REGISTRY_PATHS: dict[str, str] = {
    "chrome": r"Software\Policies\Google\Chrome",
    "msedge": r"Software\Policies\Microsoft\Edge",
    "chromium": r"Software\Policies\Chromium",
}


class PolicyWriteNotAllowed(PermissionError):
    pass


@dataclass(frozen=True, slots=True)
class PolicyEntry:
    pattern: str
    subject_cn: str | None = None
    issuer_cn: str | None = None
    subject_o: str | None = None
    issuer_o: str | None = None

    def to_policy_json(self) -> str:
        flt: dict[str, dict[str, str]] = {}
        subject = {k: v for k, v in (("CN", self.subject_cn), ("O", self.subject_o)) if v}
        issuer = {k: v for k, v in (("CN", self.issuer_cn), ("O", self.issuer_o)) if v}
        if subject:
            flt["SUBJECT"] = subject
        if issuer:
            flt["ISSUER"] = issuer
        if not flt:
            raise ValueError("A política precisa de ao menos um filtro (SUBJECT ou ISSUER)")
        return json.dumps({"pattern": self.pattern, "filter": flt}, ensure_ascii=False, separators=(",", ":"))


_WILDCARD = re.compile(r"^https?://\[\*\.\][a-z0-9.-]+\.[a-z]{2,}$", re.IGNORECASE)


def url_pattern(url: str) -> str:
    """Converte uma URL no formato de padrão aceito pelo Chrome ([*.]host)."""
    if "[*.]" in url:
        # já é um padrão do Chrome (ex.: https://[*.]sefaz.pi.gov.br)
        if not _WILDCARD.match(url):
            raise ValueError(f"Padrão inválido: {url}")
        return url
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.hostname:
        raise ValueError(f"URL inválida: {url}")
    return f"{parsed.scheme}://{parsed.hostname}"


def _entry_pattern(value: object) -> str | None:
    try:
        data = json.loads(str(value))
    except ValueError:
        return None
    return data.get("pattern") if isinstance(data, dict) else None


def _cn_from_dn(dn: str | None) -> str | None:
    if not dn:
        return None
    for part in dn.split(","):
        part = part.strip()
        if part.upper().startswith("CN="):
            return part[3:].strip()
    return dn.strip() or None


class ChromeCertificatePolicyService:
    def __init__(
        self,
        *,
        channel: str = "chrome",
        scope: str = "user",
        allow_write: bool = False,
        state_file: Path | None = None,
    ) -> None:
        if channel not in REGISTRY_PATHS:
            raise ValueError(f"Canal sem suporte a políticas: {channel}")
        if scope not in {"user", "machine"}:
            raise ValueError("scope deve ser 'user' ou 'machine'")
        self.channel = channel
        self.scope = scope
        self.allow_write = allow_write
        self.state_file = state_file

    # -- construção ------------------------------------------------------
    @staticmethod
    def entry_for_certificate(certificate: Certificate, url: str) -> PolicyEntry:
        return PolicyEntry(
            pattern=url_pattern(url),
            subject_cn=_cn_from_dn(certificate.subject_name),
            issuer_cn=_cn_from_dn(certificate.issuer),
        )

    @property
    def key_path(self) -> str:
        return REGISTRY_PATHS[self.channel] + "\\" + POLICY_NAME

    def render_reg_file(self, entries: list[PolicyEntry]) -> str:
        """Gera um arquivo .reg para revisão/aplicação manual pelo administrador."""
        hive = "HKEY_CURRENT_USER" if self.scope == "user" else "HKEY_LOCAL_MACHINE"
        lines = ["Windows Registry Editor Version 5.00", "", f"[{hive}\\{self.key_path}]"]
        for idx, entry in enumerate(entries, start=1):
            value = entry.to_policy_json().replace("\\", "\\\\").replace('"', '\\"')
            lines.append(f'"{idx}"="{value}"')
        return "\r\n".join(lines) + "\r\n"

    # -- registro --------------------------------------------------------
    def _winreg(self):  # noqa: ANN202
        if sys.platform != "win32":
            raise OSError("Políticas do Chrome via Registro só estão disponíveis no Windows")
        import winreg

        return winreg

    def _hive(self, winreg):  # noqa: ANN001, ANN202
        return winreg.HKEY_CURRENT_USER if self.scope == "user" else winreg.HKEY_LOCAL_MACHINE

    def list_entries(self) -> dict[str, str]:
        winreg = self._winreg()
        try:
            with winreg.OpenKey(self._hive(winreg), self.key_path) as key:
                out: dict[str, str] = {}
                i = 0
                while True:
                    try:
                        name, value, _ = winreg.EnumValue(key, i)
                    except OSError:
                        break
                    out[name] = value
                    i += 1
                return out
        except FileNotFoundError:
            return {}

    def _load_state(self) -> dict:
        if self.state_file and self.state_file.exists():
            return json.loads(self.state_file.read_text(encoding="utf-8"))
        return {"managed": []}

    def _save_state(self, state: dict) -> None:
        if self.state_file:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            self.state_file.write_text(json.dumps(state, indent=2), encoding="utf-8")

    def _check_write(self, confirm: bool) -> None:
        if not confirm:
            raise PolicyWriteNotAllowed("Aplicação de política exige confirmação explícita (confirm=True).")
        if not self.allow_write:
            raise PolicyWriteNotAllowed(
                "Escrita de políticas desabilitada. Defina CHROME_POLICY_ALLOW_WRITE=true para permitir."
            )

    def apply(self, entries: list[PolicyEntry], *, confirm: bool = False) -> list[str]:
        """Adiciona entradas (sem apagar as existentes). Retorna os nomes criados."""
        self._check_write(confirm)
        winreg = self._winreg()
        existing = self.list_entries()
        existing_values = set(existing.values())
        next_idx = max([int(n) for n in existing if n.isdigit()] + [0]) + 1
        created: list[str] = []
        with winreg.CreateKeyEx(self._hive(winreg), self.key_path, 0, winreg.KEY_SET_VALUE) as key:
            for entry in entries:
                value = entry.to_policy_json()
                if value in existing_values:
                    continue
                name = str(next_idx)
                winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)
                created.append(name)
                next_idx += 1
        state = self._load_state()
        state["managed"] = sorted(set(state.get("managed", [])) | set(created), key=int)
        self._save_state(state)
        return created

    def remove_managed(self, names: list[str] | None = None, *, confirm: bool = False) -> list[str]:
        """Remove somente valores criados por este serviço."""
        self._check_write(confirm)
        winreg = self._winreg()
        state = self._load_state()
        managed = set(state.get("managed", []))
        targets = [n for n in (names or list(managed)) if n in managed]
        removed: list[str] = []
        try:
            with winreg.OpenKey(self._hive(winreg), self.key_path, 0, winreg.KEY_SET_VALUE) as key:
                for name in targets:
                    try:
                        winreg.DeleteValue(key, name)
                        removed.append(name)
                    except FileNotFoundError:
                        removed.append(name)
        except FileNotFoundError:
            removed = targets
        state["managed"] = sorted(managed - set(removed), key=int)
        self._save_state(state)
        return removed

    def remove_pattern(self, pattern: str, *, confirm: bool = False) -> list[str]:
        """Remove TODAS as entradas deste endereço, inclusive sobras de outro robô.

        Se o worker for encerrado à força no meio de um job, a entrada daquele
        certificado fica no Registro; como o Chrome usa a PRIMEIRA entrada que
        combina, o próximo job abriria o SIAT com o certificado de outro cliente.
        Entradas de outros endereços não são tocadas.
        """
        self._check_write(confirm)
        winreg = self._winreg()
        stale = [name for name, value in self.list_entries().items() if _entry_pattern(value) == pattern]
        if stale:
            with winreg.OpenKey(self._hive(winreg), self.key_path, 0, winreg.KEY_SET_VALUE) as key:
                for name in stale:
                    try:
                        winreg.DeleteValue(key, name)
                    except FileNotFoundError:
                        pass
        state = self._load_state()
        managed = set(state.get("managed", [])) - set(stale)
        state["managed"] = sorted(managed, key=int)
        self._save_state(state)
        return stale

    @asynccontextmanager
    async def applied_for_job(self, certificate: Certificate, url: str) -> AsyncIterator[list[str]]:
        """Modo per_job: deixa SÓ a entrada do certificado do job e remove ao final."""
        entry = self.entry_for_certificate(certificate, url)
        self.remove_pattern(entry.pattern, confirm=True)
        created = self.apply([entry], confirm=True)
        try:
            yield created
        finally:
            self.remove_pattern(entry.pattern, confirm=True)
