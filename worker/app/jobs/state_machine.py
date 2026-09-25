"""Máquina de estados dos jobs de automação."""

from __future__ import annotations

from enum import StrEnum


class JobStatus(StrEnum):
    QUEUED = "queued"
    STARTING = "starting"
    OPENING_BROWSER = "opening_browser"
    OPENING_SIAT = "opening_siat"
    WAITING_CERTIFICATE = "waiting_certificate"
    AUTHENTICATING = "authenticating"
    SELECTING_TAXPAYER = "selecting_taxpayer"
    OPENING_SIAT_MODULE = "opening_siat_module"
    NAVIGATING_EXPORT = "navigating_export"
    SCHEDULING_NFCE = "scheduling_nfce"
    SCHEDULING_NFE_ISSUED = "scheduling_nfe_issued"
    SCHEDULING_NFE_RECEIVED = "scheduling_nfe_received"
    WAITING_SEFAZ = "waiting_sefaz"
    CHECKING_PROCESSING = "checking_processing"
    DOWNLOAD_AVAILABLE = "download_available"
    DOWNLOADING = "downloading"
    ORGANIZING_FILES = "organizing_files"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    MANUAL_ACTION_REQUIRED = "manual_action_required"
    CERTIFICATE_REQUIRED = "certificate_required"


TERMINAL_STATES = frozenset({JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED})

# Estados em que o navegador está (ou pode estar) aberto executando algo.
BROWSER_STATES = frozenset(
    {
        JobStatus.OPENING_BROWSER,
        JobStatus.OPENING_SIAT,
        JobStatus.WAITING_CERTIFICATE,
        JobStatus.AUTHENTICATING,
        JobStatus.SELECTING_TAXPAYER,
        JobStatus.OPENING_SIAT_MODULE,
        JobStatus.NAVIGATING_EXPORT,
        JobStatus.SCHEDULING_NFCE,
        JobStatus.SCHEDULING_NFE_ISSUED,
        JobStatus.SCHEDULING_NFE_RECEIVED,
        JobStatus.CHECKING_PROCESSING,
        JobStatus.DOWNLOAD_AVAILABLE,
        JobStatus.DOWNLOADING,
        JobStatus.ORGANIZING_FILES,
        JobStatus.MANUAL_ACTION_REQUIRED,
    }
)

ACTIVE_STATES = BROWSER_STATES | {JobStatus.STARTING}

SCHEDULING_STATES = frozenset(
    {
        JobStatus.NAVIGATING_EXPORT,
        JobStatus.SCHEDULING_NFCE,
        JobStatus.SCHEDULING_NFE_ISSUED,
        JobStatus.SCHEDULING_NFE_RECEIVED,
    }
)

COLLECT_STATES = frozenset(
    {
        JobStatus.CHECKING_PROCESSING,
        JobStatus.DOWNLOAD_AVAILABLE,
        JobStatus.DOWNLOADING,
        JobStatus.ORGANIZING_FILES,
    }
)

PROGRESS: dict[JobStatus, int] = {
    JobStatus.QUEUED: 0,
    JobStatus.STARTING: 5,
    JobStatus.OPENING_BROWSER: 20,
    JobStatus.OPENING_SIAT: 35,
    JobStatus.WAITING_CERTIFICATE: 37,
    JobStatus.AUTHENTICATING: 40,
    JobStatus.SELECTING_TAXPAYER: 43,
    JobStatus.OPENING_SIAT_MODULE: 45,
    JobStatus.NAVIGATING_EXPORT: 48,
    JobStatus.SCHEDULING_NFCE: 50,
    JobStatus.SCHEDULING_NFE_ISSUED: 60,
    JobStatus.SCHEDULING_NFE_RECEIVED: 70,
    JobStatus.WAITING_SEFAZ: 80,
    JobStatus.CHECKING_PROCESSING: 85,
    JobStatus.DOWNLOAD_AVAILABLE: 90,
    JobStatus.DOWNLOADING: 95,
    JobStatus.ORGANIZING_FILES: 98,
    JobStatus.COMPLETED: 100,
}

LABELS: dict[JobStatus, str] = {
    JobStatus.QUEUED: "Aguardando processamento",
    JobStatus.STARTING: "Iniciando",
    JobStatus.OPENING_BROWSER: "Abrindo navegador",
    JobStatus.OPENING_SIAT: "Abrindo SIAT",
    JobStatus.WAITING_CERTIFICATE: "Aguardando seleção do certificado digital",
    JobStatus.AUTHENTICATING: "Autenticando",
    JobStatus.SELECTING_TAXPAYER: "Selecionando contribuinte",
    JobStatus.OPENING_SIAT_MODULE: "Abrindo módulo do SIAT",
    JobStatus.NAVIGATING_EXPORT: "Navegando até exportação",
    JobStatus.SCHEDULING_NFCE: "Agendando NFC-e",
    JobStatus.SCHEDULING_NFE_ISSUED: "Agendando NF-e emitidas",
    JobStatus.SCHEDULING_NFE_RECEIVED: "Agendando NF-e recebidas",
    JobStatus.WAITING_SEFAZ: "Aguardando processamento SEFAZ",
    JobStatus.CHECKING_PROCESSING: "Consultando processamento",
    JobStatus.DOWNLOAD_AVAILABLE: "Download disponível",
    JobStatus.DOWNLOADING: "Baixando arquivos",
    JobStatus.ORGANIZING_FILES: "Organizando arquivos",
    JobStatus.COMPLETED: "Concluído",
    JobStatus.FAILED: "Erro",
    JobStatus.CANCELLED: "Cancelado",
    JobStatus.MANUAL_ACTION_REQUIRED: "Aguardando intervenção do usuário",
    JobStatus.CERTIFICATE_REQUIRED: "Certificado necessário",
}


class InvalidTransitionError(RuntimeError):
    def __init__(self, current: JobStatus, target: JobStatus) -> None:
        super().__init__(f"Transição inválida: {current} -> {target}")
        self.current = current
        self.target = target


def _allowed_targets(current: JobStatus) -> frozenset[JobStatus]:
    if current == JobStatus.QUEUED:
        return frozenset({JobStatus.STARTING, JobStatus.CANCELLED, JobStatus.FAILED})
    if current in TERMINAL_STATES or current == JobStatus.CERTIFICATE_REQUIRED:
        # só voltam para a fila via reprocessamento
        base = {JobStatus.QUEUED}
        if current == JobStatus.CERTIFICATE_REQUIRED:
            base.add(JobStatus.CANCELLED)
        return frozenset(base)
    if current == JobStatus.WAITING_SEFAZ:
        return frozenset({JobStatus.CHECKING_PROCESSING, JobStatus.CANCELLED, JobStatus.FAILED})
    if current == JobStatus.STARTING:
        return frozenset(
            {
                JobStatus.OPENING_BROWSER,
                JobStatus.CERTIFICATE_REQUIRED,
                JobStatus.FAILED,
                JobStatus.CANCELLED,
                JobStatus.QUEUED,
                JobStatus.WAITING_SEFAZ,  # nada novo a agendar
                JobStatus.COMPLETED,
            }
        )
    # Estados ativos: podem avançar para qualquer outro estado ativo (o
    # fluxo do Scheduler e do Collector compartilham etapas de navegador),
    # para espera da SEFAZ, para estados finais ou para a fila (retry).
    targets = set(BROWSER_STATES) | set(TERMINAL_STATES)
    targets |= {JobStatus.CERTIFICATE_REQUIRED, JobStatus.QUEUED, JobStatus.WAITING_SEFAZ}
    targets.discard(current)
    return frozenset(targets)


def can_transition(current: JobStatus | str, target: JobStatus | str) -> bool:
    c, t = JobStatus(current), JobStatus(target)
    if c == t:
        return True
    return t in _allowed_targets(c)


def ensure_transition(current: JobStatus | str, target: JobStatus | str) -> None:
    if not can_transition(current, target):
        raise InvalidTransitionError(JobStatus(current), JobStatus(target))


def progress_for(status: JobStatus | str, phase: str = "schedule") -> int:
    s = JobStatus(status)
    value = PROGRESS.get(s)
    if value is None:
        return 0
    # No Collector o navegador volta a abrir, mas o progresso não regride.
    if phase == "collect" and s in BROWSER_STATES and value < PROGRESS[JobStatus.CHECKING_PROCESSING]:
        return PROGRESS[JobStatus.CHECKING_PROCESSING]
    return value


def label_for(status: JobStatus | str) -> str:
    return LABELS.get(JobStatus(status), str(status))


class JobStateMachine:
    """Mantém o estado atual de um job validando cada transição."""

    def __init__(self, initial: JobStatus | str, phase: str = "schedule") -> None:
        self.state = JobStatus(initial)
        self.phase = phase
        self.history: list[JobStatus] = [self.state]

    def transition(self, target: JobStatus | str) -> JobStatus:
        t = JobStatus(target)
        ensure_transition(self.state, t)
        if t != self.state:
            self.state = t
            self.history.append(t)
        return self.state

    @property
    def progress(self) -> int:
        return progress_for(self.state, self.phase)

    @property
    def is_terminal(self) -> bool:
        return self.state in TERMINAL_STATES
