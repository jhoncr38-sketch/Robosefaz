"""API de distribuição da NFS-e Nacional (ADN) para o contribuinte.

GET {base}/DFe/{NSU}?lote=true devolve, em JSON, até 50 documentos a partir do NSU informado em
que o dono do certificado é prestador, tomador ou intermediário: a NFS-e ou um evento dela
(ex.: cancelamento), cada um com o XML compactado (GZip) em Base64. Sem nada novo, a resposta é
HTTP 404 com o erro E2220 ("Nenhum documento localizado").

A conexão usa o certificado A1 do cliente direto do repositório do Windows (pelo PowerShell),
porque a chave privada costuma estar instalada como não exportável. Só leitura: nada é emitido,
cancelado ou registrado em nome do cliente.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import gzip
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
import xml.etree.ElementTree as ET
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.jobs.errors import AutomationError, CertificateNotInstalledError, ErrorCode

PROD_URL = "https://adn.nfse.gov.br/contribuintes"
NO_DOCUMENTS = "NENHUM_DOCUMENTO_LOCALIZADO"
NO_DOCUMENTS_CODE = "E2220"
# eventos que cancelam a nota: cancelamento e cancelamento por substituição
CANCEL_EVENTS = frozenset({"e101101", "e105102"})

_THUMBPRINT = re.compile(r"^[0-9A-F]{40}$")
_EVENT_TAG = re.compile(r"^e\d{6}$")

# Faz a chamada com o certificado do Windows e grava a resposta (UTF-8) no arquivo pedido.
# Os parâmetros vão por variáveis de ambiente, nunca montados dentro do script.
_PS_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$tp = $env:JR_ADN_THUMB
$cert = $null
foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\LocalMachine\My') {
  $c = Get-ChildItem -LiteralPath $store -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $tp -and $_.HasPrivateKey } | Select-Object -First 1
  if ($c) { $cert = $c; break }
}
if (-not $cert) { Write-Output 'STATUS 0 CERT_NOT_FOUND'; exit 0 }
try {
  $r = Invoke-WebRequest -Uri $env:JR_ADN_URL -Certificate $cert -UseBasicParsing -TimeoutSec ([int]$env:JR_ADN_TIMEOUT) -Headers @{ Accept = 'application/json' }
  $code = [int]$r.StatusCode
  $body = $r.Content
} catch {
  $resp = $_.Exception.Response
  if (-not $resp) { Write-Output ('STATUS 0 ' + $_.Exception.Message); exit 0 }
  $code = [int]$resp.StatusCode
  $sr = New-Object IO.StreamReader($resp.GetResponseStream())
  $body = $sr.ReadToEnd()
}
[IO.File]::WriteAllText($env:JR_ADN_OUT, [string]$body, (New-Object Text.UTF8Encoding $false))
Write-Output ('STATUS ' + $code)
"""


@dataclass(slots=True)
class AdnDocument:
    nsu: int
    chave: str
    tipo: str  # NFSE | EVENTO
    xml: bytes
    gerado_em: str | None = None


@dataclass(slots=True)
class AdnBatch:
    status: str
    documents: list[AdnDocument] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.documents

    @property
    def last_nsu(self) -> int | None:
        return max((d.nsu for d in self.documents), default=None)


@dataclass(slots=True)
class NfseEvent:
    chave: str  # chave da NFS-e a que o evento se refere
    codigo: str  # ex.: e101101 (cancelamento)
    descricao: str | None

    @property
    def cancels(self) -> bool:
        return self.codigo in CANCEL_EVENTS


def _unpack(value: str) -> bytes:
    raw = base64.b64decode(value)
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw


def parse_batch(payload: dict[str, Any]) -> AdnBatch:
    """Resposta da API -> documentos com o XML já descompactado."""
    errors = [
        f"{e.get('Codigo') or ''} {e.get('Descricao') or ''}".strip() for e in payload.get("Erros") or [] if isinstance(e, dict)
    ]
    docs: list[AdnDocument] = []
    for item in payload.get("LoteDFe") or []:
        try:
            xml = _unpack(item["ArquivoXml"])
            nsu = int(item["NSU"])
        except (KeyError, TypeError, ValueError, binascii.Error, OSError, EOFError) as exc:
            raise AutomationError(
                ErrorCode.NFSE_UNAVAILABLE, f"A API da NFS-e Nacional devolveu um documento ilegível ({exc})."
            ) from exc
        docs.append(
            AdnDocument(
                nsu=nsu,
                chave=str(item.get("ChaveAcesso") or ""),
                tipo=str(item.get("TipoDocumento") or "").upper(),
                xml=xml,
                gerado_em=item.get("DataHoraGeracao"),
            )
        )
    docs.sort(key=lambda d: d.nsu)
    return AdnBatch(status=str(payload.get("StatusProcessamento") or ""), documents=docs, errors=errors)


def parse_event(xml: bytes) -> NfseEvent | None:
    """Evento de uma NFS-e (cancelamento, substituição...). None se não for um evento."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    ped = root.find(".//{*}infPedReg")
    if ped is None:
        return None
    chave_el = ped.find("{*}chNFSe")
    chave = (chave_el.text or "").strip() if chave_el is not None else ""
    for child in ped:
        tag = child.tag.rsplit("}", 1)[-1]
        if _EVENT_TAG.match(tag):
            desc = child.find("{*}xDesc")
            text = (desc.text or "").strip() if desc is not None else ""
            return NfseEvent(chave=chave, codigo=tag, descricao=text or None)
    return None


Runner = Callable[[str, str, Path, int], Awaitable[tuple[int, str]]]


async def _powershell(url: str, thumbprint: str, out: Path, timeout: int) -> tuple[int, str]:
    """Roda a chamada no PowerShell. -> (status HTTP, detalhe); status 0 = sem resposta do servidor."""
    if sys.platform != "win32":
        raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "A busca de NFS-e usa o certificado do Windows.")
    env = {**os.environ, "JR_ADN_URL": url, "JR_ADN_THUMB": thumbprint, "JR_ADN_OUT": str(out), "JR_ADN_TIMEOUT": str(timeout)}
    proc = await asyncio.create_subprocess_exec(
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        _PS_SCRIPT,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout + 30)
    except TimeoutError:
        proc.kill()
        raise AutomationError(ErrorCode.TIMEOUT, "A API da NFS-e Nacional não respondeu a tempo.") from None
    text = stdout.decode("utf-8", "replace")
    m = re.search(r"STATUS (\d+)(?: (.*))?", text)
    if not m:
        detail = (stderr.decode("utf-8", "replace") or text).strip()[:300]
        raise AutomationError(ErrorCode.NFSE_UNAVAILABLE, f"Falha ao chamar a API da NFS-e Nacional: {detail}")
    return int(m.group(1)), (m.group(2) or "").strip()


class AdnClient:
    """Consulta a distribuição de documentos do contribuinte dono do certificado."""

    def __init__(self, thumbprint: str, *, base_url: str = PROD_URL, timeout: int = 60, runner: Runner | None = None) -> None:
        tp = (thumbprint or "").replace(" ", "").upper()
        if not _THUMBPRINT.match(tp):
            raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Impressão digital do certificado inválida.")
        self.thumbprint = tp
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._run = runner or _powershell

    async def fetch(self, nsu: int) -> AdnBatch:
        """Documentos a partir do NSU (exclusivo: o ADN devolve os seguintes)."""
        url = f"{self.base_url}/DFe/{int(nsu)}?lote=true"
        out = Path(tempfile.gettempdir()) / f"jr-adn-{uuid.uuid4().hex}.json"
        try:
            status, detail = await self._run(url, self.thumbprint, out, self.timeout)
            if status == 0 and detail == "CERT_NOT_FOUND":
                raise CertificateNotInstalledError(
                    "Certificado do cliente não encontrado no Windows deste computador (com chave privada)."
                )
            body = out.read_text(encoding="utf-8-sig") if out.is_file() else ""
        finally:
            out.unlink(missing_ok=True)  # arquivo temporário da resposta (não é nota)
        if status == 0:
            raise AutomationError(ErrorCode.NFSE_UNAVAILABLE, f"Sem resposta da API da NFS-e Nacional ({detail or 'erro de rede'}).")
        try:
            payload = json.loads(body) if body.strip() else {}
        except json.JSONDecodeError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        batch = parse_batch(payload) if payload else AdnBatch(status="")
        if status == 200:
            return batch
        if status == 404 and (batch.status == NO_DOCUMENTS or any(e.startswith(NO_DOCUMENTS_CODE) for e in batch.errors)):
            return AdnBatch(status=NO_DOCUMENTS, errors=batch.errors)
        reason = "; ".join(batch.errors) or body.strip()[:200] or f"HTTP {status}"
        if status in (401, 403, 495, 496):
            # certificado recusado (vencido, revogado ou de outro CNPJ): tentar de novo não resolve
            raise AutomationError(
                ErrorCode.CERTIFICATE_REQUIRED, f"A API da NFS-e Nacional recusou o certificado (HTTP {status}): {reason}"
            )
        raise AutomationError(ErrorCode.NFSE_UNAVAILABLE, f"API da NFS-e Nacional respondeu HTTP {status}: {reason}")
