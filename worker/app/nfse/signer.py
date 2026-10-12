"""Assinatura digital (XMLDSIG) da DPS e dos eventos da NFS-e com o certificado do cliente.

O certificado fica no repositório do Windows, quase sempre com a chave privada não exportável: quem
assina é o próprio Windows (PowerShell + .NET SignedXml). O robô nunca lê a chave nem pede senha.

Formato exigido pela API da prefeitura (padrão nacional): assinatura "enveloped" do elemento com Id
(infDPS ou infPedReg), canonicalização C14N, RSA-SHA1, e a tag <Signature> logo depois do elemento
assinado. O arquivo assinado é conferido antes de ser devolvido.
"""

from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import tempfile
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path

from app.jobs.errors import AutomationError, CertificateNotInstalledError, ErrorCode

_THUMBPRINT = re.compile(r"^[0-9A-F]{40}$")
SIGNED_TAGS = frozenset({"infDPS", "infPedReg"})

# Os parâmetros vão por variáveis de ambiente, nunca montados dentro do script.
_PS_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $tp = $env:JR_SIGN_THUMB
  $cert = $null
  foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\LocalMachine\My') {
    $c = Get-ChildItem -LiteralPath $store -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $tp -and $_.HasPrivateKey } | Select-Object -First 1
    if ($c) { $cert = $c; break }
  }
  if (-not $cert) { Write-Output 'SIGN CERT_NOT_FOUND'; exit 0 }
  $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
  if (-not $key) { Write-Output 'SIGN ERROR o certificado nao tem chave RSA'; exit 0 }
  $doc = New-Object System.Xml.XmlDocument
  $doc.PreserveWhitespace = $true
  $doc.Load($env:JR_SIGN_IN)
  $node = $doc.GetElementsByTagName($env:JR_SIGN_TAG)[0]
  if (-not $node) { Write-Output 'SIGN ERROR elemento a assinar nao encontrado'; exit 0 }
  $id = $node.GetAttribute('Id')
  if (-not $id) { Write-Output 'SIGN ERROR elemento sem Id'; exit 0 }
  $signed = New-Object System.Security.Cryptography.Xml.SignedXml($doc)
  $signed.SigningKey = $key
  $signed.SignedInfo.CanonicalizationMethod = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
  $signed.SignedInfo.SignatureMethod = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'
  $ref = New-Object System.Security.Cryptography.Xml.Reference('#' + $id)
  $ref.DigestMethod = 'http://www.w3.org/2000/09/xmldsig#sha1'
  $ref.AddTransform((New-Object System.Security.Cryptography.Xml.XmlDsigEnvelopedSignatureTransform))
  $ref.AddTransform((New-Object System.Security.Cryptography.Xml.XmlDsigC14NTransform))
  $signed.AddReference($ref)
  $ki = New-Object System.Security.Cryptography.Xml.KeyInfo
  $ki.AddClause((New-Object System.Security.Cryptography.Xml.KeyInfoX509Data($cert)))
  $signed.KeyInfo = $ki
  $signed.ComputeSignature()
  [void]$node.ParentNode.InsertAfter($doc.ImportNode($signed.GetXml(), $true), $node)
  [System.IO.File]::WriteAllText($env:JR_SIGN_OUT, $doc.OuterXml, (New-Object System.Text.UTF8Encoding($false)))
  $check = New-Object System.Xml.XmlDocument
  $check.PreserveWhitespace = $true
  $check.Load($env:JR_SIGN_OUT)
  $v = New-Object System.Security.Cryptography.Xml.SignedXml($check)
  $v.LoadXml($check.GetElementsByTagName('Signature')[0])
  if ($v.CheckSignature($cert, $true)) { Write-Output 'SIGN OK' } else { Write-Output 'SIGN ERROR a assinatura nao confere' }
} catch {
  Write-Output ('SIGN ERROR ' + $_.Exception.Message)
}
"""

# (xml de entrada, impressão digital, elemento, arquivo de saída) -> detalhe ("OK", "CERT_NOT_FOUND" ou "ERROR ...")
Runner = Callable[[Path, str, str, Path], Awaitable[str]]


async def _powershell(source: Path, thumbprint: str, element: str, out: Path) -> str:
    if sys.platform != "win32":
        raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "A assinatura da NFS-e usa o certificado do Windows.")
    env = {**os.environ, "JR_SIGN_IN": str(source), "JR_SIGN_OUT": str(out), "JR_SIGN_THUMB": thumbprint, "JR_SIGN_TAG": element}
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
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=90)
    except TimeoutError:
        proc.kill()
        raise AutomationError(ErrorCode.TIMEOUT, "A assinatura da NFS-e não terminou a tempo.") from None
    text = stdout.decode("utf-8", "replace")
    m = re.search(r"SIGN (OK|CERT_NOT_FOUND|ERROR.*)", text)
    if not m:
        return "ERROR " + (stderr.decode("utf-8", "replace") or text).strip()[:300]
    return m.group(1).strip()


async def sign_xml(xml: str, thumbprint: str, element: str, *, runner: Runner | None = None) -> bytes:
    """Assina o elemento `element` (infDPS ou infPedReg) e devolve o XML assinado, pronto para enviar."""
    tp = (thumbprint or "").replace(" ", "").upper()
    if not _THUMBPRINT.match(tp):
        raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Impressão digital do certificado inválida.")
    if element not in SIGNED_TAGS:
        raise AutomationError(ErrorCode.INVALID_CONFIGURATION, f"Elemento não previsto para assinatura: {element}.")
    base = Path(tempfile.gettempdir()) / f"jr-nfse-sign-{uuid.uuid4().hex}"
    source, out = base.with_suffix(".xml"), base.with_suffix(".signed.xml")
    try:
        source.write_text(xml, encoding="utf-8")
        detail = await (runner or _powershell)(source, tp, element, out)
        if detail == "CERT_NOT_FOUND":
            raise CertificateNotInstalledError("Certificado do cliente não encontrado no Windows deste computador (com chave privada).")
        if detail != "OK" or not out.is_file():
            raise AutomationError(
                ErrorCode.INVALID_CONFIGURATION, f"Não foi possível assinar a NFS-e com o certificado do cliente: {detail[:200]}"
            )
        signed = out.read_bytes()
    finally:
        # arquivos temporários da assinatura (não são notas)
        source.unlink(missing_ok=True)
        out.unlink(missing_ok=True)
    if b"<Signature" not in signed:
        raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "O XML assinado veio sem a assinatura.")
    return signed
