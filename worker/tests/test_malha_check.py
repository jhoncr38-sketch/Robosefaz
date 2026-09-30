"""Consulta de Malhas Fiscais (tarefa MALHA_CHECK) com SIAT simulado no provider."""

from __future__ import annotations

from app.automation.siat.siat_malhas import MalhaFinding, MalhaResult, clean_text, format_brl, parse_brl, parse_rows, summary
from app.jobs.errors import ErrorCode
from app.jobs.models import TaskStatus, TaskType
from app.jobs.scheduler_runner import SchedulerRunner
from fakes import FakeProvider, FakeRepo, make_certificate, make_client

CONSULT = {"cnpj": "44752321000118", "state_registration": "197381820"}
ENTRADAS = MalhaFinding(
    source="EFD_OIE",
    identification="[EFD][NFe] Entradas Não Registradas",
    periods=1,
    icms=110.07,
    nfe_count=13,
    raw="[EFD][NFe] Entradas Não Registradas | 1 | 110,07 | 13 |",
)


def _setup(repo: FakeRepo, **client_kw):  # noqa: ANN003, ANN202
    client = make_client(**client_kw)
    repo.add_client(client, make_certificate(client))
    job = repo.add_job(client, [TaskType.MALHA_CHECK], competence="2026-09")
    return client, job


async def test_findings_are_saved_and_job_completes(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    client, job = _setup(repo, **CONSULT)
    provider.malha_result = MalhaResult("197381820", "CONSULT RL SERVICOS LTDA", [ENTRADAS], "texto da página")
    assert await SchedulerRunner(deps).run_once()

    assert "read_malhas" in provider.calls
    assert not any(c.startswith("schedule:") for c in provider.calls)  # nada é agendado
    j = repo.job(job.id)
    assert j["status"] == "completed"
    assert j["last_message"] == (
        "Malhas fiscais: 1 malha em aberto (EFD/OIE): [EFD][NFe] Entradas Não Registradas · ICMS R$ 110,07 · 13 NF-e."
    )
    check = repo.malhas[client.id]
    assert (check["total"], check["icms_total"], check["nfe_total"]) == (1, 110.07, 13)
    assert check["findings"][0]["identification"] == "[EFD][NFe] Entradas Não Registradas"
    assert check["legal_name"] == "CONSULT RL SERVICOS LTDA" and check["job_id"] == job.id
    (task,) = repo.tasks_of(job.id)
    assert task["status"] == TaskStatus.COMPLETED
    assert task["result"] == {"total": 1, "icms_total": 110.07, "nfe_total": 13, "sources": ["EFD_OIE"]}


async def test_no_findings(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    client, job = _setup(repo, **CONSULT)
    provider.malha_result = MalhaResult("197381820", "CONSULT RL SERVICOS LTDA")
    await SchedulerRunner(deps).run_once()
    assert repo.job(job.id)["last_message"] == "Malhas fiscais: nenhuma malha em aberto."
    assert repo.malhas[client.id]["total"] == 0


async def test_page_of_other_ie_is_never_saved(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    _, job = _setup(repo, **CONSULT)
    provider.malha_result = MalhaResult("123456789", "OUTRA EMPRESA", [ENTRADAS])
    await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "failed"
    assert j["error_code"] == ErrorCode.SECURITY_CLIENT_MISMATCH.value
    assert getattr(repo, "malhas", {}) == {}


def test_parse_rows_skips_headers_and_empty() -> None:
    rows = [
        [],  # linha de cabeçalho (só th)
        ["Identificação da Malha", "Qtd. Períodos", "ICMS Devido/Destacado", "Qtd. NFe", "Opções"],
        ["Nenhum registro encontrado"],
        ["[EFD][NFe] Entradas Não Registradas", "1", "110,07", "13", ""],
        ["[DIEF] Omissão de receita", "3", "R$ 1.234,56", "", ""],
        ["[PGDASD] Receita Bruta X DIMP", "5", "-", "-", "ui-button\nui-button"],  # botões lupa/ⓘ do SIAT
    ]
    found = parse_rows("EFD_OIE", rows)
    assert [(f.identification, f.periods, f.icms, f.nfe_count) for f in found] == [
        ("[EFD][NFe] Entradas Não Registradas", 1, 110.07, 13),
        ("[DIEF] Omissão de receita", 3, 1234.56, None),
        ("[PGDASD] Receita Bruta X DIMP", 5, None, None),
    ]
    assert found[2].raw == "[PGDASD] Receita Bruta X DIMP | 5 | - | - | "
    assert parse_rows("DIEF_PGDAS", [["Nenhum registro encontrado"]]) == []


def test_clean_text_drops_hidden_button_labels() -> None:
    raw = "Identificação da Malha Qtd. Períodos\n[EFD][NFe] Entradas Não Registradas 1 110,07 13 \nui-button\nui-button\n\n"
    assert clean_text(raw) == "Identificação da Malha Qtd. Períodos\n[EFD][NFe] Entradas Não Registradas 1 110,07 13"


def test_brl() -> None:
    assert parse_brl("110,07") == 110.07
    assert parse_brl("R$ 1.234,56") == 1234.56
    assert parse_brl("") is None and parse_brl("-") is None
    assert format_brl(1234.5) == "R$ 1.234,50" and format_brl(None) == "—"


def test_summary_many() -> None:
    r = MalhaResult("1", "X", [ENTRADAS, MalhaFinding("DIEF_PGDAS", "[DIEF] Omissão", 2, 50.0, None, "")])
    assert summary(r) == "Malhas fiscais: 2 malhas em aberto (DIEF/PGDAS 1, EFD/OIE 1) · ICMS R$ 160,07."
    assert r.icms_total == 160.07 and r.nfe_total == 13
