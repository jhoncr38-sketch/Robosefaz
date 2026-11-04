"""APIs de NFS-e com DPS (padrão nacional) para o contribuinte: emitir, cancelar e consultar.

Desde 01/11/2026 (Resolução CGSN nº 191) a ME/EPP do Simples Nacional emite só pelo ambiente nacional:
a API da prefeitura recusa com L9999. Por isso a emissão usa o Sefin Nacional (`SefinClient`), com o
mesmo leiaute de DPS e os mesmos campos JSON:
  POST {base}/nfse                     {"dpsXmlGZipB64": ...}                    -> 201 com a NFS-e
  POST {base}/nfse/{chave}/eventos     {"pedidoRegistroEventoXmlGZipB64": ...}   -> 200/201 com o evento
  GET  {base}/dps/{Id da DPS}          -> 200 com a chave; 404 (E2404) se a DPS não virou nota
  GET  {base}/nfse/{chave}             -> 200 com a NFS-e
Os erros vêm em "erros": [...] ou "erro": {...}, com "codigo" e "descricao" (às vezes em PascalCase).

A API da prefeitura (`PrefeituraClient`, Teresina/DSF) fica para o que ela ainda gerou: o cancelamento
de uma nota emitida por ela antes de 01/11/2026. Os caminhos são os do manual "Guia de Utilização da API":
  POST {base}/nfse                     {"dpsXmlGZipB64": ...}                    -> 201 com a NFS-e
  POST {base}/nfse/{chave}/eventos     {"pedidoRegistroEventoXmlGZipB64": ...}   -> 200/201 com o evento
  GET  {base}/nfse/dps/{Id da DPS}     -> 200 com a chave da nota gerada por aquela DPS; 404 se não existe
  GET  {base}/nfse/{chave}             -> 200 com a NFS-e
Os erros de negócio vêm com HTTP 400 em "erros": [{"codigo", "mensagem"}].

A conexão usa o certificado A1 do cliente direto do repositório do Windows (pelo PowerShell), como
na busca de NFS-e. O ambiente (produção ou teste da prefeitura) é escolhido por quem cria o cliente
desta API e conferido contra o que está escrito no XML: uma nota de teste nunca vai para a produção
e vice-versa.
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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.jobs.errors import AutomationError, CertificateNotInstalledError, ErrorCode
from app.nfse.dps import TERESINA, digits

# município emissor (IBGE) -> endereço da API da prefeitura em cada ambiente
ENDPOINTS: dict[str, dict[str, str]] = {
    TERESINA: {
        "prod": "https://nfseapi.teresina.pi.gov.br/notafiscal-ws",
        "test": "https://nfse2-the.dsfweb.com.br/notafiscal-ws",
    },
}

# Sefin Nacional (gov.br/nfse, "APIs - Produção Restrita e Produção"): a produção restrita é o ambiente
# de teste nacional, sem valor fiscal
SEFIN_ENDPOINTS: dict[str, str] = {
    "prod": "https://sefin.nfse.gov.br/SefinNacional",
    "test": "https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional",
}

_THUMBPRINT = re.compile(r"^[0-9A-F]{40}$")
_KEY = re.compile(r"^\d{50}$")
_DPS_ID = re.compile(r"^DPS\d{42}$")

# Chamada com o certificado do Windows; a resposta é gravada crua (bytes) no arquivo pedido.
# Os parâmetros vão por variáveis de ambiente, nunca montados dentro do script.
_PS_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$tp = $env:JR_PMT_THUMB
$cert = $null
foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\LocalMachine\My') {
  $c = Get-ChildItem -LiteralPath $store -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $tp -and $_.HasPrivateKey } | Select-Object -First 1
  if ($c) { $cert = $c; break }
}
if (-not $cert) { Write-Output 'STATUS 0 CERT_NOT_FOUND'; exit 0 }
$resp = $null
$erro = ''
try {
  $req = [System.Net.HttpWebRequest]::Create($env:JR_PMT_URL)
  $req.Timeout = ([int]$env:JR_PMT_TIMEOUT) * 1000
  $req.ReadWriteTimeout = ([int]$env:JR_PMT_TIMEOUT) * 1000
  $req.Accept = 'application/json'
  [void]$req.ClientCertificates.Add($cert)
  if ($env:JR_PMT_BODY) {
    $bytes = [System.IO.File]::ReadAllBytes($env:JR_PMT_BODY)
    $req.Method = 'POST'
    $req.ContentType = 'application/json'
    $req.ContentLength = $bytes.Length
    $s = $req.GetRequestStream()
    $s.Write($bytes, 0, $bytes.Length)
    $s.Close()
  } else {
    $req.Method = 'GET'
  }
  $resp = $req.GetResponse()
} catch {
  $ex = $_.Exception
  while ($ex -and -not ($ex -is [System.Net.WebException])) { $ex = $ex.InnerException }
  if ($ex -and $ex.Response) { $resp = $ex.Response } else { $erro = $_.Exception.Message }
}
if ($resp) {
  $ms = New-Object System.IO.MemoryStream
  $resp.GetResponseStream().CopyTo($ms)
  [System.IO.File]::WriteAllBytes($env:JR_PMT_OUT, $ms.ToArray())
  Write-Output ('STATUS ' + [int]$resp.StatusCode)
  $resp.Close()
} else {
  Write-Output ('STATUS 0 ' + $erro)
}
"""


@dataclass(slots=True)
class ApiResult:
    status: int  # HTTP; 0 = sem resposta do servidor
    data: dict[str, Any] = field(default_factory=dict)
    detail: str = ""

    def get(self, key: str) -> Any:
        """Campo da resposta sem ligar para maiúsculas (o Sefin usa camelCase; outros serviços, PascalCase)."""
        return _ci(self.data, key)

    @property
    def errors(self) -> list[dict[str, str]]:
        """Erros de negócio como [{"codigo", "mensagem"}]: da prefeitura ("erros" com "mensagem") ou do Sefin
        ("erros" ou "erro", com "descricao" e "complemento")."""
        raw = self.get("erros")
        items = raw if isinstance(raw, list) else [raw] if isinstance(raw, dict) else []
        single = self.get("erro")
        if isinstance(single, dict):
            items.append(single)
        elif isinstance(single, list):
            items.extend(single)
        out = []
        for e in items:
            if not isinstance(e, dict):
                continue
            codigo = str(_ci(e, "codigo") or "").strip()
            texto = str(_ci(e, "mensagem") or _ci(e, "descricao") or "").strip()
            extra = str(_ci(e, "complemento") or "").strip()
            if extra and extra not in texto:
                texto = f"{texto} ({extra})" if texto else extra
            if codigo or texto:
                out.append({"codigo": codigo, "mensagem": texto})
        return out

    @property
    def alerts(self) -> list[str]:
        """Avisos que o Sefin manda junto com a nota emitida (não impedem a emissão)."""
        raw = self.get("alertas")
        out = []
        for a in raw if isinstance(raw, list) else []:
            if isinstance(a, dict):
                text = " ".join(str(v).strip() for v in (_ci(a, "codigo"), _ci(a, "descricao") or _ci(a, "mensagem")) if v)
            else:
                text = str(a).strip()
            if text:
                out.append(text)
        return out

    @property
    def chave(self) -> str | None:
        value = digits(self.get("chaveAcesso"))[-50:]
        return value if _KEY.match(value) else None

    def xml_bytes(self, key: str) -> bytes | None:
        """Um XML da resposta (GZip + Base64), como veio. None se não veio ou veio ilegível."""
        value = self.get(key)
        if not isinstance(value, str) or not value:
            return None
        try:
            raw = base64.b64decode(value)
            return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
        except (binascii.Error, OSError, EOFError, ValueError):
            return None

    def xml(self, key: str) -> str | None:
        raw = self.xml_bytes(key)
        return raw.decode("utf-8", "replace") if raw is not None else None

    @property
    def summary(self) -> str:
        erros = "; ".join(f"{e['codigo']}: {e['mensagem']}".strip(": ") for e in self.errors)
        return erros or self.detail or f"HTTP {self.status}"


def _ci(data: Any, key: str) -> Any:
    """data[key] sem ligar para maiúsculas e minúsculas."""
    if not isinstance(data, dict):
        return None
    if key in data:
        return data[key]
    low = key.lower()
    return next((v for k, v in data.items() if isinstance(k, str) and k.lower() == low), None)


# (url, impressão digital, corpo ou None, arquivo de saída, timeout) -> (status HTTP, detalhe)
Runner = Callable[[str, str, bytes | None, Path, int], Awaitable[tuple[int, str]]]


async def _powershell(url: str, thumbprint: str, body: bytes | None, out: Path, timeout: int) -> tuple[int, str]:
    if sys.platform != "win32":
        raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "A API da prefeitura usa o certificado do Windows.")
    body_path = out.with_suffix(".req.json")
    env = {**os.environ, "JR_PMT_URL": url, "JR_PMT_THUMB": thumbprint, "JR_PMT_OUT": str(out), "JR_PMT_TIMEOUT": str(timeout), "JR_PMT_BODY": ""}
    try:
        if body is not None:
            body_path.write_bytes(body)
            env["JR_PMT_BODY"] = str(body_path)
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
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout + 45)
        except TimeoutError:
            proc.kill()
            return 0, "a prefeitura não respondeu a tempo"
    finally:
        body_path.unlink(missing_ok=True)  # arquivo temporário do envio (não é nota)
    text = stdout.decode("utf-8", "replace")
    m = re.search(r"STATUS (\d+)(?: (.*))?", text)
    if not m:
        return 0, (stderr.decode("utf-8", "replace") or text).strip()[:300]
    return int(m.group(1)), (m.group(2) or "").strip()


class PrefeituraClient:
    """Fala com a API de NFS-e do município emissor em nome do dono do certificado."""

    #: nome do serviço nas mensagens
    label = "a prefeitura"
    #: caminho da consulta pela DPS
    dps_path = "nfse/dps/{id}"

    def __init__(
        self,
        thumbprint: str,
        *,
        test_env: bool,
        municipio: str = TERESINA,
        timeout: int = 150,
        runner: Runner | None = None,
    ) -> None:
        tp = (thumbprint or "").replace(" ", "").upper()
        if not _THUMBPRINT.match(tp):
            raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Impressão digital do certificado inválida.")
        self.thumbprint = tp
        self.test_env = bool(test_env)
        self.base_url = self._base_url(municipio, self.test_env)
        self.timeout = timeout
        self._run = runner or _powershell

    @staticmethod
    def _base_url(municipio: str, test_env: bool) -> str:
        if municipio not in ENDPOINTS:
            raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Emissão de NFS-e ainda não disponível para este município.")
        return ENDPOINTS[municipio]["test" if test_env else "prod"]

    def _check_environment(self, signed: bytes) -> None:
        marker = b"<tpAmb>2</tpAmb>" if self.test_env else b"<tpAmb>1</tpAmb>"
        if marker not in signed or b"<Signature" not in signed:
            raise AutomationError(
                ErrorCode.INVALID_CONFIGURATION,
                "O XML não está assinado ou não é do ambiente escolhido (teste ou produção); envio bloqueado.",
            )

    async def _call(self, path: str, payload: dict[str, str] | None = None) -> ApiResult:
        out = Path(tempfile.gettempdir()) / f"jr-pmt-{uuid.uuid4().hex}.json"
        body = json.dumps(payload).encode("ascii") if payload is not None else None
        try:
            status, detail = await self._run(f"{self.base_url}/{path}", self.thumbprint, body, out, self.timeout)
            raw = out.read_bytes() if out.is_file() else b""
        finally:
            out.unlink(missing_ok=True)  # arquivo temporário da resposta (não é nota)
        if status == 0 and detail == "CERT_NOT_FOUND":
            raise CertificateNotInstalledError("Certificado do cliente não encontrado no Windows deste computador (com chave privada).")
        data: Any = {}
        for encoding in ("utf-8", "latin-1"):
            try:
                data = json.loads(raw.decode(encoding)) if raw.strip() else {}
                break
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
        result = ApiResult(status=status, data=data if isinstance(data, dict) else {}, detail=detail)
        if status in (401, 403, 495, 496):
            # certificado recusado (vencido, revogado ou de outro CNPJ): tentar de novo não resolve
            raise AutomationError(
                ErrorCode.CERTIFICATE_REQUIRED, f"{self.label[0].upper()}{self.label[1:]} recusou o certificado (HTTP {status}): {result.summary}"
            )
        return result

    @staticmethod
    def _pack(xml: bytes) -> str:
        return base64.b64encode(gzip.compress(xml)).decode("ascii")

    async def emit(self, signed_dps: bytes) -> ApiResult:
        """Envia a DPS assinada. 201 = nota emitida (chaveAcesso e nfseXmlGZipB64)."""
        self._check_environment(signed_dps)
        return await self._call("nfse", {"dpsXmlGZipB64": self._pack(signed_dps)})

    async def register_event(self, chave: str, signed_event: bytes) -> ApiResult:
        """Registra um evento (cancelamento) na nota. 200/201 = aceito (eventoXmlGZipB64)."""
        if not _KEY.match(chave or ""):
            raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Chave de acesso da NFS-e inválida.")
        self._check_environment(signed_event)
        return await self._call(f"nfse/{chave}/eventos", {"pedidoRegistroEventoXmlGZipB64": self._pack(signed_event)})

    async def find_by_dps(self, dps_id: str) -> str | None:
        """Chave da nota gerada por esta DPS; None se a prefeitura não conhece a DPS (o número está livre)."""
        if not _DPS_ID.match(dps_id or ""):
            raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Id da DPS inválido.")
        result = await self._call(self.dps_path.format(id=dps_id))
        if result.status == 404:
            return None
        if result.status == 200 and result.chave:
            return result.chave
        raise AutomationError(
            ErrorCode.NFSE_UNAVAILABLE, f"{self.label[0].upper()}{self.label[1:]} não respondeu à consulta da DPS ({result.summary}).", retryable=True
        )

    async def get_nfse(self, chave: str) -> bytes | None:
        """XML da NFS-e pela chave (bytes, como a prefeitura assinou); None se não existe."""
        if not _KEY.match(chave or ""):
            raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Chave de acesso da NFS-e inválida.")
        result = await self._call(f"nfse/{chave}")
        if result.status == 404:
            return None
        xml = result.xml_bytes("nfseXmlGZipB64") if result.status == 200 else None
        if xml is None:
            raise AutomationError(
                ErrorCode.NFSE_UNAVAILABLE, f"{self.label[0].upper()}{self.label[1:]} não devolveu a NFS-e ({result.summary}).", retryable=True
            )
        return xml


class SefinClient(PrefeituraClient):
    """Sefin Nacional: onde a ME/EPP do Simples emite desde 01/11/2026 (mesmos campos, outro endereço)."""

    label = "o ambiente nacional da NFS-e"
    dps_path = "dps/{id}"

    @staticmethod
    def _base_url(municipio: str, test_env: bool) -> str:
        return SEFIN_ENDPOINTS["test" if test_env else "prod"]


def generated_by_prefeitura(chave: str | None) -> bool:
    """A chave de acesso diz quem gerou a nota: posição 8 = ambiente gerador (1 = prefeitura, 2 = Sefin Nacional).
    O evento (cancelamento) vai para quem gerou."""
    return bool(chave) and len(chave) == 50 and chave[7] == "1"
