"""Seletores e textos do SIAT Web — ÚNICO lugar com conhecimento da interface.

Textos confirmados no bundle público do portal (painel-aplicacoes, Nuxt/Vuetify):
- Diálogo de certificados: "Selecione um Certificado" (Lacuna Web PKI),
  linhas no formato "subjectName - issuerName - email".
- Autorização do Web PKI: "O site ... deseja acessar seus certificados digitais" [Permitir].
- Diálogo "Selecionar Contribuinte" com colunas
  Inscrição | CPF/CNPJ | Nome/Razão Social | Situação Cadastral | Ações (ícone "selecionar").
- Painel do usuário: "Último acesso", "Login com Certificado".

Caminho real até a exportação (confirmado com o usuário em 24/09/2026):
  Painel de aplicações -> card "e-AGEAT" (siatweb.sefaz.pi.gov.br/eageat/...,
  às vezes "Error 500" ou "Usuário não identificado": fechar e clicar de novo)
  -> menu "Autorregularização" -> "SIAT"
  -> SIAT web legado (webas.sefaz.pi.gov.br/siatweb/faces/...)
  -> "Autoatendimento" -> "NFC-e" -> "Consultar/Exportar NFC-e"
                       -> "NF-e"  -> "Consultar/Exportar NF-e"
  O SIAT web legado identifica o contribuinte por "Usuário: NOME" e pela
  Inscrição Estadual (select "Inscrição" e coluna "IE" da lista); não mostra CNPJ.

Qualquer valor pode ser sobrescrito sem
alterar código em `worker/config/siat_selectors.json` (ou no arquivo
indicado por SIAT_SELECTORS_FILE). Todos os valores são expressões regulares
avaliadas sem diferenciar maiúsculas/minúsculas.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field, fields
from functools import lru_cache
from pathlib import Path

from app.config import WORKER_ROOT

DEFAULT_OVERRIDE_FILE = WORKER_ROOT / "config" / "siat_selectors.json"


@dataclass(frozen=True)
class SiatSelectors:
    # --- URLs ----------------------------------------------------------
    login_path: str = "/painel-aplicacoes/login"
    login_url_marker: str = r"/login"
    # Fluxo observado: /painel-aplicacoes/login -> Keycloak em
    # siatweb-certificado.sefaz.pi.gov.br/auth/realms/nsw-sefaz (certificado via TLS)
    # -> /painel-aplicacoes/callback -> /painel-aplicacoes/main
    auth_url_marker: str = r"siatweb-certificado\.|/auth/realms/|openid-connect|/painel-aplicacoes/callback"
    logged_in_url_marker: str = r"/painel-aplicacoes/(main|home|inicio)\b"
    # retorno do Keycloak: o certificado JÁ foi aceito quando a página chega aqui
    callback_url_marker: str = r"/painel-aplicacoes/callback"
    # domínios cujos cookies/armazenamento são limpos na recuperação do login
    siat_cookie_domain: str = r"(^|\.)sefaz\.pi\.gov\.br$"

    # --- Login com certificado -------------------------------------------
    login_certificate_option: str = r"certificado\s+digital|login\s+com\s+certificado|entrar\s+com\s+certificado"
    webpki_authorization_prompt: str = r"deseja acessar seus certificados digitais"
    certificate_dialog_title: str = r"selecione um certificado"
    certificate_expired_message: str = r"certificado expirado"
    certificate_cancelled_message: str = r"cancelamento da sele[çc][ãa]o do certificado"
    logged_in_markers: str = r"[úu]ltimo acesso|login com certificado|selecionar contribuinte|\bsair\b"
    logout_button: str = r"^\s*sair\s*$"
    captcha_markers: str = r"captcha|n[ãa]o sou um rob[ôo]|recaptcha|hcaptcha"
    two_factor_markers: str = r"c[óo]digo de verifica[çc][ãa]o|autentica[çc][ãa]o em dois fatores|token enviado"

    # --- Contribuinte ----------------------------------------------------
    taxpayer_dialog_title: str = r"selecionar contribuinte"
    taxpayer_open_button: str = r"selecionar contribuinte|trocar contribuinte|alterar contribuinte"
    taxpayer_filter_document_label: str = r"cpf\s*/\s*cnpj|cnpj"
    taxpayer_filter_ie_label: str = r"inscri[çc][ãa]o"
    taxpayer_search_button: str = r"^\s*(consultar|pesquisar|buscar)\s*$"
    taxpayer_select_action: str = r"selecionar"
    taxpayer_header_document: str = r"cpf\s*/\s*cnpj"
    current_taxpayer_container: str = "header, .v-app-bar, .v-toolbar, .v-navigation-drawer, [class*='contribuinte']"

    # --- Módulo e-AGEAT --------------------------------------------------
    module_link: str = r"e-?\s?ageat"
    # e-AGEAT às vezes abre sem sessão: "Acesso proibido / Usuário não identificado".
    # O botão "Efetuar login" leva à página pública; o contorno é fechar e clicar de novo.
    module_login_required: str = r"usu[áa]rio\s+n[ãa]o\s+identificado|acesso\s+proibido"
    # SIAT deslogado (página pública "Carta de Serviços" com botão ENTRAR)
    logged_out_markers: str = r"carta\s+de\s+servi[çc]os|aplica[çc][õo]es\s+p[úu]blicas"
    # páginas de erro do servidor (ex.: "Error 500--Internal Server Error" do e-AGEAT)
    server_error_markers: str = (
        r"error\s*500|internal\s+server\s+error|erro\s+interno|service\s+unavailable|"
        r"bad\s+gateway|gateway\s+time-?out|erro\s+50[0-4]"
    )
    eageat_menu_root: str = r"^\s*autorregulariza[çc][ãa]o\s*$"
    eageat_menu_siat: str = r"^\s*siat\s*$"

    # --- SIAT web legado (webas.sefaz.pi.gov.br/siatweb) -------------------
    legacy_url_marker: str = r"/siatweb/"
    legacy_menu_root: str = r"^\s*autoatendimento\s*$"
    legacy_menu_nfce: str = r"^\s*nfc-?e\s*$"
    legacy_menu_nfce_export: str = r"^\s*consultar\s*/\s*exportar\s+nfc-?e\s*$"
    legacy_menu_nfe: str = r"^\s*nf-?e\s*$"
    # "Consultar/Exportar NF-e" (NÃO a opção "... Detalhada")
    legacy_menu_nfe_export: str = r"^\s*consultar\s*/\s*exportar\s+nf-?e\s*$"
    legacy_user_label: str = r"usu[áa]rio\s*:\s*(.+)"
    legacy_radio_emitente: str = r"contribuinte\s+como\s+emitente"
    legacy_radio_destinatario: str = r"contribuinte\s+como\s+destinat[áa]rio"
    legacy_inscricao_label: str = r"inscri[çc][ãa]o"
    legacy_tipo_nota_saida: str = r"^\s*sa[íi]da\s*$"
    legacy_status_ativas: str = r"^\s*ativas\s*$"
    legacy_status_canceladas: str = r"^\s*canceladas\s*$"
    legacy_status_todas: str = r"^\s*todas\s*$"
    legacy_date_start_label: str = r"data\s+de\s+emiss[ãa]o\s+inicial|data\s+inicial"
    legacy_date_end_label: str = r"data\s+de\s+emiss[ãa]o\s+final|data\s+final"
    # aviso informativo ao abrir a exportação ("Comunicado Importante" [Entendi])
    legacy_notice_title: str = r"comunicado\s+importante"
    legacy_notice_button: str = r"^\s*entendi\s*$"
    legacy_schedule_button: str = r"agendar\s+exporta[çc][ãa]o"
    legacy_feedback_container: str = ".ui-messages, .ui-message, .ui-growl, [class*='messages'], [role='alert']"
    legacy_table_id_header: str = r"^\s*id\s*$"
    legacy_table_status_header: str = r"situa[çc][ãa]o"
    legacy_table_ie_header: str = r"^\s*ie\b"
    legacy_download_button: str = r"^\s*download\s*$"
    legacy_paginator_next: str = ".ui-paginator-next"

    export_success_message: str = r"agendad[oa]|agendamento\s+(realizado|efetuado|inclu[íi]do|cadastrado)|sucesso"
    export_error_message: str = r"erro|n[ãa]o\s+foi\s+poss[íi]vel|inv[áa]lid|obrigat[óo]ri"
    export_duplicate_message: str = r"j[áa]\s+existe|duplicad|j[áa]\s+agendad"
    export_protocol_regex: str = (
        r"\b(?:protocolo|solicita[çc][ãa]o|pedido|agendamento|n[úu]mero|c[óo]digo|id)\b\s*(?:n[º°o.]*)?\s*[:#-]?\s*([A-Z0-9-]{3,})"
    )

    # --- Situação dos agendamentos ------------------------------------------
    export_status_processed: str = r"processad[oa]|conclu[íi]d[oa]|dispon[íi]vel|finalizad[oa]"
    export_status_processing: str = r"aguardando|em\s+processamento|processando|pendente|agendad[oa]|na\s+fila"
    export_status_error: str = r"erro|falha|cancelad[oa]|rejeitad[oa]|expirad[oa]"

    extra: dict[str, str] = field(default_factory=dict)

    def rx(self, name: str) -> re.Pattern[str]:
        value = getattr(self, name) if hasattr(self, name) else self.extra[name]
        if isinstance(value, (tuple, list)):
            raise TypeError(f"{name} é uma lista; use rx_list()")
        return re.compile(value, re.IGNORECASE)

    def rx_list(self, name: str) -> list[re.Pattern[str]]:
        value = getattr(self, name) if hasattr(self, name) else self.extra[name]
        if isinstance(value, str):
            value = [value]
        return [re.compile(v, re.IGNORECASE) for v in value]


def _load_overrides(path: Path) -> dict:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: esperado objeto JSON")
    return data


def build_selectors(overrides: dict | None = None) -> SiatSelectors:
    overrides = dict(overrides or {})
    known = {f.name for f in fields(SiatSelectors)}
    kwargs: dict = {}
    extra: dict[str, str] = {}
    for key, value in overrides.items():
        if key.startswith("_"):
            continue  # comentários no JSON
        if key in known and key != "extra":
            if isinstance(value, list):
                value = tuple(value)
            kwargs[key] = value
        else:
            extra[key] = value
    for key, value in list(kwargs.items()):
        for pattern in value if isinstance(value, tuple) else (value,):
            # caminhos e seletores CSS não são regex
            if key.endswith(("_path", "_container")) or key == "legacy_paginator_next":
                continue
            try:
                re.compile(pattern)
            except re.error as exc:
                raise ValueError(f"Seletor {key} com regex inválida: {exc}") from exc
    return SiatSelectors(**kwargs, extra=extra)


@lru_cache
def get_selectors() -> SiatSelectors:
    path = Path(os.environ.get("SIAT_SELECTORS_FILE", str(DEFAULT_OVERRIDE_FILE)))
    return build_selectors(_load_overrides(path))
