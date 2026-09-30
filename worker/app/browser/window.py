"""Janela do navegador do robô: fica escondida fora da tela e volta quando precisa.

- O Chrome abre além da área de todos os monitores (``--window-position``). Ele
  continua funcionando igual (Web PKI, certificado, fotos das etapas); só não
  aparece. Se ao abrir ele roubar o foco, o foco volta para a janela que a
  pessoa estava usando.
- Janelas extras que o site abrir (pop-ups) também são escondidas.
- Escondido, o Chrome nunca fica com o foco: quando o robô troca de aba (o que
  ativa a janela no Windows) ou o Chrome se ativa sozinho, o foco volta na hora
  para a janela da pessoa, e o que ela digita não vai parar no SIAT.
- "Mostrar navegador do robô" (ícone ao lado do relógio) ou um clique no botão
  do Chrome na barra de tarefas traz a janela para a frente; quando o robô pede
  intervenção (certificado, Web PKI, CAPTCHA), ela volta para a tela sozinha e
  se esconde de novo depois.
- Só as janelas do Chrome aberto por ESTE robô (processos filhos do worker) são
  mexidas pelo Windows; o Chrome pessoal nunca é tocado.

    BROWSER_WINDOW=hidden (padrão) | visible
"""

from __future__ import annotations

import asyncio
import ctypes
import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, AsyncIterator, Literal

if TYPE_CHECKING:
    from playwright.async_api import BrowserContext, Page

log = logging.getLogger(__name__)

WindowState = Literal["none", "hidden", "shown"]
SHOW_AT = (60, 40)  # canto da janela quando aparece (monitor principal)
_MARGIN = 200  # distância além da borda dos monitores


# -- Windows (ctypes) ------------------------------------------------------------------
def _user32():  # noqa: ANN202
    return ctypes.windll.user32  # type: ignore[attr-defined]


def virtual_screen() -> tuple[int, int, int, int]:
    """(x, y, largura, altura) da área que junta todos os monitores."""
    if sys.platform != "win32":
        return (0, 0, 1920, 1080)
    u = _user32()
    return (u.GetSystemMetrics(76), u.GetSystemMetrics(77), u.GetSystemMetrics(78), u.GetSystemMetrics(79))


def offscreen_origin(screen: tuple[int, int, int, int] | None = None) -> tuple[int, int]:
    """Posição à direita e abaixo de todos os monitores (nunca -32000, que o Windows usa para minimizada)."""
    x, y, w, h = screen or virtual_screen()
    return (x + w + _MARGIN, y + h + _MARGIN)


def hidden_launch_args(*, headless: bool, window: str) -> list[str]:
    """Argumentos do Chrome para nascer escondido (só com janela, no Windows e BROWSER_WINDOW=hidden)."""
    if headless or window != "hidden" or sys.platform != "win32":
        return []
    x, y = offscreen_origin()
    return [f"--window-position={x},{y}"]


def _descendant_pids(root: int) -> set[int]:
    """Processos filhos (e netos) do worker: o Playwright e o Chrome que ele abriu."""
    from ctypes import wintypes as wt

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wt.DWORD),
            ("cntUsage", wt.DWORD),
            ("th32ProcessID", wt.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wt.DWORD),
            ("cntThreads", wt.DWORD),
            ("th32ParentProcessID", wt.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wt.DWORD),
            ("szExeFile", wt.WCHAR * 260),
        ]

    k32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if snap in (None, wt.HANDLE(-1).value):
        return set()
    children: dict[int, list[int]] = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            children.setdefault(entry.th32ParentProcessID, []).append(entry.th32ProcessID)
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    found: set[int] = set()
    todo = [root]
    while todo:
        for pid in children.get(todo.pop(), []):
            if pid not in found and pid != root:
                found.add(pid)
                todo.append(pid)
    return found


def own_windows() -> list[int]:
    """Janelas visíveis dos processos do Chrome aberto por este worker."""
    if sys.platform != "win32":
        return []
    from ctypes import wintypes as wt

    pids = _descendant_pids(os.getpid())
    if not pids:
        return []
    u = _user32()
    found: list[int] = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def visit(hwnd, _lparam):  # noqa: ANN001, ANN202
        pid = wt.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids and u.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    u.EnumWindows(visit, 0)
    return found


def foreground_window() -> int:
    return _user32().GetForegroundWindow() if sys.platform == "win32" else 0


def _set_foreground(hwnd: int, *, nudge: bool = False) -> bool:
    """SetForegroundWindow "emprestando" a entrada da janela que está na frente (regra do Windows).

    `nudge`: se o Windows recusar, um movimento de mouse de 0 px torna este processo o dono da
    última entrada e a troca passa a ser permitida (só usado quando a pessoa pediu pelo ícone).
    """
    u = _user32()
    k32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    front = u.GetForegroundWindow()
    mine = k32.GetCurrentThreadId()
    theirs = u.GetWindowThreadProcessId(front, None) if front else 0
    attached = bool(theirs and theirs != mine and u.AttachThreadInput(mine, theirs, True))
    try:
        if u.SetForegroundWindow(hwnd):
            return True
    finally:
        if attached:
            u.AttachThreadInput(mine, theirs, False)
    if not nudge:
        return False
    u.mouse_event(0x0001, 0, 0, 0, 0)  # MOUSEEVENTF_MOVE sem sair do lugar
    return bool(u.SetForegroundWindow(hwnd))


def _next_window(skip: set[int]) -> int:
    """Próxima janela "normal" na ordem da tela (visível, na tela, não minimizada), fora `skip`."""
    from ctypes import wintypes as wt

    u = _user32()
    x, y, w, h = virtual_screen()
    hwnd = u.GetTopWindow(None)
    while hwnd:
        rect = wt.RECT()
        u.GetWindowRect(hwnd, ctypes.byref(rect))
        on_screen = rect.right > x and rect.bottom > y and rect.left < x + w and rect.top < y + h
        tool = u.GetWindowLongW(hwnd, -20) & 0x80  # GWL_EXSTYLE / WS_EX_TOOLWINDOW
        if (
            hwnd not in skip
            and u.IsWindowVisible(hwnd)
            and not u.IsIconic(hwnd)
            and not tool
            and on_screen
            and rect.right - rect.left > 50
            and u.GetWindowTextLengthW(hwnd) > 0
        ):
            return hwnd
        hwnd = u.GetWindow(hwnd, 2)  # GW_HWNDNEXT
    return 0


def give_back_focus(previous: int = 0) -> bool:
    """O Chrome escondido está com o foco: devolve para `previous` (ou para a próxima janela na tela)."""
    if sys.platform != "win32":
        return False
    try:
        ours = set(own_windows())
        if foreground_window() not in ours:
            return False
        target = previous if previous and previous not in ours and _user32().IsWindow(previous) else _next_window(ours)
        return bool(target) and _set_foreground(target)
    except Exception as exc:  # noqa: BLE001 - conforto, nunca derruba o job
        log.debug("Não foi possível devolver o foco: %s", exc)
        return False


def last_input_age() -> float:
    """Segundos desde o último clique/tecla da pessoa (em qualquer programa)."""
    if sys.platform != "win32":
        return float("inf")

    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not _user32().GetLastInputInfo(ctypes.byref(info)):
        return float("inf")
    now = ctypes.windll.kernel32.GetTickCount() & 0xFFFFFFFF  # type: ignore[attr-defined]
    return ((now - info.dwTime) & 0xFFFFFFFF) / 1000


# barra de tarefas e as miniaturas que ela mostra ao passar o mouse (Windows 10 e 11)
_TASKBAR_CLASSES = {
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "TaskListThumbnailWnd",
    "XamlExplorerHostIslandWindow",
}


def cursor_on_taskbar() -> bool:
    """O mouse está sobre a barra de tarefas (ou a miniatura de uma janela nela)?"""
    if sys.platform != "win32":
        return False
    from ctypes import wintypes as wt

    u = _user32()
    point = wt.POINT()
    if not u.GetCursorPos(ctypes.byref(point)):
        return False
    u.WindowFromPoint.argtypes = [wt.POINT]
    u.WindowFromPoint.restype = wt.HWND
    hwnd = u.WindowFromPoint(point)
    root = u.GetAncestor(hwnd, 2) if hwnd else 0  # GA_ROOT
    name = ctypes.create_unicode_buffer(64)
    u.GetClassNameW(root, name, 64)
    return name.value in _TASKBAR_CLASSES


def bring_own_window_to_front() -> bool:
    if sys.platform != "win32":
        return False
    try:
        windows = own_windows()
        return bool(windows) and _set_foreground(windows[0], nudge=True)
    except Exception as exc:  # noqa: BLE001
        log.debug("Não foi possível trazer o navegador para a frente: %s", exc)
        return False


# -- navegadores abertos por este worker -------------------------------------------------
class RobotWindows:
    """Contextos do Playwright abertos escondidos neste processo e o estado para o ícone."""

    FOCUS_WATCH = (0, 0.5, 1, 1.5, 2)  # pausas do vigia logo após abrir (s)

    def __init__(self) -> None:
        self._contexts: list["BrowserContext"] = []
        self.shown = False
        self._shown_for: Literal["user", "intervention"] | None = None
        self._focus_task: asyncio.Future | None = None
        self._front_was_ours = False
        self._robot_activated_at = float("-inf")  # última vez que o próprio robô trouxe uma aba para a frente
        self._last_other = 0  # última janela da pessoa que esteve na frente (para devolver o foco)

    @property
    def state(self) -> WindowState:
        if not self._contexts:
            return "none"
        return "shown" if self.shown else "hidden"

    async def register(self, context: "BrowserContext", *, previous_foreground: int = 0) -> None:
        self._contexts.append(context)
        context.on("page", self._on_new_page)
        await self._move_all(context, visible=self.shown)
        self._watch_focus(previous_foreground)

    def _watch_focus(self, previous: int) -> None:
        """O Chrome às vezes pega o foco um pouco depois de abrir: confere por alguns segundos."""

        async def watch() -> None:
            for delay in self.FOCUS_WATCH:
                await asyncio.sleep(delay)
                if not self.shown and self._contexts:
                    give_back_focus(previous)

        self._focus_task = asyncio.ensure_future(watch())

    def unregister(self, context: "BrowserContext") -> None:
        if context in self._contexts:
            self._contexts.remove(context)
        if not self._contexts:
            self.shown = False
            self._shown_for = None
            if self._focus_task is not None:
                self._focus_task.cancel()
                self._focus_task = None

    async def _on_new_page(self, page: "Page") -> None:
        """Pop-up (window.open com tamanho) nasce numa janela nova na tela: esconde junto."""
        if not self.shown:
            await self._move(page, visible=False)

    @staticmethod
    async def _move(page: "Page", *, visible: bool, done: set[int] | None = None) -> int | None:
        """Move a janela da aba (uma vez por janela: várias abas podem estar na mesma)."""
        try:
            cdp = await page.context.new_cdp_session(page)
            try:
                win = await cdp.send("Browser.getWindowForTarget")
                if done is not None and win["windowId"] in done:
                    return None
                if win["bounds"].get("windowState", "normal") != "normal":
                    await cdp.send("Browser.setWindowBounds", {"windowId": win["windowId"], "bounds": {"windowState": "normal"}})
                left, top = SHOW_AT if visible else offscreen_origin()
                await cdp.send("Browser.setWindowBounds", {"windowId": win["windowId"], "bounds": {"left": left, "top": top}})
                return int(win["windowId"])
            finally:
                await cdp.detach()
        except Exception as exc:  # noqa: BLE001 - página fechando/navegando: tenta nas próximas
            log.debug("Não foi possível mover a janela do navegador: %s", exc)
            return None

    async def _move_all(self, context: "BrowserContext", *, visible: bool) -> None:
        done: set[int] = set()
        for page in list(context.pages):
            if page.is_closed():
                continue
            window_id = await self._move(page, visible=visible, done=done)
            if window_id is not None:
                done.add(window_id)

    async def show(self, *, reason: Literal["user", "intervention"] = "user") -> bool:
        if not self._contexts:
            return False
        self.shown = True
        if reason == "user" or self._shown_for is None:
            self._shown_for = reason
        for context in list(self._contexts):
            await self._move_all(context, visible=True)
            pages = [p for p in context.pages if not p.is_closed()]
            if pages and reason == "user":
                try:
                    await pages[-1].bring_to_front()
                except Exception:  # noqa: BLE001
                    pass
        if reason == "user":
            bring_own_window_to_front()
        return True

    async def hide(self) -> bool:
        if not self._contexts:
            return False
        self.shown = False
        self._shown_for = None
        for context in list(self._contexts):
            await self._move_all(context, visible=False)
        give_back_focus()  # estava na frente: o foco vai para a próxima janela da pessoa
        self._front_was_ours = foreground_window() in own_windows()
        return True

    def robot_activated(self, previous: int) -> None:
        """O robô acabou de trazer uma aba para a frente (isso ativa a janela): devolve o foco na hora."""
        self._robot_activated_at = time.monotonic()
        if self.state == "hidden":
            give_back_focus(previous)

    async def guard_focus(self) -> Literal["shown", "focus"] | None:
        """Vigia (a cada meio segundo, pelo worker) enquanto a janela está escondida.

        - Chrome escondido na frente logo depois de um clique, com o mouse sobre a barra de tarefas e
          sem o robô ter trocado de aba há pouco: foi o botão do Chrome -> a janela aparece ("shown").
          (Digitação nunca conta: o Chrome às vezes se ativa sozinho no login com certificado.)
        - Qualquer outro caso (robô trocou de aba, Chrome se ativou sozinho): devolve o foco ("focus").
        """
        if self.state != "hidden":
            self._front_was_ours = False
            return None
        front = foreground_window()
        ours = own_windows()
        if front not in ours:
            if front:
                self._last_other = front
            self._front_was_ours = False
            return None
        became = not self._front_was_ours
        self._front_was_ours = True
        robot_recent = time.monotonic() - self._robot_activated_at < 3 or (
            self._focus_task is not None and not self._focus_task.done()
        )
        if became and not robot_recent and last_input_age() < 1.5 and cursor_on_taskbar():
            return "shown" if await self.show(reason="user") else None
        if give_back_focus(self._last_other):
            self._front_was_ours = False
            return "focus"
        return None

    @asynccontextmanager
    async def shown_for_intervention(self) -> AsyncIterator[None]:
        """Robô precisa de alguém: a janela aparece; depois volta a se esconder (se foi ele que mostrou)."""
        was_hidden = self.state == "hidden"
        if was_hidden:
            await self.show(reason="intervention")
        try:
            yield
        finally:
            if was_hidden and self._shown_for == "intervention":
                await self.hide()


robot_windows = RobotWindows()


async def bring_tab_to_front(page: "Page") -> None:
    """page.bring_to_front() do robô: com a janela escondida, o foco volta na hora para a pessoa."""
    previous = foreground_window()
    await page.bring_to_front()
    robot_windows.robot_activated(previous)
