"""Leitura das notificações "EPE - EFD" do DT-e (textos reais enviados pelo usuário, 27/09/2026)."""

from __future__ import annotations

from app.efd.parser import EfdSituation, latest, parse_message, parse_subject

HEAD = """Governo do Estado do Piauí
Secretaria da Fazenda do Estado do Piauí
Unidade de Tecnologia

"""

LEGEND = """
Observações:
Legenda dos tipos de Inconsistências:
Tipo 1 - Impeditiva - EFD não processada e sem validade para a SEFAZ PI.
Tipo 2 - Pendência - EFD processada, porém o contribuinte ficará em situação fiscal irregular caso a inconsistência não seja sanada em até 45 dias, contados da data do processamento da declaração. Para EFDs enviadas antes da data limite de obrigatoriedade de entrega, a contagem do prazo somente se iniciará após esta data.
Tipo 3 - Alerta - EFD processada, podendo incorrer em posterior análise a ser realizada por Auditor Fiscal.

1. As regras completas podem ser consultadas no documento "Regras de Pós-validação da EFD ICMS IPI do Estado do Piauí".
"""

PROCESSED = HEAD + """Número do EPE: 93104981381
Data Processamento: 11/09/2026 18:09:48
Tipo de Arquivo: EFD
Inscrição Estadual: 19.603.499-0
CNPJ/CPF: 28100366000151
Razão Social: C BEZERRA MARCENARIA LTDA
Período de Referência: 08/2026
Finalidade: ORIGINAL
Data Recebimento: 11/09/2026 17:19:31

Informamos que a sua declaração, transmitida através da Receita Federal e compartilhada com a Secretaria de Fazenda do Estado do Piauí FOI PROCESSADA na nossa base de dados.

""" + LEGEND

ALERT = HEAD + """Número do EPE: 93104686412
Data Processamento: 17/07/2026 15:35:32
Tipo de Arquivo: EFD
Inscrição Estadual: 19.603.499-0
CNPJ/CPF: 28100366000151
Razão Social: C BEZERRA MARCENARIA LTDA
Período de Referência: 06/2026
Finalidade: ORIGINAL
Data Recebimento: 17/07/2026 14:48:14

Informamos que a sua declaração, transmitida através da Receita Federal e compartilhada com a Secretaria de Fazenda do Estado do Piauí FOI PROCESSADA na nossa base de dados.


Inconsistência(s) - Tipo| Regra| Local | Detalhamento
Inconsistência Tipo 3 - Alerta
4.1.03 - Escrituração - Registro C100 - Malha EFD NF-e Entradas não Registradas no mês de emissão da nota - 5 ocorrência(s). Exemplo(s): 195487, 195488, 195489, 5241,
5371
""" + LEGEND

RETIFICADORA = HEAD + """Número do EPE: 93104801993
Data Processamento: 12/08/2026 15:29:39
Tipo de Arquivo: EFD
Inscrição Estadual: 19.455.823-1
CNPJ/CPF: 5731045000150
Razão Social: SETEL- SERVIÇOS TÉCNICOS DE ENGENHARIA LTDA - EPP
Período de Referência: 07/2026
Finalidade: RETIFICADORA
Data Recebimento: 12/08/2026 11:56:04

Informamos que a sua declaração, transmitida através da Receita Federal e compartilhada com a Secretaria de Fazenda do Estado do Piauí FOI PROCESSADA na nossa base de dados.

""" + LEGEND

NOT_PROCESSED = HEAD + """Número do EPE: 93104780277
Data Processamento: 10/08/2026 15:20:49
Tipo de Arquivo: EFD
Inscrição Estadual: 19.455.823-1
CNPJ/CPF: 5731045000150
Razão Social: SETEL- SERVIÇOS TÉCNICOS DE ENGENHARIA LTDA - EPP
Período de Referência: 07/2026
Finalidade: ORIGINAL
Data Recebimento: 10/08/2026 15:01:36

Informamos que a sua declaração, transmitida através da Receita Federal e compartilhada com a Secretaria de Fazenda do Estado do Piauí NÃO FOI PROCESSADA na nossa base de dados.


Inconsistência(s) - Tipo| Regra| Local | Detalhamento
Inconsistência Tipo 1 - Impeditiva
2.1.09 - Valores Apurados - O VL_SLD_CREDOR_ANT desta EFD menor do que VL_SLD_CREDOR_TRANSPORTAR da declarao anterior.
""" + LEGEND


def test_subject():
    assert parse_subject("EPE - EFD - Período 202608 - 93104981381") == ("2026-08", "93104981381")
    assert parse_subject("EPE - EFD - Periodo 202607 - 93104780277") == ("2026-07", "93104780277")
    assert parse_subject("Aviso de cobrança") is None


def test_processed_original():
    msg = parse_message(PROCESSED)
    assert msg is not None
    assert msg.epe_number == "93104981381"
    assert msg.competence == "2026-08"
    assert msg.finalidade == "ORIGINAL"
    assert msg.state_registration == "196034990"
    assert msg.cnpj == "28100366000151"
    assert msg.processed is True
    assert msg.processed_at is not None and msg.processed_at.strftime("%d/%m/%Y %H:%M:%S") == "11/09/2026 18:09:48"
    assert msg.received_at is not None and msg.received_at.hour == 17
    # a legenda ("Tipo 1 - Impeditiva ...") não é inconsistência da declaração
    assert msg.inconsistencies == []
    assert msg.situation == EfdSituation.PROCESSED


def test_processed_with_malha():
    msg = parse_message(ALERT)
    assert msg is not None and msg.processed is True
    assert len(msg.inconsistencies) == 1
    inc = msg.inconsistencies[0]
    assert (inc.type, inc.type_label, inc.rule) == (3, "Alerta", "4.1.03")
    assert inc.description.startswith("Escrituração - Registro C100 - Malha EFD NF-e Entradas")
    # linha quebrada continua na mesma inconsistência
    assert inc.description.endswith("5241, 5371")
    assert msg.situation == EfdSituation.ALERT


def test_not_processed_impeditiva():
    msg = parse_message(NOT_PROCESSED)
    assert msg is not None
    assert msg.processed is False
    assert msg.finalidade == "ORIGINAL"
    assert [i.type for i in msg.inconsistencies] == [1]
    assert msg.inconsistencies[0].rule == "2.1.09"
    assert "VL_SLD_CREDOR_ANT" in msg.inconsistencies[0].description
    assert msg.situation == EfdSituation.NOT_PROCESSED


def test_retificadora_replaces_original():
    original = parse_message(NOT_PROCESSED)
    retif = parse_message(RETIFICADORA)
    assert retif is not None and retif.finalidade == "RETIFICADORA"
    assert retif.situation == EfdSituation.PROCESSED
    # a retificadora foi processada depois: é ela que vale para 07/2026
    assert latest([original, retif]) is retif  # type: ignore[list-item]


def test_pending_type_2():
    text = ALERT.replace("Inconsistência Tipo 3 - Alerta", "Inconsistência Tipo 2 - Pendência")
    msg = parse_message(text)
    assert msg is not None and msg.situation == EfdSituation.PENDING
    assert msg.inconsistencies[0].type_label == "Pendência"


def test_not_an_efd_message():
    assert parse_message("Aviso: atualize seu cadastro.") is None
