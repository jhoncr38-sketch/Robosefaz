"""Status e verificação: seções, problemas primeiro e resumo no topo."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.config import Settings
from app.tools import check_setup as cs
from app.tools.activate import format_code


class RecordingUI:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.summaries: list[tuple[str, str, str]] = []

    def summary(self, level, title, detail=""):  # noqa: ANN001
        self.summaries.append((level, title, detail))

    def section(self, title):  # noqa: ANN001
        self.calls.append(("section", title))

    def info(self, text, badge=""):  # noqa: ANN001
        self.calls.append(("info", text, badge))

    def ok(self, text, badge=""):  # noqa: ANN001
        self.calls.append(("ok", text, badge))

    def warn(self, text, badge=""):  # noqa: ANN001
        self.calls.append(("warn", text, badge))

    def fail(self, text, badge=""):  # noqa: ANN001
        self.calls.append(("fail", text, badge))

    def status(self, text):  # noqa: ANN001
        pass


class _Query:
    def __init__(self, data):  # noqa: ANN001
        self.data = data

    def select(self, *_a, **_k):
        return self

    eq = order = select

    async def execute(self):
        return SimpleNamespace(data=self.data)


class FakeSupabase:
    def __init__(self, clients, certs):  # noqa: ANN001
        self.tables = {"clients": clients, "certificates": certs}

    def table(self, name):  # noqa: ANN001
        return _Query(self.tables[name])


@pytest.fixture
def activated(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> Settings:
    s = settings.model_copy(
        update={"supabase_url": "https://x.supabase.co", "supabase_anon_key": "k", "device_email": "robo@x"}
    )
    valid = (datetime.now(timezone.utc) + timedelta(days=200)).isoformat()
    expired = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    clients = [
        {"id": "c1", "client_code": "CLI000001", "legal_name": "LIA"},
        {"id": "c2", "client_code": "CLI000002", "legal_name": "SELETO"},
        {"id": "c3", "client_code": "CLI000003", "legal_name": "BOLO"},
        {"id": "c4", "client_code": "CLI000004", "legal_name": "SEM CERT"},
    ]
    certs = [
        {"client_id": "c1", "thumbprint": "aa", "serial_number": "1", "valid_until": valid},
        {"client_id": "c2", "thumbprint": "bb", "serial_number": "2", "valid_until": valid},
        {"client_id": "c3", "thumbprint": "cc", "serial_number": "3", "valid_until": expired},
    ]

    async def fake_supabase(_s):  # noqa: ANN001
        return FakeSupabase(clients, certs)

    async def fake_store():
        return ["loja"]

    monkeypatch.setattr("app.services.supabase_client.get_supabase", fake_supabase)
    monkeypatch.setattr(cs, "list_user_certificates", fake_store)
    # só o "aa" está instalado neste Windows
    monkeypatch.setattr(
        cs,
        "find_in_store",
        lambda store, thumbprint=None, serial_number=None: SimpleNamespace(has_private_key=True) if thumbprint == "aa" else None,
    )
    monkeypatch.setattr(cs, "check_browser", lambda s, r: r.ok("Google Chrome instalado"))
    monkeypatch.setattr(cs, "check_downloads", lambda s, r: r.ok("Pasta das notas: x"))
    monkeypatch.setattr(cs, "check_task", lambda r: r.ok("Início automático com o Windows configurado"))
    monkeypatch.setattr("app.tray.read_local_status", lambda path: ("idle", False))
    monkeypatch.setattr("app.tray.read_update_status", lambda s: None)
    return s


def test_sections_problems_first_and_summary(activated: Settings) -> None:
    ui = RecordingUI()
    assert cs.run_checks(activated, ui) == 2  # vencido + não instalado
    sections = [c[1] for c in ui.calls if c[0] == "section"]
    assert sections == ["Robô", "Este computador", "Certificados dos clientes (4)"]
    certs = ui.calls[ui.calls.index(("section", "Certificados dos clientes (4)")) + 1 :]
    assert [(c[0], c[1].split()[0]) for c in certs] == [
        ("fail", "CLI000002"),
        ("fail", "CLI000003"),
        ("warn", "CLI000004"),
        ("ok", "CLI000001"),
    ]
    assert certs[0][2] == "não instalado neste Windows"
    assert certs[1][2].startswith("vencido em ")
    assert certs[3][2].startswith("válido até ")
    assert ("ok", "Robô ligado, aguardando", f"versão {cs.sys.modules['app'].__version__}") in ui.calls
    assert ("ok", "Conectado ao painel", "4 cliente(s) ativo(s)") in ui.calls
    first, last = ui.summaries[0], ui.summaries[-1]
    assert first[:2] == ("info", "Verificando…")
    assert last[0] == "fail" and last[1] == "2 problema(s) a corrigir"
    assert "1 certificado(s) ok" in last[2] and "2 com problema" in last[2] and ".pfx" in last[2]


def test_all_good_summary(activated: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cs, "find_in_store", lambda *a, **k: SimpleNamespace(has_private_key=True))
    ui = RecordingUI()
    assert cs.run_checks(activated, ui) == 1  # só o vencido
    assert ui.summaries[-1][0] == "fail"
    # sem nada vencido: tudo pronto (o aviso "sem certificado" não é problema)
    class Ontem(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ANN001
            return datetime(2000, 1, 1, tzinfo=timezone.utc)

    monkeypatch.setattr(cs, "datetime", Ontem)
    ui = RecordingUI()
    assert cs.run_checks(activated, ui) == 0
    assert ui.summaries[-1][:2] == ("warn", "Pronto, com avisos")


def test_not_activated(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cs, "check_browser", lambda s, r: None)
    monkeypatch.setattr(cs, "check_downloads", lambda s, r: None)
    monkeypatch.setattr(cs, "check_task", lambda r: None)
    monkeypatch.setattr("app.tray.read_local_status", lambda path: ("stopped", False))
    monkeypatch.setattr("app.tray.read_update_status", lambda s: None)
    ui = RecordingUI()
    assert cs.run_checks(settings, ui) == 1
    assert any(c[0] == "fail" and "não ativado" in c[1] for c in ui.calls)
    assert ui.summaries[-1][1] == "1 problema(s) a corrigir"


def test_format_code() -> None:
    assert format_code("abcd") == "ABCD"
    assert format_code("abcde") == "ABCD-E"
    assert format_code("ab cd-ef gh") == "ABCD-EFGH"
    assert format_code("ABCD-EFGHXYZ") == "ABCD-EFGH"
    assert format_code("") == ""
