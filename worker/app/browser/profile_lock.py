"""Lock de perfil de navegador (impede dois processos no mesmo user_data_dir)."""

from __future__ import annotations

import json
import os
import socket
import time
from pathlib import Path

from app.jobs.errors import AutomationError, ErrorCode


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)) == 0:
                return False
            return code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


class ProfileLock:
    def __init__(self, profile_root: Path, owner: str) -> None:
        self.path = profile_root / ".siat.lock"
        self.owner = owner
        self._held = False

    def _read(self) -> dict | None:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                info = self._read() or {}
                same_host = info.get("host") == socket.gethostname()
                if same_host and not _pid_alive(int(info.get("pid", 0))):
                    self.path.unlink(missing_ok=True)
                    continue
                raise AutomationError(
                    ErrorCode.PROFILE_IN_USE,
                    f"Perfil de navegador em uso por {info.get('owner', 'outro processo')}.",
                ) from None
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(
                    {"pid": os.getpid(), "host": socket.gethostname(), "owner": self.owner, "at": time.time()}, fh
                )
            self._held = True
            return
        raise AutomationError(ErrorCode.PROFILE_IN_USE, "Não foi possível obter o lock do perfil.")

    def release(self) -> None:
        if self._held:
            self.path.unlink(missing_ok=True)
            self._held = False

    def __enter__(self) -> "ProfileLock":
        self.acquire()
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()
