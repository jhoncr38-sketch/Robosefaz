"""Primitivas de interação com páginas Vuetify usando localizadores semânticos.

Prioridade: get_by_role -> get_by_label -> get_by_text. Nada de coordenadas.
"""

from __future__ import annotations

import asyncio
import re
from typing import Sequence

from playwright.async_api import Error as PlaywrightError, Locator, Page, TimeoutError as PlaywrightTimeout

from app.jobs.errors import AutomationError, ErrorCode

CLICKABLE_ROLES: tuple[str, ...] = ("button", "link", "menuitem", "tab", "option", "treeitem")


async def first_visible(candidates: Sequence[Locator], timeout_ms: int = 5_000) -> Locator | None:
    """Retorna o primeiro localizador visível dentre os candidatos (polling)."""
    deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
    while True:
        for loc in candidates:
            try:
                count = await loc.count()
            except PlaywrightError:
                continue
            for i in range(min(count, 10)):
                item = loc.nth(i)
                try:
                    if await item.is_visible():
                        return item
                except PlaywrightError:
                    continue
        if asyncio.get_running_loop().time() >= deadline:
            return None
        await asyncio.sleep(0.25)


def clickable_candidates(scope: Page | Locator, pattern: re.Pattern[str]) -> list[Locator]:
    cands: list[Locator] = [scope.get_by_role(role, name=pattern) for role in CLICKABLE_ROLES]  # type: ignore[arg-type]
    cands.append(scope.get_by_title(pattern))
    cands.append(scope.get_by_text(pattern))
    return cands


async def find_clickable(scope: Page | Locator, pattern: re.Pattern[str], timeout_ms: int = 5_000) -> Locator | None:
    return await first_visible(clickable_candidates(scope, pattern), timeout_ms)


async def click_by_text(
    scope: Page | Locator, pattern: re.Pattern[str], *, what: str, timeout_ms: int = 10_000
) -> None:
    loc = await find_clickable(scope, pattern, timeout_ms)
    if loc is None:
        raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, f"Elemento não encontrado: {what} ({pattern.pattern})")
    await loc.click()


async def text_visible(scope: Page | Locator, pattern: re.Pattern[str], timeout_ms: int = 0) -> bool:
    loc = await first_visible([scope.get_by_text(pattern)], timeout_ms)
    return loc is not None


async def find_field(scope: Page | Locator, label: re.Pattern[str], timeout_ms: int = 5_000) -> Locator | None:
    return await first_visible(
        [
            scope.get_by_label(label),
            scope.get_by_role("textbox", name=label),
            scope.get_by_role("combobox", name=label),
            scope.get_by_placeholder(label),
            # telas antigas (JSF em tabela): o texto do rótulo não tem <label for>;
            # o campo é o primeiro input/select que vem depois do texto
            scope.get_by_text(label).locator(
                "xpath=following::*[self::input[not(@type='hidden') and not(@type='radio') "
                "and not(@type='checkbox') and not(@type='button') and not(@type='submit')] or self::select][1]"
            ),
        ],
        timeout_ms,
    )


async def fill_field(scope: Page | Locator, label: re.Pattern[str], value: str, *, what: str) -> None:
    field = await find_field(scope, label)
    if field is None:
        raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, f"Campo não encontrado: {what} ({label.pattern})")
    await field.click()
    await field.fill("")
    await field.fill(value)
    await field.press("Tab")
    current = (await field.input_value()).strip()
    digits = re.sub(r"\D", "", value)
    if current != value and re.sub(r"\D", "", current) != digits:
        # máscaras de data do Vuetify às vezes exigem digitação lenta
        await field.fill("")
        await field.press_sequentially(value, delay=40)
        await field.press("Tab")


async def select_option(
    page: Page, label: re.Pattern[str], option: re.Pattern[str], *, what: str, timeout_ms: int = 10_000
) -> str:
    """Seleciona opção em <select> nativo ou v-select/v-autocomplete do Vuetify."""
    field = await find_field(page, label, timeout_ms)
    if field is None:
        raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, f"Seleção não encontrada: {what} ({label.pattern})")

    tag = await field.evaluate("el => el.tagName.toLowerCase()")
    if tag == "select":
        options = await field.locator("option").all_inner_texts()
        for text in options:
            if option.search(text):
                await field.select_option(label=text)
                return text.strip()
        raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, f"Opção não encontrada em {what}: {option.pattern}")

    await field.click()
    listbox_opts = [
        page.get_by_role("option", name=option),
        page.locator(".v-menu__content .v-list-item, .v-select-list .v-list-item").filter(has_text=option),
    ]
    opt = await first_visible(listbox_opts, timeout_ms)
    if opt is None:
        await page.keyboard.press("Escape")
        raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, f"Opção não encontrada em {what}: {option.pattern}")
    text = (await opt.inner_text()).strip()
    await opt.click()
    return text


async def wait_idle(page: Page, timeout_ms: int = 15_000) -> None:
    """Aguarda a rede ficar ociosa e loaders do Vuetify sumirem (best effort)."""
    try:
        await page.wait_for_load_state("networkidle", timeout=timeout_ms)
    except PlaywrightTimeout:
        pass
    try:
        await page.locator(".v-progress-circular, .v-progress-linear--active, #nuxt-loading").first.wait_for(
            state="hidden", timeout=timeout_ms
        )
    except (PlaywrightTimeout, PlaywrightError):
        pass


async def dialog_by_title(page: Page, title: re.Pattern[str], timeout_ms: int = 5_000) -> Locator | None:
    return await first_visible(
        [
            page.get_by_role("dialog").filter(has_text=title),
            page.locator(".v-dialog--active, .v-dialog, .ui-dialog, .modal").filter(has_text=title),
        ],
        timeout_ms,
    )


async def table_rows(scope: Page | Locator) -> list[Locator]:
    """Linhas de tabelas VISÍVEIS (diálogos ocultos do Vuetify continuam no DOM)."""
    rows = scope.locator("table:visible tbody tr")
    count = await rows.count()
    return [rows.nth(i) for i in range(count)]


async def row_cells(row: Locator) -> list[str]:
    return [c.strip() for c in await row.locator("td").all_inner_texts()]


async def header_texts(scope: Page | Locator) -> list[str]:
    return [h.strip() for h in await scope.locator("table:visible thead th").all_inner_texts()]
