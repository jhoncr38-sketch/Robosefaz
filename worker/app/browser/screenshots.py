"""Screenshots de erro e de etapas (modo debug)."""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

from playwright.async_api import Page

from app.utils.files import ensure_dir, safe_name

log = logging.getLogger(__name__)


def _stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


async def capture_error_screenshot(page: Page | None, errors_dir: Path, job_id: str) -> str | None:
    """Salva storage/errors/{jobid}_{datahora}.png e retorna o caminho."""
    if page is None or page.is_closed():
        return None
    path = ensure_dir(errors_dir) / f"{safe_name(job_id)}_{_stamp()}.png"
    try:
        await page.screenshot(path=str(path), full_page=True, timeout=15_000)
        return str(path)
    except Exception as exc:
        log.warning("Não foi possível capturar screenshot de erro: %s", exc)
        return None


async def capture_step_screenshot(page: Page | None, screenshots_dir: Path, job_id: str, step: str) -> str | None:
    if page is None or page.is_closed():
        return None
    folder = ensure_dir(screenshots_dir / safe_name(job_id))
    path = folder / f"{_stamp()}_{safe_name(step)}.png"
    try:
        await page.screenshot(path=str(path), full_page=True, timeout=15_000)
        return str(path)
    except Exception as exc:
        log.debug("Screenshot de etapa falhou: %s", exc)
        return None
