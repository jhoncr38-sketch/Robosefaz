"""Tentativa zumbi: outro computador deu este robô como desligado (sinal de vida atrasado), assumiu o trabalho
e concluiu, enquanto a tentativa antiga ainda rodava aqui. O resultado da antiga não pode escrever por cima
do novo: ela encerra sem gravar nada. Busca de NFS-e simulada, empresa fictícia."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.certificates.windows_store import StoreCertificate
from app.jobs import nfse_fetch
from app.jobs.errors import AutomationError, ErrorCode
from app.jobs.models import TaskType
from app.jobs.scheduler_runner import SchedulerRunner
from app.nfse.adn import NO_DOCUMENTS, AdnBatch
from fakes import CNPJ_OK, FakeRepo, make_certificate, make_client

THUMB = "C" * 40
OUTRO = "Outro-PC-77"


@pytest.fixture
def certificado(monkeypatch: pytest.MonkeyPatch) -> None:
    async def loader() -> list[StoreCertificate]:
        return [
            StoreCertificate(
                subject=f"CN=EMPRESA A LTDA:{CNPJ_OK}, O=ICP-Brasil", issuer="CN=AC TESTE", thumbprint=THUMB, serial_number="ABC123",
                has_private_key=True, not_before=None, not_after=datetime.now(timezone.utc) + timedelta(days=200),
            )
        ]

    monkeypatch.setattr(nfse_fetch, "list_user_certificates", loader)


class AdnComTomada:
    """Sistema nacional simulado: no meio da busca, outro robô assume o trabalho e o conclui."""

    def __init__(self, repo: FakeRepo, job_id: str, *, falha: bool = False) -> None:
        self.repo, self.job_id, self.falha = repo, job_id, falha
        self.nova_tentativa = 0

    async def fetch(self, nsu: int) -> AdnBatch:
        j = self.repo.jobs[self.job_id]
        self.nova_tentativa = j["attempts"] + 1
        j.update(
            locked_by=OUTRO, attempts=self.nova_tentativa, status="completed", current_step="completed",
            last_message="NFS-e: nenhuma nota nova.", finished_at=datetime.now(timezone.utc), error_code=None, error_message=None,
        )
        if self.falha:
            raise AutomationError(ErrorCode.NFSE_UNAVAILABLE, "A API da NFS-e Nacional não respondeu.", retryable=True)
        return AdnBatch(status=NO_DOCUMENTS, documents=[])


def _job(repo: FakeRepo):  # noqa: ANN202
    client = make_client()
    repo.add_client(client, make_certificate(client))
    return repo.add_job(client, [TaskType.NFSE_FETCH], competence="2026-09")


async def test_old_attempt_does_not_overwrite_the_new_one(repo: FakeRepo, deps, certificado: None, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
    job = _job(repo)
    adn = AdnComTomada(repo, job.id)
    monkeypatch.setattr(nfse_fetch, "AdnClient", lambda thumbprint: adn)
    assert await SchedulerRunner(deps).run_once()

    j = repo.job(job.id)
    assert (j["status"], j["locked_by"], j["attempts"], j["last_message"]) == ("completed", OUTRO, adn.nova_tentativa, "NFS-e: nenhuma nota nova.")
    assert j["error_code"] is None
    assert any("passou para outro computador" in m for m in repo.log_messages()), repo.log_messages()


async def test_old_attempt_failing_does_not_mark_the_job_failed(repo: FakeRepo, deps, certificado: None, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
    """O caso de 13/10/2026: a tentativa antiga deu erro depois que a nova já tinha concluído."""
    job = _job(repo)
    adn = AdnComTomada(repo, job.id, falha=True)
    monkeypatch.setattr(nfse_fetch, "AdnClient", lambda thumbprint: adn)
    assert await SchedulerRunner(deps).run_once()

    j = repo.job(job.id)
    assert (j["status"], j["locked_by"], j["attempts"], j["error_code"]) == ("completed", OUTRO, adn.nova_tentativa, None)
    assert any("não foi gravado" in m for m in repo.log_messages()), repo.log_messages()
    assert job.id in repo.released  # a liberação do lock é só do próprio dono: a do outro robô fica
    assert repo.job(job.id)["locked_by"] == OUTRO
