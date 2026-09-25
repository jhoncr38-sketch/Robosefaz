"""SiatAutomationProvider: implementação do AutomationProvider para o SIAT Web (SEFAZ-PI)."""

from __future__ import annotations

from contextlib import AsyncExitStack, asynccontextmanager
from typing import AsyncIterator

from app.automation.base import AutomationContext, AutomationProvider
from app.automation.siat.selectors import SiatSelectors, get_selectors
from app.automation.siat.siat_downloads import SiatExportConsult
from app.automation.siat.siat_legacy import SiatLegacy
from app.automation.siat.siat_login import SiatLogin
from app.automation.siat.siat_navigation import SiatNavigation
from app.automation.siat.siat_nfce import schedule_nfce_export
from app.automation.siat.siat_nfe import schedule_nfe_issued_export, schedule_nfe_received_export
from app.automation.siat.siat_scheduler import SiatExportScheduler
from app.automation.siat.siat_taxpayer import SiatTaxpayer
from app.browser.browser_factory import BrowserOptions, BrowserSession
from app.browser.screenshots import capture_error_screenshot
from app.certificates.certificate_profile import CertificateProfile
from app.certificates.chrome_policy import ChromeCertificatePolicyService, PolicyWriteNotAllowed
from app.jobs.errors import AutomationError, ErrorCode, JobCancelled
from app.jobs.models import DownloadedFile, ExportRequestResult, ExportStatusResult, Task, TaskType
from app.jobs.state_machine import JobStatus


class SiatAutomationProvider(AutomationProvider):
    name = "SIAT"
    supported_tasks = frozenset(
        {TaskType.NFCE_EXPORT, TaskType.NFE_ISSUED_EXPORT, TaskType.NFE_RECEIVED_EXPORT}
    )

    def __init__(self, selectors: SiatSelectors | None = None) -> None:
        self.sel = selectors or get_selectors()

    # -- sessão -------------------------------------------------------------
    @asynccontextmanager
    async def open_session(self, ctx: AutomationContext) -> AsyncIterator[AutomationContext]:
        await ctx.reporter.step(JobStatus.OPENING_BROWSER, "Abrindo navegador")
        profile = CertificateProfile(ctx.settings.profiles_dir, ctx.client, ctx.certificate)
        user_data_dir, warnings = profile.prepare()
        for w in warnings:
            await ctx.logger.warning(w, step="opening_browser")
        ctx.state["tmp_dir"] = profile.downloads_tmp_dir

        async with AsyncExitStack() as stack:
            if ctx.settings.chrome_policy_mode == "per_job" and ctx.certificate is not None:
                policy = ChromeCertificatePolicyService(
                    channel=ctx.settings.browser_channel,
                    allow_write=ctx.settings.chrome_policy_allow_write,
                    state_file=ctx.settings.profiles_dir / "_chrome_policy_state.json",
                )
                try:
                    await stack.enter_async_context(
                        policy.applied_for_job(ctx.certificate, ctx.settings.chrome_policy_pattern)
                    )
                    await ctx.logger.info(
                        "Política AutoSelectCertificateForUrls aplicada para este job.", step="opening_browser"
                    )
                except (PolicyWriteNotAllowed, OSError) as exc:
                    # Sem permissão (ex.: worker sem elevação) ou máquina gerenciada:
                    # segue no modo manual em vez de falhar o job.
                    await ctx.logger.warning(
                        f"Política do Chrome não aplicada ({exc}). A seleção do certificado será manual.",
                        step="opening_browser",
                    )

            options = BrowserOptions.from_settings(
                ctx.settings, user_data_dir, profile.downloads_tmp_dir, owner=f"job:{ctx.job.id}"
            )
            session = await stack.enter_async_context(BrowserSession(options))
            ctx.page = session.page
            await ctx.logger.info(
                f"Navegador aberto com perfil exclusivo do cliente {ctx.client.client_code}.", step="opening_browser"
            )
            try:
                yield ctx
            except BaseException as exc:
                # screenshot ANTES de fechar o navegador (depois não há mais página)
                if not isinstance(exc, JobCancelled):
                    ctx.state["error_screenshot"] = await capture_error_screenshot(
                        ctx.page, ctx.settings.errors_dir, ctx.job.id
                    )
                if isinstance(exc, AutomationError) and exc.code in (
                    ErrorCode.SECURITY_CLIENT_MISMATCH,
                    ErrorCode.TAXPAYER_MISMATCH,
                ):
                    # fechar sessão no portal antes de fechar o navegador
                    await SiatLogin(ctx, self.sel).logout()
                raise
            finally:
                ctx.page = None

    # -- etapas ---------------------------------------------------------------
    async def login(self, ctx: AutomationContext) -> None:
        await SiatLogin(ctx, self.sel).login()

    async def select_company(self, ctx: AutomationContext) -> None:
        await SiatTaxpayer(ctx, self.sel).select()

    async def verify_company(self, ctx: AutomationContext) -> None:
        legacy = SiatLegacy(ctx, self.sel)
        if legacy.on_legacy():
            # SIAT web legado: não mostra CNPJ; valida pela IE do cliente
            await legacy.verify()
        else:
            await SiatTaxpayer(ctx, self.sel).verify(security=True)

    async def _ensure_export_area(self, ctx: AutomationContext) -> None:
        # o contribuinte é confirmado pelo CNPJ no painel ANTES de sair dele
        if not SiatLegacy(ctx, self.sel).on_legacy():
            await SiatTaxpayer(ctx, self.sel).verify(security=True)
        await SiatNavigation(ctx, self.sel).ensure_export_area()

    async def schedule(self, ctx: AutomationContext, task: Task) -> ExportRequestResult:
        if task.task_type not in self.supported_tasks:
            raise AutomationError(ErrorCode.INVALID_CONFIGURATION, f"Tarefa não suportada: {task.task_type}")
        await self._ensure_export_area(ctx)
        scheduler = SiatExportScheduler(ctx, lambda: self.verify_company(ctx), self.sel)
        args = (scheduler, ctx.client, ctx.start_date, ctx.end_date, ctx.job.competence)
        if task.task_type == TaskType.NFCE_EXPORT:
            return await schedule_nfce_export(*args)
        if task.task_type == TaskType.NFE_ISSUED_EXPORT:
            return await schedule_nfe_issued_export(*args)
        return await schedule_nfe_received_export(*args)

    async def check_status(self, ctx: AutomationContext, tasks: list[Task]) -> list[ExportStatusResult]:
        await self._ensure_export_area(ctx)
        consult = SiatExportConsult(ctx, lambda: self.verify_company(ctx), self.sel)
        return await consult.check(tasks)

    async def download(self, ctx: AutomationContext, task: Task, status: ExportStatusResult) -> DownloadedFile:
        consult = SiatExportConsult(ctx, lambda: self.verify_company(ctx), self.sel)
        return await consult.download(task, status, ctx.state["tmp_dir"])
