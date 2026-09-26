"""Regras puras do SIAT: contribuinte, mensagens de agendamento, status e casamento de linhas."""

from __future__ import annotations

import pytest

from app.automation.siat.selectors import build_selectors, get_selectors
from app.automation.siat.siat_downloads import classify_status
from app.automation.siat.siat_legacy import (
    family_of,
    ie_matches,
    new_request_ids,
    parse_export_table,
    pick_inscricao_option,
)
from app.automation.siat.siat_scheduler import classify_message, extract_protocol
from app.automation.siat.siat_taxpayer import choose_taxpayer_row, parse_taxpayer_rows, validate_current_taxpayer
from app.jobs.errors import AutomationError, ErrorCode, TaxpayerMismatchError
from app.jobs.models import DocumentType, ExportStatus
from fakes import make_client

HEADERS = ["Inscrição", "CPF/CNPJ", "Nome/Razão Social", "Situação Cadastral", "Ações"]


class TestTaxpayer:
    def test_parse_and_choose(self) -> None:
        rows = [
            ["987654321", "11.444.777/0001-61", "EMPRESA B", "ATIVO", ""],
            ["123456789", "11.222.333/0001-81", "EMPRESA A", "ATIVO", ""],
        ]
        parsed = parse_taxpayer_rows(HEADERS, rows)
        assert parsed[1].document == "11222333000181" and parsed[1].state_registration == "123456789"
        assert choose_taxpayer_row(parsed, make_client()).index == 1

    def test_mismatch(self) -> None:
        parsed = parse_taxpayer_rows(HEADERS, [["1", "11.444.777/0001-61", "B", "ATIVO", ""]])
        with pytest.raises(TaxpayerMismatchError) as e:
            choose_taxpayer_row(parsed, make_client())
        assert e.value.code == ErrorCode.TAXPAYER_MISMATCH

    def test_same_cnpj_disambiguated_by_ie(self) -> None:
        rows = [["111", "11222333000181", "A", "ATIVO", ""], ["123456789", "11222333000181", "A", "ATIVO", ""]]
        parsed = parse_taxpayer_rows(HEADERS, rows)
        assert choose_taxpayer_row(parsed, make_client()).index == 1
        with pytest.raises(AutomationError):
            choose_taxpayer_row(parsed, make_client(state_registration=None))

    def test_security_guard(self) -> None:
        client = make_client()
        validate_current_taxpayer(["11444777000161", "11222333000181"], client, security=True)
        with pytest.raises(TaxpayerMismatchError) as e:
            validate_current_taxpayer(["11444777000161"], client, security=True)
        assert e.value.code == ErrorCode.SECURITY_CLIENT_MISMATCH
        with pytest.raises(TaxpayerMismatchError):
            validate_current_taxpayer([], client, security=True)  # não identificado = bloqueia


class TestSchedulingMessages:
    @pytest.mark.parametrize(
        ("text", "kind"),
        [
            ("Exportação agendada com sucesso. Protocolo: 2026000123", "success"),
            ("Já existe um agendamento para este período", "duplicate"),
            ("Erro: data inicial inválida", "error"),
            ("Agendamento realizado com sucesso!", "success"),
            ("Agendamento excluído com sucesso!", "success"),
            ("Erro: preencha os campos obrigatórios.", "error"),
            ("", "unknown"),
            ("Bem-vindo", "unknown"),
        ],
    )
    def test_classify(self, text: str, kind: str) -> None:
        assert classify_message(text) == kind

    def test_extract_protocol(self) -> None:
        assert extract_protocol("Agendado. Protocolo: 2026000123") == "2026000123"
        assert extract_protocol("Solicitação nº 998877 registrada") == "998877"
        assert extract_protocol("Agendado com sucesso") is None
        assert extract_protocol("") is None
        dup = "Já existe um agendamento com os parâmetros passados. Tente com novos ou busque o ID: 9240745"
        assert classify_message(dup) == "duplicate"
        assert extract_protocol(dup) == "9240745"
        assert extract_protocol("Agendamento com sucesso. Protocolo: 123456") == "123456"


class TestLegacyExportList:
    """Lista real do SIAT web: ID | Situação | Data de criação | CNPJ | IE | Data processamento | Ações."""

    HEADERS = ["ID", "Situação", "Data de criação", "CNPJ\nSelecione...", "IE\nSelecione...", "Data processamento", "Ações"]
    ROWS = [
        ["9237944", "Processado", "09/09/2026 11:39:43", "", "19662259-0", "09/09/2026 11:40:01", "Info Download Excluir"],
        ["9237940", "Aguardando processamento", "09/09/2026 11:39:37", "", "19662259-0", "", "Info Excluir"],
        ["Nenhum registro encontrado", "", "", "", "", "", ""],
    ]

    @pytest.mark.parametrize(
        ("text", "status"),
        [
            ("Processado", ExportStatus.PROCESSED),
            ("Disponível para download", ExportStatus.PROCESSED),
            ("Aguardando processamento", ExportStatus.PROCESSING),
            ("Em processamento", ExportStatus.PROCESSING),
            ("Processado com erro", ExportStatus.ERROR),
            ("Cancelado", ExportStatus.ERROR),
            ("???", ExportStatus.PENDING),
        ],
    )
    def test_classify_status(self, text: str, status: ExportStatus) -> None:
        assert classify_status(text) == status

    def test_parse_real_table(self) -> None:
        rows = parse_export_table(self.HEADERS, self.ROWS)
        assert [r.request_id for r in rows] == ["9237944", "9237940"]  # ignora "Nenhum registro"
        assert rows[0].situacao == "Processado" and rows[0].ie == "196622590"
        assert rows[1].index == 1

    def test_ie_comparison(self) -> None:
        assert ie_matches("19662259-0", "196622590")
        assert ie_matches("019.662.259-0", "196622590")
        assert not ie_matches("19662259-1", "196622590")
        assert not ie_matches("", "")

    def test_new_ids_after_scheduling(self) -> None:
        before = {"9237944", "9237940"}
        after = parse_export_table(self.HEADERS, [["9237950", "Aguardando", "", "", "19662259-0", "", ""], *self.ROWS])
        assert new_request_ids(before, after, "196622590") == ["9237950"]
        assert new_request_ids(before, after, "999999999") == []  # IE de outro contribuinte não conta

    def test_pick_inscricao(self) -> None:
        assert pick_inscricao_option(["Selecione", "196622590", "987654321"], "196622590") == "196622590"
        assert pick_inscricao_option(["Selecione", "987654321"], "196622590") is None

    def test_family(self) -> None:
        assert family_of(DocumentType.NFCE) == "nfce"
        assert family_of(DocumentType.NFE_EMITIDAS) == family_of(DocumentType.NFE_RECEBIDAS) == "nfe"

    def test_real_menu_texts(self) -> None:
        sel = get_selectors()
        assert sel.rx("eageat_menu_root").search("Autorregularização")
        assert sel.rx("eageat_menu_siat").search(" SIAT ") and not sel.rx("eageat_menu_siat").search("SISAT")
        assert not sel.rx("eageat_menu_siat").search("SIAT WEB")
        assert sel.rx("legacy_menu_nfce_export").search("Consultar/Exportar NFC-e")
        assert sel.rx("legacy_menu_nfe_export").search("Consultar/Exportar NF-e")
        assert not sel.rx("legacy_menu_nfe_export").search("Consultar/Exportar NF-e Detalhada")
        assert sel.rx("legacy_schedule_button").search("Agendar exportação")
        m = sel.rx("legacy_user_label").search("Usuário: ALESSANDRO DE ARAUJO BARBOSA")
        assert m and m.group(1) == "ALESSANDRO DE ARAUJO BARBOSA"


class TestSelectors:
    def test_defaults_compile(self) -> None:
        sel = get_selectors()
        assert sel.rx("certificate_dialog_title").search("Selecione um Certificado")
        assert sel.rx("taxpayer_dialog_title").search(" Selecionar Contribuinte")
        assert sel.rx("webpki_authorization_prompt").search(
            "O site siatweb.sefaz.pi.gov.br deseja acessar seus certificados digitais."
        )
        assert sel.rx("login_certificate_option").search("Certificado Digital")

    def test_overrides(self) -> None:
        sel = build_selectors(
            {"_comentario": "x", "legacy_menu_root": "^Autoatendimento Novo$", "menu_extra": ["a", "b"], "novo": "y"}
        )
        assert sel.rx("legacy_menu_root").search("Autoatendimento Novo")
        assert [p.pattern for p in sel.rx_list("menu_extra")] == ["a", "b"]
        assert sel.rx("novo").pattern == "y"

    def test_invalid_regex_rejected(self) -> None:
        with pytest.raises(ValueError):
            build_selectors({"module_link": "([unclosed"})


def test_protocol_word_boundaries() -> None:
    assert extract_protocol("Protocolo: 555") == "555"
    assert extract_protocol("Data válida 2026 agendada") is None


def test_login_url_markers_follow_real_flow() -> None:
    sel = get_selectors()
    auth = "https://siatweb-certificado.sefaz.pi.gov.br/auth/realms/nsw-sefaz/protocol/openid-connect/auth?x=1"
    assert sel.rx("auth_url_marker").search(auth)
    assert sel.rx("auth_url_marker").search("https://siatweb.sefaz.pi.gov.br/painel-aplicacoes/callback?code=1")
    main = "https://siatweb.sefaz.pi.gov.br/painel-aplicacoes/main"
    assert sel.rx("logged_in_url_marker").search(main)
    assert not sel.rx("auth_url_marker").search(main)
    assert not sel.rx("login_url_marker").search(main)


def test_server_error_markers() -> None:
    rx = get_selectors().rx("server_error_markers")
    assert rx.search("Error 500--Internal Server Error")
    assert rx.search("503 Service Unavailable")
    assert not rx.search("Exportação de Documentos Fiscais")


class TestRecoverRequestId:
    HEADERS = ["ID", "Situação", "Data de criação", "Data processamento", "CNPJ", "IE", "Ações"]

    def _rows(self, *rows: tuple[str, str, str]) -> list:
        return parse_export_table(self.HEADERS, [[i, "Processado", created, "", "", ie, ""] for i, created, ie in rows])

    def test_recovers_unique_candidate(self) -> None:
        from datetime import datetime, timezone

        from app.automation.siat.siat_legacy import recover_request_id

        clicked = datetime(2026, 9, 25, 9, 54, 20, tzinfo=timezone.utc)  # 06:54:20 no horário do SIAT (UTC-3)
        rows = self._rows(
            ("9316160", "25/09/2026 06:54:21", "19662259-0"),  # o pedido certo
            ("9237944", "09/09/2026 11:39:43", "19662259-0"),  # antigo
            ("9316199", "25/09/2026 06:54:30", "98765432-1"),  # outra IE
        )
        assert recover_request_id(rows, "196622590", clicked, set()) == "9316160"
        assert recover_request_id(rows, "196622590", clicked, {"9316160"}) is None  # já usado por outra tarefa

    def test_ambiguous_returns_none(self) -> None:
        from datetime import datetime, timezone

        from app.automation.siat.siat_legacy import recover_request_id

        clicked = datetime(2026, 9, 25, 9, 54, 20, tzinfo=timezone.utc)
        rows = self._rows(("1111111", "25/09/2026 06:54:21", "196622590"), ("2222222", "25/09/2026 06:55:00", "196622590"))
        assert recover_request_id(rows, "196622590", clicked, set()) is None  # nunca adivinha

    def test_parse_siat_datetime(self) -> None:
        from app.automation.siat.siat_legacy import parse_siat_datetime

        dt = parse_siat_datetime("09/09/2026 11:39:43")
        assert dt is not None and dt.utcoffset().total_seconds() == -3 * 3600
        assert parse_siat_datetime("") is None
