"""Certificados: inspeção de PFX, cofre de senha, repositório do Windows e política do Chrome."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response

from app.api.deps import CurrentUser, require_admin, settings_dep
from app.api.schemas import PolicyApplyRequest, SecretRequest
from app.certificates.chrome_policy import ChromeCertificatePolicyService, PolicyWriteNotAllowed
from app.certificates.pfx_inspector import PfxError, inspect_pfx
from app.certificates.secret_manager import CertificateSecretManager, SecretBackendError
from app.certificates.windows_store import list_user_certificates
from app.config import Settings
from app.jobs.models import Certificate
from app.services.supabase_client import get_supabase

router = APIRouter(prefix="/certificates", tags=["certificates"])

MAX_PFX_BYTES = 64 * 1024


async def _load_certificate(settings: Settings, certificate_id: str) -> Certificate:
    sb = await get_supabase(settings)
    res = await sb.table("certificates").select("*").eq("id", certificate_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Certificado não encontrado")
    return Certificate.model_validate(res.data[0])


async def _audit(settings: Settings, user: CurrentUser, action: str, cert: Certificate, data: dict) -> None:
    sb = await get_supabase(settings)
    await sb.table("audit_logs").insert(
        {
            "user_id": user.id,
            "action": action,
            "entity": "certificate",
            "entity_id": cert.id,
            "client_id": cert.client_id,
            "data": data,
        }
    ).execute()


@router.post("/inspect")
async def inspect_certificate(
    file: UploadFile = File(...),
    password: str = Form(default=""),
    _user: CurrentUser = Depends(require_admin),
) -> dict:
    """Lê metadados do PFX em memória. O arquivo e a senha NÃO são armazenados."""
    data = await file.read(MAX_PFX_BYTES + 1)
    if len(data) > MAX_PFX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Arquivo muito grande para um certificado A1")
    try:
        info = inspect_pfx(data, password or None)
    except PfxError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    finally:
        del data
    return info.to_dict()


@router.put("/{certificate_id}/secret", status_code=status.HTTP_204_NO_CONTENT)
async def save_secret(
    certificate_id: str,
    body: SecretRequest,
    user: CurrentUser = Depends(require_admin),
    settings: Settings = Depends(settings_dep),
) -> None:
    cert = await _load_certificate(settings, certificate_id)
    try:
        manager = CertificateSecretManager.from_settings(settings)
        manager.save_secret(cert.id, body.secret)
    except SecretBackendError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    sb = await get_supabase(settings)
    await sb.table("certificates").update({"has_secret": True}).eq("id", cert.id).execute()
    await _audit(settings, user, "certificate.secret_saved", cert, {"backend": manager.backend_name})


@router.delete("/{certificate_id}/secret", status_code=status.HTTP_204_NO_CONTENT)
async def delete_secret(
    certificate_id: str,
    user: CurrentUser = Depends(require_admin),
    settings: Settings = Depends(settings_dep),
) -> None:
    cert = await _load_certificate(settings, certificate_id)
    try:
        CertificateSecretManager.from_settings(settings).delete_secret(cert.id)
    except SecretBackendError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    sb = await get_supabase(settings)
    await sb.table("certificates").update({"has_secret": False}).eq("id", cert.id).execute()
    await _audit(settings, user, "certificate.secret_deleted", cert, {})


@router.get("/store")
async def windows_store(_user: CurrentUser = Depends(require_admin)) -> list[dict]:
    """Certificados instalados em Cert:\\CurrentUser\\My na máquina do worker (somente metadados)."""
    certs = await list_user_certificates()
    return [
        {
            "subject": c.subject,
            "issuer": c.issuer,
            "thumbprint": c.thumbprint,
            "serial_number": c.serial_number,
            "has_private_key": c.has_private_key,
            "not_before": c.not_before.isoformat() if c.not_before else None,
            "not_after": c.not_after.isoformat() if c.not_after else None,
        }
        for c in certs
    ]


def _policy_service(settings: Settings) -> ChromeCertificatePolicyService:
    return ChromeCertificatePolicyService(
        channel=settings.browser_channel,
        allow_write=settings.chrome_policy_allow_write,
        state_file=settings.profiles_dir / "_chrome_policy_state.json",
    )


@router.get("/{certificate_id}/chrome-policy")
async def chrome_policy_preview(
    certificate_id: str,
    _user: CurrentUser = Depends(require_admin),
    settings: Settings = Depends(settings_dep),
) -> dict:
    cert = await _load_certificate(settings, certificate_id)
    service = _policy_service(settings)
    entry = service.entry_for_certificate(cert, settings.chrome_policy_pattern)
    return {
        "registry_key": ("HKCU\\" if service.scope == "user" else "HKLM\\") + service.key_path,
        "value": entry.to_policy_json(),
        "reg_file": service.render_reg_file([entry]),
        "write_enabled": settings.chrome_policy_allow_write,
        "mode": settings.chrome_policy_mode,
    }


@router.get("/{certificate_id}/chrome-policy.reg")
async def chrome_policy_reg(
    certificate_id: str,
    _user: CurrentUser = Depends(require_admin),
    settings: Settings = Depends(settings_dep),
) -> Response:
    cert = await _load_certificate(settings, certificate_id)
    service = _policy_service(settings)
    content = service.render_reg_file([service.entry_for_certificate(cert, settings.chrome_policy_pattern)])
    # regedit "Version 5.00" espera UTF-16 LE com BOM
    return Response(
        content.encode("utf-16"),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="siat-autoselect-{cert.id[:8]}.reg"'},
    )


@router.post("/{certificate_id}/chrome-policy/apply")
async def chrome_policy_apply(
    certificate_id: str,
    body: PolicyApplyRequest,
    user: CurrentUser = Depends(require_admin),
    settings: Settings = Depends(settings_dep),
) -> dict:
    cert = await _load_certificate(settings, certificate_id)
    service = _policy_service(settings)
    try:
        created = service.apply([service.entry_for_certificate(cert, settings.chrome_policy_pattern)], confirm=body.confirm)
    except PolicyWriteNotAllowed as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    await _audit(settings, user, "certificate.chrome_policy_applied", cert, {"values": created})
    return {"created": created}
