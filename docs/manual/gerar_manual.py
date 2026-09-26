"""Gera docs/manual/Manual-SIAT-Robo.pdf (manual do usuário).

    python -m pip install reportlab pillow
    python docs/manual/gerar_manual.py

Usa as fontes Segoe UI do Windows e desenha os ícones do robô com o mesmo
código do ícone da bandeja (worker/app/tray_icons.py).
"""

from __future__ import annotations

import io
import sys
from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Image,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))
from app import __version__  # noqa: E402
from app.tray_icons import draw  # noqa: E402

OUT = Path(__file__).with_name("Manual-SIAT-Robo.pdf")
PANEL_URL = "https://jrsistema.com"
RELEASES_URL = "https://github.com/jhoncr38-sketch/siat-robo-releases/releases/latest"

# --- fontes e cores -------------------------------------------------------------
FONTS = Path("C:/Windows/Fonts")
pdfmetrics.registerFont(TTFont("Segoe", str(FONTS / "segoeui.ttf")))
pdfmetrics.registerFont(TTFont("Segoe-Bold", str(FONTS / "segoeuib.ttf")))
pdfmetrics.registerFont(TTFont("Mono", str(FONTS / "consola.ttf")))
pdfmetrics.registerFontFamily("Segoe", normal="Segoe", bold="Segoe-Bold", italic="Segoe", boldItalic="Segoe-Bold")

BRAND = colors.HexColor("#0F766E")
BRAND_LIGHT = colors.HexColor("#E6F4F2")
INK = colors.HexColor("#1F2937")
MUTED = colors.HexColor("#6B7280")
LINE = colors.HexColor("#D1D5DB")
TIP_BG, TIP_BORDER = colors.HexColor("#EFF6FF"), colors.HexColor("#2563EB")
WARN_BG, WARN_BORDER = colors.HexColor("#FFF7ED"), colors.HexColor("#EA580C")

S = {
    "body": ParagraphStyle("body", fontName="Segoe", fontSize=10, leading=14.5, textColor=INK, spaceAfter=6),
    "h1": ParagraphStyle("h1", fontName="Segoe-Bold", fontSize=19, leading=24, textColor=BRAND, spaceBefore=4, spaceAfter=10),
    "h2": ParagraphStyle("h2", fontName="Segoe-Bold", fontSize=13, leading=17, textColor=INK, spaceBefore=12, spaceAfter=6),
    "small": ParagraphStyle("small", fontName="Segoe", fontSize=8.5, leading=12, textColor=MUTED),
    "cell": ParagraphStyle("cell", fontName="Segoe", fontSize=9, leading=12.5, textColor=INK),
    "cellb": ParagraphStyle("cellb", fontName="Segoe-Bold", fontSize=9, leading=12.5, textColor=colors.white),
    "bullet": ParagraphStyle("bullet", fontName="Segoe", fontSize=10, leading=14.5, textColor=INK, leftIndent=14, bulletIndent=3, spaceAfter=3),
    "box": ParagraphStyle("box", fontName="Segoe", fontSize=9.5, leading=13.5, textColor=INK),
    "toc1": ParagraphStyle("toc1", fontName="Segoe", fontSize=10.5, leading=17, textColor=INK, leftIndent=6),
}


# --- blocos de conteúdo ------------------------------------------------------------
def code(text: str) -> str:
    return f'<font face="Mono" size="9">{text}</font>'


def P(text: str) -> Paragraph:
    return Paragraph(text, S["body"])


def H1(text: str) -> Paragraph:
    p = Paragraph(text, S["h1"])
    p.toc_level = 0
    return p


def H2(text: str) -> Paragraph:
    return Paragraph(text, S["h2"])


def bullets(items: list[str]) -> list[Paragraph]:
    return [Paragraph(i, S["bullet"], bulletText="•") for i in items]


def steps(items: list[str]) -> list[Paragraph]:
    return [Paragraph(i, S["bullet"], bulletText=f"{n}.") for n, i in enumerate(items, 1)]


def _box(title: str, text: str, bg, border) -> Table:
    t = Table([[Paragraph(f"<b>{title}</b> {text}", S["box"])]], colWidths=[170 * mm])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), bg),
                ("LINEBEFORE", (0, 0), (0, -1), 3, border),
                ("LEFTPADDING", (0, 0), (-1, -1), 9),
                ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    return t


def tip(text: str) -> list:
    return [Spacer(1, 3), _box("Dica:", text, TIP_BG, TIP_BORDER), Spacer(1, 6)]


def warn(text: str) -> list:
    return [Spacer(1, 3), _box("Atenção:", text, WARN_BG, WARN_BORDER), Spacer(1, 6)]


def table(rows: list[list[str]], widths: list[float]) -> Table:
    data = [[Paragraph(c, S["cellb"]) for c in rows[0]]] + [[Paragraph(c, S["cell"]) for c in r] for r in rows[1:]]
    t = Table(data, colWidths=[w * mm for w in widths], repeatRows=1, spaceAfter=8)
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), BRAND),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F9FAFB")]),
                ("GRID", (0, 0), (-1, -1), 0.4, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    return t


def icon(state: str, size_mm: float = 9) -> Image:
    buf = io.BytesIO()
    draw(state, 128).save(buf, format="PNG")
    buf.seek(0)
    return Image(buf, width=size_mm * mm, height=size_mm * mm)


# --- documento ------------------------------------------------------------------------
class ManualDoc(BaseDocTemplate):
    def __init__(self, path: Path) -> None:
        super().__init__(
            str(path),
            pagesize=A4,
            leftMargin=20 * mm,
            rightMargin=20 * mm,
            topMargin=22 * mm,
            bottomMargin=20 * mm,
            title="SIAT Robô - Manual do usuário",
            author="SIAT Automação",
            subject="Instalação e uso do SIAT Robô",
        )
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="f")
        self.addPageTemplates(
            [
                PageTemplate(id="capa", frames=[frame], onPage=self._cover),
                PageTemplate(id="normal", frames=[frame], onPage=self._page),
            ]
        )

    def afterFlowable(self, flowable) -> None:  # noqa: ANN001, N802
        if getattr(flowable, "toc_level", None) == 0:
            text = flowable.getPlainText()
            key = f"h{self.seq.nextf('h1')}"
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(text, key, level=0)
            self.notify("TOCEntry", (0, text, self.page, key))

    def _cover(self, canv, doc) -> None:  # noqa: ANN001
        w, h = A4
        canv.saveState()
        canv.setFillColor(BRAND)
        canv.rect(0, h - 120 * mm, w, 120 * mm, fill=1, stroke=0)
        canv.restoreState()

    def _page(self, canv, doc) -> None:  # noqa: ANN001
        w, h = A4
        canv.saveState()
        canv.setStrokeColor(LINE)
        canv.setLineWidth(0.5)
        canv.line(20 * mm, h - 14 * mm, w - 20 * mm, h - 14 * mm)
        canv.setFont("Segoe", 8)
        canv.setFillColor(MUTED)
        canv.drawString(20 * mm, h - 11.5 * mm, "SIAT Robô · Manual do usuário")
        canv.drawRightString(w - 20 * mm, h - 11.5 * mm, f"Versão {__version__}")
        canv.drawRightString(w - 20 * mm, 11 * mm, f"Página {doc.page}")
        canv.restoreState()


def cover() -> list:
    white_title = ParagraphStyle("ct", fontName="Segoe-Bold", fontSize=34, leading=40, textColor=colors.white)
    white_sub = ParagraphStyle("cs", fontName="Segoe", fontSize=14, leading=20, textColor=colors.HexColor("#D1FAE5"))
    info = ParagraphStyle("ci", fontName="Segoe", fontSize=11, leading=17, textColor=INK)
    return [
        Spacer(1, 18 * mm),
        icon("brand", 26),
        Spacer(1, 8 * mm),
        Paragraph("SIAT Robô", white_title),
        Paragraph("Manual do usuário", white_sub),
        Spacer(1, 3 * mm),
        Paragraph("Da instalação às ferramentas do dia a dia", white_sub),
        Spacer(1, 62 * mm),
        Paragraph(
            "Agendamento e download automáticos das exportações de <b>NFC-e</b>, <b>NF-e emitidas</b> e "
            "<b>NF-e recebidas</b> do SIAT Web (SEFAZ-PI), para vários clientes, com o certificado digital "
            "de cada empresa.",
            info,
        ),
        Spacer(1, 10 * mm),
        Paragraph(f"Versão do robô: <b>{__version__}</b>", info),
        Paragraph(f"Atualizado em: <b>{date.today():%d/%m/%Y}</b>", info),
        Paragraph(f"Painel: <b>{PANEL_URL}</b>", info),
        NextPageTemplate("normal"),
        PageBreak(),
    ]


def toc() -> list:
    t = TableOfContents()
    t.levelStyles = [S["toc1"]]
    t.dotsMinLevel = 0
    return [Paragraph("Sumário", S["h1"]), Spacer(1, 4), t, PageBreak()]


# --- capítulos ------------------------------------------------------------------------
def cap_visao_geral() -> list:
    return [
        H1("1. O que é o SIAT Robô"),
        P(
            "O SIAT Robô faz sozinho o trabalho repetitivo de entrar no SIAT Web com o certificado de cada "
            "cliente, pedir a exportação das notas de uma competência e, quando a SEFAZ libera, baixar os "
            "arquivos ZIP e organizá-los em pastas por empresa."
        ),
        H2("As duas partes do sistema"),
        table(
            [
                ["Parte", "Onde fica", "Para que serve"],
                [
                    "<b>Painel</b> (site)",
                    f"Na internet: {PANEL_URL}",
                    "Cadastrar clientes e certificados, pedir agendamentos, acompanhar a fila, ver histórico, "
                    "erros e downloads. Funciona em qualquer computador ou celular.",
                ],
                [
                    "<b>Robô</b>",
                    "Instalado em um ou mais computadores Windows do escritório",
                    "Abre o Chrome com o certificado do cliente, entra no SIAT, agenda as exportações e baixa "
                    "os ZIPs. Precisa dos certificados A1 instalados naquele computador.",
                ],
            ],
            [30, 50, 90],
        ),
        Spacer(1, 6),
        H2("O caminho de uma competência"),
        *steps(
            [
                "Você escolhe a competência e os clientes no painel (tela <b>Automação</b>).",
                "O robô entra no SIAT com o certificado de cada cliente e agenda NFC-e, NF-e emitidas e NF-e "
                "recebidas. O SIAT responde: <i>“download disponível em até 1 dia útil”</i>.",
                "O robô volta ao SIAT a cada 30 minutos para ver se os arquivos ficaram prontos.",
                "Quando ficam prontos, ele baixa os ZIPs e guarda em pastas com o nome da empresa.",
                "O painel mostra tudo em tempo real, e o ícone ao lado do relógio avisa quando as notas chegam.",
            ]
        ),
        *tip(
            "O robô só trabalha no que você pede no painel. Com tudo concluído, ele fica ligado, mas parado, "
            "sem abrir o Chrome nem acessar o SIAT."
        ),
    ]


def cap_requisitos() -> list:
    return [
        H1("2. Antes de começar"),
        H2("O que você precisa ter"),
        table(
            [
                ["Item", "Detalhes"],
                ["Computador", "Windows 10 ou 11, 64 bits, com internet. Pode ser um computador de uso normal."],
                [
                    "Usuário do Windows",
                    "Precisa ser <b>administrador</b>. O robô usa essa permissão para fazer o Chrome escolher "
                    "o certificado de cada cliente sozinho.",
                ],
                ["Google Chrome", "Instalado. O instalador tenta instalar se faltar."],
                [
                    "Certificados A1",
                    "O arquivo <b>.pfx</b> (ou .p12) e a senha de cada cliente. Certificado A3 (cartão/token) "
                    "exige seleção manual.",
                ],
                [
                    "Código de ativação",
                    "Gerado no painel, em <b>Computadores → Adicionar computador</b>. Tem 8 caracteres "
                    "(ex.: ABCD-EFGH), vale por 30 minutos e só pode ser usado uma vez.",
                ],
                ["Inscrição Estadual", "De cada cliente. O SIAT web identifica o contribuinte pela IE."],
            ],
            [42, 128],
        ),
        H2("Como o computador se conecta"),
        P(
            "Cada computador é <b>ativado</b> com um código gerado pelo administrador do escritório. Depois da "
            "ativação, o robô daquele computador só enxerga os dados do próprio escritório, e o computador pode "
            "ser desativado a qualquer momento na tela <b>Computadores</b>. Nenhuma chave do sistema fica "
            "guardada no computador: o acesso é exclusivo dele e fica no cofre do Windows."
        ),
    ]


def cap_instalacao() -> list:
    return [
        H1("3. Instalação do robô"),
        H2("Passo 1: instalar os certificados dos clientes"),
        *steps(
            [
                "Dê dois cliques no arquivo <b>.pfx</b> do cliente.",
                "Escolha <b>Usuário Atual</b> e clique em Avançar.",
                "Digite a senha do certificado e conclua o assistente.",
                "Repita para cada cliente, sempre com o <b>mesmo usuário do Windows</b> que vai rodar o robô.",
            ]
        ),
        H2("Passo 2: baixar e executar o instalador"),
        *steps(
            [
                f"Baixe o <b>Instalar-SIAT-Robo-{__version__}.exe</b> em {RELEASES_URL}",
                "Dê dois cliques no arquivo. Se aparecer <b>“O Windows protegeu o computador”</b>, clique em "
                "<b>Mais informações → Executar assim mesmo</b>. O aviso aparece porque o instalador ainda "
                "não tem assinatura digital paga.",
                "Clique em <b>Sim</b> no pedido de permissão de administrador.",
            ]
        ),
        H2("Passo 3: as telas do assistente"),
        table(
            [
                ["Tela", "O que fazer"],
                ["Boas-vindas", "Avançar."],
                ["Pasta de instalação", "Deixe o padrão " + code("C:\\SIAT-Robo") + "."],
                [
                    "Ativar este computador",
                    "Digite o <b>código de ativação</b> gerado no painel (Computadores → Adicionar "
                    "computador). Esta tela só aparece na primeira instalação.",
                ],
                [
                    "Opções",
                    "Deixe marcado <b>Impedir a suspensão na tomada</b> (recomendado) e, se quiser, o atalho do "
                    "painel na Área de Trabalho.",
                ],
                [
                    "Instalando",
                    "Copia os arquivos, instala o Python, prepara o robô e confere os certificados. Leva alguns "
                    "minutos na primeira vez.",
                ],
                ["Concluído", "O robô já fica ligado, com o ícone ao lado do relógio."],
            ],
            [42, 128],
        ),
        *tip(
            "Se algum certificado não estiver instalado, o instalador avisa no final. O relatório completo fica "
            "em " + code("C:\\SIAT-Robo\\storage\\logs\\instalacao.log") + "."
        ),
        H2("Atualizações: automáticas"),
        P(
            "O robô se atualiza sozinho quando sai uma versão nova. Ele nunca interrompe um trabalho em "
            "andamento:"
        ),
        *bullets(
            [
                "<b>Ao ligar o computador:</b> antes de pegar qualquer trabalho, o robô instala a versão nova "
                "(1 a 2 minutos) e já começa atualizado.",
                "<b>Computador ligado direto:</b> instala no primeiro momento em que o robô ficar 10 minutos "
                "parado.",
                "<b>Na hora:</b> pelo ícone ao lado do relógio, <b>Atualizar agora</b>.",
                "Antes de instalar, o robô confere o código de conferência (SHA-256) do instalador. Arquivo "
                "divergente é descartado.",
                "As chaves, as notas e as configurações são mantidas. Na tela <b>Configurações</b> do painel, "
                "cada computador aparece com a versão instalada.",
            ]
        ),
        P(
            "Também é possível atualizar à mão: baixe a versão nova no mesmo endereço e execute por cima."
        ),
        H2("Desinstalar"),
        P(
            "Configurações do Windows → Aplicativos → <b>SIAT Robô</b> → Desinstalar. As notas baixadas em "
            + code("storage\\downloads") + " <b>não são apagadas</b>."
        ),
        H2("Instalar em mais de um computador"),
        *bullets(
            [
                "Repita os passos 1 a 3 em cada computador. Cada um precisa dos certificados instalados.",
                "O computador que estiver ligado pega os agendamentos da fila. Se os dois estiverem ligados, "
                "eles dividem o trabalho, e o mesmo cliente nunca é processado por dois robôs ao mesmo tempo.",
                "Cada computador guarda as notas que <b>ele</b> baixou.",
            ]
        ),
    ]


def cap_painel_acesso() -> list:
    return [
        H1("4. Acesso ao painel e perfis"),
        P(
            f"Acesse <b>{PANEL_URL}</b> e entre com seu e-mail e senha. O primeiro usuário cadastrado vira "
            "Administrador; os demais são criados na tela <b>Usuários</b>."
        ),
        table(
            [
                ["O que pode fazer", "Administrador", "Operador", "Visualizador"],
                ["Ver dashboard, fila, histórico, downloads e erros", "Sim", "Sim", "Sim"],
                ["Criar agendamentos (Automação)", "Sim", "Sim", "Não"],
                ["Cancelar um agendamento", "Sim", "Sim", "Não"],
                ["Reprocessar um agendamento com erro", "Sim", "Não", "Não"],
                ["Forçar novo agendamento mesmo se já existir", "Sim", "Não", "Não"],
                ["Cadastrar clientes e certificados", "Sim", "Não", "Não"],
                ["Alterar configurações", "Sim", "Não", "Não"],
                ["Gerenciar usuários", "Sim", "Não", "Não"],
            ],
            [85, 30, 27, 28],
        ),
        H2("Menu do painel"),
        table(
            [
                ["Tela", "Para que serve"],
                ["Dashboard", "Visão geral: números do dia, agendamentos em andamento, erros e certificados vencendo."],
                ["Clientes", "Cadastro das empresas."],
                ["Certificados", "Certificado digital de cada cliente e sua validade."],
                ["Automação", "Pedir agendamentos de uma competência para vários clientes."],
                ["Fila", "Acompanhar em tempo real o que o robô está fazendo."],
                ["Downloads", "Notas baixadas, com o botão Abrir pasta."],
                ["Histórico", "Todas as execuções, com detalhes, logs e resultado."],
                ["Erros", "Falhas, com o motivo e o print da tela."],
                ["Usuários", "Quem acessa o painel e com qual perfil."],
                ["Computadores", "Computadores com o robô: ativar (código), ver versão e último sinal, desativar."],
                ["Escritórios", "Só para o dono da plataforma: criar, suspender e limitar escritórios."],
                ["Configurações", "Intervalo das consultas, limites e alertas."],
            ],
            [35, 135],
        ),
    ]


def cap_clientes_certificados() -> list:
    return [
        H1("5. Clientes e certificados"),
        H2("Cadastrar um cliente"),
        P("Tela <b>Clientes → Novo cliente</b>. Os campos principais:"),
        table(
            [
                ["Campo", "Observação"],
                ["Razão social *", "Nome oficial da empresa."],
                ["Nome fantasia", "Aparece nas telas e no nome da pasta das notas, quando preenchido."],
                ["CNPJ *", "O robô confere o CNPJ no SIAT antes de agendar."],
                [
                    "Inscrição estadual",
                    "<b>Obrigatória para o robô.</b> O SIAT web identifica o contribuinte pela IE, e o robô "
                    "confere a IE em cada linha antes de agendar ou baixar.",
                ],
                ["UF *", "PI."],
                [
                    "Operações",
                    "Quais notas a empresa usa: NFC-e, NF-e emitidas, NF-e recebidas. Na Automação, o robô "
                    "só pede o que estiver marcado aqui.",
                ],
                ["Ativo", "Clientes inativos não aparecem para agendamento."],
            ],
            [42, 128],
        ),
        P("Cada cliente recebe um código automático (" + code("CLI000001") + ", " + code("CLI000002") + "...)."),
        H2("Associar o certificado"),
        *steps(
            [
                "Tela <b>Certificados → Associar certificado</b> (ou dentro do cliente).",
                "Escolha o cliente.",
                "Em <b>Ler dados do arquivo PFX</b>, selecione o .pfx, digite a senha e clique em <b>Ler</b>. O "
                "painel preenche titular, emissor, série e validade. O arquivo e a senha são lidos só no seu "
                "navegador e não são enviados a lugar nenhum.",
                "Confira os dados e clique em <b>Salvar</b>.",
            ]
        ),
        *bullets(
            [
                "<b>Seleção manual do certificado:</b> marque se quiser que o robô sempre espere você escolher o "
                "certificado (necessário para certificado A3).",
                "O painel avisa quando o certificado está perto de vencer (padrão: 30 dias). O robô não usa "
                "certificado vencido.",
                "Se o CNPJ do certificado for diferente do cliente, o painel avisa. Isso é esperado apenas para "
                "certificado de procurador ou contador.",
            ]
        ),
        *warn(
            "Cadastrar o certificado no painel não basta: o .pfx precisa estar instalado no Windows de "
            "<b>cada computador</b> que roda o robô (seção 3, passo 1)."
        ),
    ]


def cap_automacao() -> list:
    return [
        H1("6. Agendar exportações (Automação)"),
        *steps(
            [
                "Abra a tela <b>Automação</b>.",
                "Escolha a <b>Competência</b> (mês/ano), por exemplo 08/2026.",
                "Marque as <b>Operações</b>: NFC-e, NF-e emitidas, NF-e recebidas.",
                "Use a busca e os filtros (<b>Ativos</b>, <b>Certificado válido</b>, <b>Com NFC-e</b>, "
                "<b>Com NF-e</b>) para achar os clientes.",
                "Marque os clientes, ou <b>Selecionar todos</b>.",
                "Clique em <b>Agendar</b> e confirme. Os pedidos vão para a Fila.",
            ]
        ),
        H2("O que o robô usa em cada exportação"),
        table(
            [
                ["Nota", "Configuração no SIAT"],
                ["NFC-e", "Contribuinte como emitente; tipo saída; status <b>todas</b>."],
                ["NF-e emitidas", "Contribuinte como emitente; tipo de nota <b>todas</b>; status <b>ativas</b>."],
                ["NF-e recebidas", "Contribuinte como destinatário; tipo de nota <b>todas</b>; status <b>ativas</b>."],
                ["Período", "Do primeiro ao último dia da competência."],
            ],
            [35, 135],
        ),
        H2("Pedidos repetidos"),
        *bullets(
            [
                "Se a competência já foi agendada para o cliente, o painel avisa e não duplica.",
                "Se o SIAT responder <i>“Já existe um agendamento com os parâmetros passados”</i>, o robô "
                "aproveita o número (ID) do agendamento que já existe, em vez de dar erro.",
                "<b>Forçar novo agendamento</b> (somente administrador) pede de novo mesmo que já exista.",
            ]
        ),
    ]


def cap_fila() -> list:
    return [
        H1("7. Acompanhar a Fila"),
        P(
            "A tela <b>Fila</b> atualiza sozinha, em tempo real. As abas separam: <b>Em andamento</b>, "
            "<b>Aguardando SEFAZ</b>, <b>Intervenção</b>, <b>Finalizados</b> e <b>Todos</b>."
        ),
        H2("Colunas"),
        table(
            [
                ["Coluna", "O que mostra"],
                ["Cliente", "Nome, código e competência."],
                ["Status", "Situação atual, a etapa e, se houve, o número da tentativa."],
                ["Progresso", "Em que etapa está (tabela abaixo). Não é estimativa de tempo."],
                [
                    "Tempo",
                    "<b>Robô</b>: quanto o robô levou para agendar (para de contar quando termina). "
                    "<b>SEFAZ há</b>: há quanto tempo a SEFAZ está processando (continua contando até o "
                    "arquivo ficar pronto). Concluídos mostram o <b>Total</b>.",
                ],
                ["Última mensagem", "O último passo do robô; passe o mouse para ler inteira."],
                ["Ações (três pontinhos)", "Detalhes e logs, Reprocessar, Cancelar."],
            ],
            [35, 135],
        ),
        H2("A barra de progresso"),
        table(
            [
                ["%", "Etapa", "Quem faz"],
                ["0%", "Na fila", "Aguardando o robô"],
                ["5 a 48%", "Abrindo o navegador, entrando no SIAT e no e-AGEAT", "Robô"],
                ["50 / 60 / 70%", "Agendando NFC-e / NF-e emitidas / NF-e recebidas", "Robô"],
                ["<b>80%</b>", "<b>Aguardando SEFAZ</b>: tudo agendado, falta a SEFAZ processar", "SEFAZ (até 1 dia útil)"],
                ["85%", "Consultando se ficou pronto (a cada 30 minutos)", "Robô"],
                ["90 a 98%", "Baixando e organizando os arquivos", "Robô"],
                ["100%", "Concluído", ""],
            ],
            [25, 105, 40],
        ),
        *tip("Ficar muito tempo em 80% é normal: é a SEFAZ processando. Só se preocupe com os status Erro ou Intervenção."),
        H2("Ações"),
        *bullets(
            [
                "<b>Detalhes e logs:</b> passo a passo do robô, notas, IDs do SIAT e prints.",
                "<b>Reprocessar</b> (administrador): coloca de novo na fila um agendamento com erro. O que já "
                "foi agendado no SIAT não é pedido de novo.",
                "<b>Cancelar:</b> interrompe o agendamento. Se o computador do robô estiver desligado, o "
                "cancelamento é concluído assim que algum robô estiver ligado.",
                "<b>Continuar automação:</b> aparece quando o robô pede uma ação sua (status Intervenção). Faça a "
                "ação no Chrome aberto pelo robô e clique em continuar.",
            ]
        ),
    ]


def cap_downloads() -> list:
    return [
        H1("8. Downloads e pastas das notas"),
        H2("Onde ficam os arquivos"),
        P(
            "Os ZIPs ficam <b>no computador que fez o download</b>, organizados assim:"
        ),
        P(code("C:\\SIAT-Robo\\storage\\downloads\\CLI000001 - NOME DA EMPRESA\\2026\\08\\NFCE\\CLI000001_2026-08_NFCE.zip")),
        *bullets(
            [
                "Uma pasta por empresa, com o código na frente do nome. Se o nome mudar no painel, a pasta é "
                "renomeada sozinha.",
                "Dentro: ano, mês e tipo (" + code("NFCE") + ", " + code("NFE_EMITIDAS") + ", "
                + code("NFE_RECEBIDAS") + ").",
                "O robô <b>nunca apaga</b> os ZIPs. Você apaga quando quiser.",
            ]
        ),
        H2("Tela Downloads"),
        P(
            "Lista todas as notas baixadas, com filtros por competência, cliente e tipo. O ícone de informação (i), ao lado do nome, mostra o "
            "caminho completo e o código de conferência (SHA-256) do arquivo."
        ),
        H2("Botão Abrir pasta"),
        *steps(
            [
                "Clique em <b>Abrir pasta</b> na linha da nota.",
                "Na primeira vez, o navegador pergunta <b>“Abrir SIAT Robô?”</b>: marque <b>Sempre permitir</b> "
                "e clique em Abrir.",
                "O Explorer abre com o ZIP já selecionado.",
            ]
        ),
        *tip(
            "O botão funciona no computador onde o robô está instalado. Se a nota foi baixada por outro "
            "computador, aparece um aviso e abre a pasta de notas deste computador."
        ),
    ]


def cap_historico() -> list:
    return [
        H1("9. Histórico, Erros, Dashboard e Configurações"),
        H2("Histórico"),
        P(
            "Todas as execuções, com quem pediu, resultado e duração. Ao abrir uma, aparecem: período, "
            "tarefas de cada nota com o ID do SIAT, notas baixadas, o passo a passo (logs) e os prints."
        ),
        H2("Erros"),
        P("Lista das falhas com o código do erro, a mensagem e o print da tela no momento do erro."),
        H2("Dashboard"),
        P(
            "Resumo geral: números das automações, últimas execuções e certificados vencendo nos próximos "
            "30 dias. O botão <b>Processar competência</b> é um atalho para agendar."
        ),
        H2("Configurações (administrador)"),
        table(
            [
                ["Parâmetro", "Padrão", "Efeito"],
                ["Intervalo de consulta do Collector", "30 min", "De quanto em quanto tempo o robô verifica se a SEFAZ liberou."],
                ["Máximo de consultas por agendamento", "96", "Depois disso (cerca de 48 h), o agendamento é encerrado com aviso."],
                ["Alerta de vencimento de certificado", "30 dias", "Antecedência do aviso de certificado vencendo."],
            ],
            [60, 22, 88],
        ),
        P(
            "A tela também lista os <b>computadores com o robô</b>: nome, versão instalada, se está online e "
            "quando deu sinal pela última vez. Computadores com versão antiga aparecem como "
            "<b>Desatualizado</b> até se atualizarem sozinhos."
        ),
    ]


def cap_icone() -> list:
    def row(state: str, color: str, meaning: str) -> list:
        return [icon(state, 8), Paragraph(f"<b>{color}</b>", S["cell"]), Paragraph(meaning, S["cell"])]

    t = Table(
        [
            [Paragraph("Ícone", S["cellb"]), Paragraph("Cor", S["cellb"]), Paragraph("Significado", S["cellb"])],
            row("idle", "Verde", "Robô ligado, aguardando trabalho."),
            row("busy", "Azul", "Trabalhando no SIAT (agendando ou baixando)."),
            row("attention", "Vermelho", "Algum agendamento falhou ou precisa de você."),
            row("stopped", "Cinza", "Robô parado."),
        ],
        colWidths=[18 * mm, 28 * mm, 124 * mm],
    )
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), BRAND),
                ("GRID", (0, 0), (-1, -1), 0.4, LINE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 1), (0, -1), "CENTER"),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return [
        H1("10. O ícone ao lado do relógio"),
        P(
            "Nos computadores com o robô, um ícone perto do relógio mostra o estado do robô. Na primeira vez, "
            "o Windows o esconde na setinha <b>^</b>: arraste-o para a barra para deixá-lo sempre visível."
        ),
        t,
        Spacer(1, 8),
        H2("Menu (botão direito)"),
        table(
            [
                ["Item", "O que faz"],
                ["(linha cinza)", "Estado atual do robô. Se houver problemas, aparece “Precisam de atenção” com a lista."],
                ["Abrir painel", "Abre o site. Dois cliques no ícone fazem o mesmo."],
                ["Abrir pasta das notas", "Abre a pasta de downloads deste computador."],
                ["Ligar robô", "Liga o robô, se estiver parado."],
                ["Parar robô", "Termina o trabalho atual e para. Nada se perde."],
                ["Ver mensagens do robô (log)", "Abre o registro técnico, útil para o suporte."],
                ["Atualizar agora", "Aparece quando há versão nova. O robô termina o trabalho atual, instala e volta sozinho."],
                ["Parar robô e fechar o ícone", "Desliga tudo: o robô termina o trabalho atual e para, e o ícone fecha. Para ligar de novo: menu Iniciar → SIAT Robô → Ligar robô (ou entrar no Windows)."],
                ["Fechar só o ícone", "Fecha só o ícone; <b>o robô continua trabalhando</b>. Para reabrir: menu Iniciar → SIAT Robô."],
            ],
            [50, 120],
        ),
        P(
            "O ícone também mostra avisos no canto da tela, por exemplo <i>“Notas baixadas: EMPRESA 08/2026 "
            "(NFC-e, NF-e emitidas, NF-e recebidas)”</i>."
        ),
        H2("Atalhos no menu Iniciar → SIAT Robô"),
        *bullets(
            [
                "<b>SIAT Robô (ícone ao lado do relógio)</b>: reabre o ícone.",
                "<b>Painel SIAT</b> e <b>Pasta das notas</b>.",
                "<b>Ligar robô</b> e <b>Parar robô</b>.",
                "<b>Status e verificação</b>: mostra se o robô está rodando, as últimas mensagens e, se você "
                "responder <b>s</b>, confere Supabase, Chrome, pasta e o certificado de cada cliente.",
                "<b>Desinstalar SIAT Robô</b>.",
            ]
        ),
    ]


def cap_funcionamento() -> list:
    return [
        H1("11. Como o robô trabalha no dia a dia"),
        H2("Liga sozinho"),
        *bullets(
            [
                "O robô inicia <b>1 minuto depois que você entra no Windows</b>, sem janela, como administrador.",
                "Se ele cair por algum erro, volta sozinho.",
                "Tela bloqueada (Windows + L): o robô continua. Logoff, desligar ou suspender: o robô para até "
                "o computador voltar.",
            ]
        ),
        H2("Enquanto trabalha"),
        *bullets(
            [
                "Uma janela do Chrome abre sozinha. <b>Não clique nela nem a feche.</b> Pode minimizar e usar "
                "o computador normalmente.",
                "Evite entrar no SIAT com a mesma empresa no seu navegador ao mesmo tempo: o SIAT pode derrubar "
                "uma das sessões.",
                "O e-AGEAT do SIAT às vezes abre com “Error 500” ou “Usuário não identificado”. O robô fecha e "
                "tenta de novo sozinho, até 7 vezes.",
            ]
        ),
        H2("Quando não há nada pendente"),
        P(
            "O robô fica ligado, mas parado: só consulta o painel de tempos em tempos, sem abrir o Chrome nem "
            "acessar o SIAT. Gasta pouca memória e praticamente nada de processador."
        ),
        H2("Se o computador desligar no meio de um trabalho"),
        *bullets(
            [
                "Nada se perde. Se outro computador com o robô estiver ligado, ele assume o trabalho em cerca "
                "de <b>3 minutos</b>.",
                "Se só faltava baixar, o robô continua de onde parou, sem pedir de novo ao SIAT.",
                "Se não houver outro computador, o trabalho continua quando este for religado.",
                "Um cancelamento feito no painel nesse meio tempo é respeitado.",
            ]
        ),
        H2("Se uma nota não baixar"),
        P(
            "As outras notas continuam sendo baixadas. O robô tenta a nota com problema de novo em 5, 15, 30 e "
            "60 minutos; depois de 5 falhas, ela fica marcada com erro para você conferir no SIAT."
        ),
    ]


def cap_seguranca() -> list:
    return [
        H1("12. Segurança e dados"),
        H2("Proteção contra cliente errado"),
        *bullets(
            [
                "Antes de qualquer ação, o robô confere se o SIAT abriu com o CNPJ do cliente certo.",
                "No SIAT web, confere a Inscrição Estadual do usuário e de cada linha antes de agendar ou baixar.",
                "Se algo não bater, <b>para na hora</b> e registra o erro, sem agendar nem baixar nada.",
                "A regra que faz o Chrome escolher o certificado vale só durante o trabalho daquele cliente e é "
                "apagada em seguida.",
            ]
        ),
        H2("Senhas e chaves"),
        *bullets(
            [
                "O arquivo .pfx e a senha do certificado nunca são enviados ao painel nem ao banco de dados.",
                "A Secret key fica só no arquivo " + code(".env") + " de cada computador.",
                "O robô não tenta burlar CAPTCHA nem verificação em duas etapas: se o SIAT pedir, ele aguarda você.",
            ]
        ),
        H2("Quanto tempo os dados ficam guardados"),
        table(
            [
                ["O quê", "Onde", "Por quanto tempo"],
                ["ZIPs das notas", "Computador que baixou", "<b>Para sempre</b>; você apaga quando quiser"],
                ["Histórico, logs e lista de downloads", "Painel (banco de dados)", "60 dias após o download"],
                ["Logs técnicos detalhados", "Painel", "7 dias"],
                ["Prints de etapas e erros", "Computador do robô", "60 dias"],
                ["Clientes, certificados, usuários", "Painel", "Enquanto existirem"],
            ],
            [60, 50, 60],
        ),
        *warn(
            "A legislação exige guardar os XMLs das notas por 5 anos, e a guarda é responsabilidade do "
            "contribuinte. Importe as notas no sistema contábil ou guarde uma cópia de segurança."
        ),
    ]


def cap_problemas() -> list:
    return [
        H1("13. Problemas comuns"),
        table(
            [
                ["Situação", "O que fazer"],
                [
                    "O ícone está cinza (robô parado)",
                    "Botão direito no ícone → <b>Ligar robô</b>, ou menu Iniciar → SIAT Robô → Ligar robô.",
                ],
                [
                    "Agendamento parado em 80% por muito tempo",
                    "Normal: é a SEFAZ processando (até 1 dia útil). O robô consulta a cada 30 minutos.",
                ],
                [
                    "Status Erro: “Contribuinte aberto no portal difere do cliente”",
                    "O SIAT abriu com outro certificado. Nada foi feito. Confira se o .pfx certo está instalado e "
                    "clique em Reprocessar.",
                ],
                [
                    "Verificação: “Certificado NÃO instalado neste Windows”",
                    "Instale o .pfx do cliente com o mesmo usuário que roda o robô.",
                ],
                [
                    "Status Intervenção",
                    "O robô precisa de você (por exemplo, escolher o certificado). Faça a ação no Chrome aberto "
                    "pelo robô e clique em Continuar automação.",
                ],
                [
                    "Abrir pasta avisa que o arquivo não está neste computador",
                    "A nota foi baixada por outro computador. Pegue lá ou refaça o agendamento neste: o SIAT "
                    "reaproveita o pedido existente.",
                ],
                [
                    "“O Windows protegeu o computador” ao instalar",
                    "Clique em Mais informações → Executar assim mesmo.",
                ],
                [
                    "O código de ativação foi recusado",
                    "Ele vale 30 minutos e só uma vez. Gere outro em Computadores → Adicionar computador.",
                ],
                [
                    "O ícone mostra “Ativar este computador”",
                    "O computador ainda usa o acesso antigo. Gere um código em Computadores e clique na opção "
                    "(ou menu Iniciar → SIAT Robô → Ativar este computador).",
                ],
                [
                    "Uma nota ficou com erro depois de 5 tentativas",
                    "Confira no SIAT o agendamento com o ID mostrado nos detalhes. Se precisar, peça de novo com "
                    "Forçar novo agendamento.",
                ],
            ],
            [60, 110],
        ),
        H2("Onde ficam os registros para o suporte"),
        *bullets(
            [
                code("C:\\SIAT-Robo\\storage\\logs\\worker.log") + ": mensagens do robô.",
                code("C:\\SIAT-Robo\\storage\\logs\\instalacao.log") + ": relatório da instalação.",
                code("C:\\SIAT-Robo\\storage\\errors") + ": prints dos erros.",
            ]
        ),
    ]


def cap_glossario() -> list:
    return [
        H1("14. Glossário"),
        table(
            [
                ["Termo", "Significado"],
                ["Competência", "Mês/ano das notas (por exemplo, 08/2026)."],
                ["Agendamento", "Pedido de exportação feito no SIAT; o SIAT devolve um número (ID)."],
                ["Collector", "A parte do robô que volta ao SIAT para baixar os arquivos prontos."],
                ["e-AGEAT", "Área do SIAT por onde o robô chega ao SIAT web de exportação."],
                ["Certificado A1", "Certificado digital em arquivo (.pfx), instalado no Windows."],
                ["IE", "Inscrição Estadual do contribuinte."],
                ["Código de ativação", "Código de uso único que vincula um computador ao escritório."],
                ["Escritório", "Cada empresa de contabilidade que usa o sistema; os dados de um não aparecem para outro."],
                ["Reprocessar", "Colocar de novo na fila um agendamento que deu erro."],
                ["SHA-256", "Código de conferência do arquivo; prova que o ZIP não foi alterado."],
            ],
            [40, 130],
        ),
    ]


def build() -> Path:
    doc = ManualDoc(OUT)
    story: list = []
    story += cover()
    story += toc()
    chapters = [
        cap_visao_geral,
        cap_requisitos,
        cap_instalacao,
        cap_painel_acesso,
        cap_clientes_certificados,
        cap_automacao,
        cap_fila,
        cap_downloads,
        cap_historico,
        cap_icone,
        cap_funcionamento,
        cap_seguranca,
        cap_problemas,
        cap_glossario,
    ]
    for i, chapter in enumerate(chapters):
        blocks = chapter()
        story.append(KeepTogether(blocks[:2]))
        story += blocks[2:]
        if i < len(chapters) - 1:
            story.append(PageBreak())
    story.append(Spacer(1, 10 * mm))
    story.append(Paragraph(f"SIAT Robô {__version__} · {PANEL_URL}", ParagraphStyle("end", parent=S["small"], alignment=TA_CENTER)))
    doc.multiBuild(story)
    return OUT


if __name__ == "__main__":
    print(build())
