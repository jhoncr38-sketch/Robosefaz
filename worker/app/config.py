"""Configuração central do worker/API (carregada do .env)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

WORKER_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = WORKER_ROOT.parent


def _resolve(path: str | Path) -> Path:
    p = Path(path)
    if not p.is_absolute():
        p = (PROJECT_ROOT / p).resolve()
    return p


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(PROJECT_ROOT / ".env", WORKER_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Supabase
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    supabase_anon_key: str = ""

    # SIAT
    siat_base_url: str = "https://siatweb.sefaz.pi.gov.br"
    siat_login_path: str = "/painel-aplicacoes/login"
    # Servidor de autenticação (Keycloak, realm nsw-sefaz) que pede o certificado
    # via TLS (janela nativa do navegador). É para este host que a política
    # AutoSelectCertificateForUrls precisa apontar.
    siat_certificate_auth_url: str = "https://siatweb-certificado.sefaz.pi.gov.br"
    # Alvo da política AutoSelectCertificateForUrls: todos os hosts da SEFAZ-PI
    # (o e-AGEAT tem login próprio e pode pedir o certificado em outro host).
    chrome_policy_pattern: str = "https://[*.]sefaz.pi.gov.br"

    # Storage
    download_base_path: str = "./storage/downloads"
    browser_profile_base_path: str = "./storage/browser_profiles"
    error_screenshot_path: str = "./storage/errors"
    step_screenshot_path: str = "./storage/screenshots"
    secrets_file_path: str = "./storage/secrets/secrets.enc.json"

    # API
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    cors_origins: str = "http://localhost:3000"

    # Segurança
    secret_encryption_key: str = ""
    secret_backend: str = Field(default="auto", description="auto | keyring | encrypted_file")

    # Automação
    automation_headless: bool = False
    automation_dry_run: bool = True
    automation_screenshots: bool = False
    browser_channel: str = "chrome"  # chrome | msedge | chromium
    max_parallel_jobs: int = 1
    page_load_timeout: int = 60_000
    action_timeout: int = 30_000
    download_timeout: int = 120_000
    certificate_selection_timeout: int = 300_000
    manual_action_timeout: int = 900_000
    login_detection_timeout: int = 20_000

    # Fila
    worker_poll_interval: float = 5.0
    collector_poll_interval: float = 60.0
    collector_interval_minutes: int = 30
    collector_max_checks: int = 96
    stale_lock_minutes: int = 45

    # Retenção: depois de N dias da data do download, apaga os ZIPs deste computador
    # e o histórico no Supabase (downloads, jobs, tarefas, logs). 0 desliga a limpeza.
    retention_days: int = 60
    retention_debug_log_days: int = 7  # logs DEBUG (detalhe técnico) somem antes
    retention_heartbeat_days: int = 7  # registros de robôs que já foram desligados
    retention_interval_hours: float = 6.0
    retry_delays: str = "10,30,60"
    max_attempts: int = 3

    # Chrome policy (AutoSelectCertificateForUrls)
    chrome_policy_mode: str = "disabled"  # disabled | per_job
    chrome_policy_allow_write: bool = False

    profile_setup_timeout: int = 900  # segundos com o perfil aberto para configuração manual
    # e-AGEAT costuma abrir com "Error 500"; o contorno é fechar a aba e clicar de novo
    module_open_attempts: int = 7
    module_retry_delay: float = 5.0  # espera cresce: 5s, 10s, 15s...
    # status das NFC-e exportadas: ativas | canceladas | todas
    nfce_status: str = "todas"
    # NF-e (emitidas e recebidas): status ativas|canceladas|inutilizadas|denegadas|todas
    nfe_status: str = "ativas"
    # NF-e: tipo de nota todas|entrada|saida
    nfe_tipo_nota: str = "todas"

    log_level: str = "INFO"
    # log em arquivo (o robô instalado roda sem janela); rotaciona em 5 arquivos de 5 MB
    log_file_path: str = "./storage/logs/worker.log"
    # criar este arquivo pede ao worker que termine o job atual e encerre (parar-robo.bat)
    stop_flag_path: str = "./storage/parar-robo.flag"
    # estado local do robô lido pelo ícone da bandeja
    status_file_path: str = "./storage/worker-status.json"
    # endereço do painel aberto pelo ícone da bandeja
    panel_url: str = "https://robosefaz.vercel.app"

    @field_validator("browser_channel")
    @classmethod
    def _channel(cls, v: str) -> str:
        v = v.strip().lower()
        if v not in {"chrome", "msedge", "chromium"}:
            raise ValueError("BROWSER_CHANNEL deve ser chrome, msedge ou chromium")
        return v

    @field_validator("nfe_status")
    @classmethod
    def _nfe_status(cls, v: str) -> str:
        v = v.strip().lower()
        if v not in {"ativas", "canceladas", "inutilizadas", "denegadas", "todas"}:
            raise ValueError("NFE_STATUS deve ser ativas, canceladas, inutilizadas, denegadas ou todas")
        return v

    @field_validator("nfe_tipo_nota")
    @classmethod
    def _nfe_tipo_nota(cls, v: str) -> str:
        v = v.strip().lower().replace("í", "i")
        if v not in {"todas", "entrada", "saida"}:
            raise ValueError("NFE_TIPO_NOTA deve ser todas, entrada ou saida")
        return v

    @field_validator("nfce_status")
    @classmethod
    def _nfce_status(cls, v: str) -> str:
        v = v.strip().lower()
        if v not in {"ativas", "canceladas", "todas"}:
            raise ValueError("NFCE_STATUS deve ser ativas, canceladas ou todas")
        return v

    @field_validator("chrome_policy_mode")
    @classmethod
    def _policy_mode(cls, v: str) -> str:
        v = v.strip().lower()
        if v not in {"disabled", "per_job"}:
            raise ValueError("CHROME_POLICY_MODE deve ser disabled ou per_job")
        return v

    @field_validator("max_parallel_jobs")
    @classmethod
    def _parallel(cls, v: int) -> int:
        if v < 1:
            raise ValueError("MAX_PARALLEL_JOBS deve ser >= 1")
        return v

    @property
    def siat_login_url(self) -> str:
        return self.siat_base_url.rstrip("/") + self.siat_login_path

    @property
    def retry_delay_list(self) -> list[int]:
        return [int(x) for x in self.retry_delays.split(",") if x.strip()]

    @property
    def downloads_dir(self) -> Path:
        return _resolve(self.download_base_path)

    @property
    def profiles_dir(self) -> Path:
        return _resolve(self.browser_profile_base_path)

    @property
    def errors_dir(self) -> Path:
        return _resolve(self.error_screenshot_path)

    @property
    def screenshots_dir(self) -> Path:
        return _resolve(self.step_screenshot_path)

    @property
    def log_file(self) -> Path | None:
        return _resolve(self.log_file_path) if self.log_file_path.strip() else None

    @property
    def stop_flag(self) -> Path:
        return _resolve(self.stop_flag_path)

    @property
    def status_file(self) -> Path:
        return _resolve(self.status_file_path)

    @property
    def secrets_file(self) -> Path:
        return _resolve(self.secrets_file_path)

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def supabase_configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_service_role_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
