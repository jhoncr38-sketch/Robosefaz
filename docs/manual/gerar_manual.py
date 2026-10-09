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

BRAND = colors.HexColor("#1F7A4D")
BRAND_LIGHT = colors.HexColor("#EEF7F1")
NAVY = colors.HexColor("#13294B")
LOGO = Path(__file__).resolve().parents[2] / "branding" / "logo-full.png"
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
            title="JR Sistema - Manual do usuário",
            author="JR Sistema",
            subject="Instalação e uso do JR Sistema e do robô",
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
        logo_w = 150 * mm
        logo_h = logo_w / 3  # logo-full.png tem proporção 3:1
        canv.drawImage(str(LOGO), (w - logo_w) / 2, h - 30 * mm - logo_h, logo_w, logo_h, mask="auto")
        canv.setFillColor(BRAND_LIGHT)
        canv.rect(0, 0, w, 95 * mm, fill=1, stroke=0)
        canv.setFillColor(BRAND)
        canv.rect(0, 95 * mm, w, 1.2 * mm, fill=1, stroke=0)
        canv.restoreState()

    def _page(self, canv, doc) -> None:  # noqa: ANN001
        w, h = A4
        canv.saveState()
        canv.setStrokeColor(LINE)
        canv.setLineWidth(0.5)
        canv.line(20 * mm, h - 14 * mm, w - 20 * mm, h - 14 * mm)
        canv.setFont("Segoe", 8)
        canv.setFillColor(MUTED)
        canv.drawString(20 * mm, h - 11.5 * mm, "JR Sistema · Manual do usuário")
        canv.drawRightString(w - 20 * mm, h - 11.5 * mm, f"Versão {__version__}")
        canv.drawRightString(w - 20 * mm, 11 * mm, f"Página {doc.page}")
        canv.restoreState()


def cover() -> list:
    white_title = ParagraphStyle("ct", fontName="Segoe-Bold", fontSize=30, leading=36, textColor=NAVY, alignment=TA_CENTER)
    white_sub = ParagraphStyle("cs", fontName="Segoe", fontSize=14, leading=20, textColor=MUTED, alignment=TA_CENTER)
    info = ParagraphStyle("ci", fontName="Segoe", fontSize=11, leading=17, textColor=INK)
    return [
        Spacer(1, 70 * mm),
        Paragraph("Manual do usuário", white_title),
        Spacer(1, 2 * mm),
        Paragraph("Automação SIAT · SEFAZ-PI", white_sub),
        Paragraph("Da instalação às ferramentas do dia a dia", white_sub),
        Spacer(1, 84 * mm),
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
        H1("1. O que é o JR Sistema Robô"),
        P(
            "O JR Sistema Robô faz sozinho o trabalho repetitivo de entrar no SIAT Web com o certificado de cada "
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
                "Antes de fechar o navegador, ele confere a lista por até 3 minutos e já baixa o que "
                "ficou pronto (inclusive um agendamento que alguém já tinha feito à mão no SIAT). O que "
                "ainda não ficou pronto ele confere a cada 30 minutos. Se em 3 clientes seguidos nada "
                "ficar pronto na hora (SEFAZ lenta), ele pula essa espera por 30 minutos e depois tenta de novo.",
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
            "Configurações do Windows → Aplicativos → <b>JR Sistema Robô</b> → Desinstalar. As notas baixadas em "
            + code("storage\\downloads") + " <b>não são apagadas</b>."
        ),
        H2("Instalar em mais de um computador"),
        *bullets(
            [
                "Repita os passos 1 a 3 em cada computador. Cada um precisa dos certificados instalados.",
                "O computador que estiver ligado pega os agendamentos da fila. Se os dois estiverem ligados, "
                "eles dividem o trabalho, e o mesmo cliente nunca é processado por dois robôs ao mesmo tempo.",
                "Se um computador pegar um cliente cujo certificado <b>não está instalado nele</b>, ele repassa o "
                "trabalho para outro computador do escritório (a fila mostra “repassado para …”) e não o pega de "
                "novo. Se nenhum computador tiver o certificado, o trabalho fica em <b>certificado necessário</b> "
                "dizendo onde foi tentado: instale o A1 em um deles e clique em <b>Reprocessar</b>.",
                "Sem o Google Drive, cada computador guarda as notas que <b>ele</b> baixou. Com o Google Drive "
                "(capítulo 8), use a <b>mesma pasta</b> em todos os computadores: as notas ficam juntas e o "
                "“Baixar pasta do mês” sai completo.",
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
                ["Reprocessar um agendamento com erro", "Sim", "Sim", "Não"],
                ["Forçar novo agendamento mesmo se já existir", "Sim", "Sim", "Não"],
                ["Cadastrar e editar clientes e certificados", "Sim", "Sim", "Não"],
                ["Excluir clientes e certificados, ativar computadores", "Sim", "Não", "Não"],
                ["Alterar configurações", "Sim", "Não", "Não"],
                ["Gerenciar usuários", "Sim", "Não", "Não"],
            ],
            [85, 30, 27, 28],
        ),
        H2("Menu do painel"),
        P(
            "O menu fica à esquerda, em três grupos: <b>Operação</b>, <b>Cadastros</b> e <b>Sistema</b>. Os "
            "números ao lado dos itens mostram quantos agendamentos estão na fila, quantas notas foram baixadas "
            "e quantos clientes estão ativos. No alto, a busca (<b>Ctrl+K</b>) encontra um cliente pelo nome, "
            "código ou CNPJ, e o selo <b>Robô ativo</b> mostra se algum computador com o robô está ligado. "
            "Clicando no seu nome, em <b>Tema</b>, dá para usar o modo <b>Noturno</b> (ou <b>Automático</b>, "
            "igual ao Windows); a escolha vale para aquele navegador."
        ),
        table(
            [
                ["Tela", "Para que serve"],
                ["Dashboard", "Situação da competência, o que o robô está fazendo agora e o que precisa de atenção."],
                ["Automação SIAT", "Pedir agendamentos de uma competência para vários clientes."],
                ["Consulta EFD", "Ver se a EFD de cada cliente foi processada (mensagens do DT-e)."],
                ["Fila de processamento", "Acompanhar em tempo real o que o robô está fazendo."],
                ["Clientes", "Cadastro das empresas."],
                ["Certificados", "Certificado digital de cada cliente e sua validade."],
                ["Downloads", "Notas baixadas, com a quantidade de notas e os botões Baixar e Abrir pasta."],
                ["Busca por chave de acesso", "Achar uma nota pela chave da DANFE, ver a DANFE na tela e, se faltar, buscar no SIAT (beta)."],
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
                "Abra a tela <b>Automação SIAT</b> (ou, no Dashboard, <b>Processar competência</b> ou "
                "<b>Agendar pendentes</b>).",
                "<b>Competência:</b> use as setas ‹ › para escolher o mês. A tela abre no mês anterior, que "
                "é o mais comum; meses futuros não aparecem.",
                "<b>Operações:</b> ligue ou desligue NFC-e, NF-e emitidas e NF-e recebidas. O botão "
                "<b>Canceladas</b> (desligado por padrão) acrescenta, para cada tipo marcado, um pedido só com as "
                "notas canceladas, que chegam num ZIP separado.",
                "<b>Clientes:</b> cada cliente mostra a situação dele naquela competência (Concluído, Na fila, "
                "Aguardando SEFAZ, Erro, Não solicitado...). Os filtros <b>Todos</b>, <b>Pendentes</b> e "
                "<b>Já solicitados</b> ajudam a achar quem falta.",
                "Marque os clientes, ou use <b>Selecionar pendentes</b> no resumo ao lado.",
                "Confira o <b>Resumo do agendamento</b> (clientes, exportações e tempo estimado) e clique em "
                "<b>Processar</b>. Os pedidos vão para a Fila.",
            ]
        ),
        H2("O que o robô usa em cada exportação"),
        table(
            [
                ["Nota", "Configuração no SIAT"],
                ["NFC-e", "Contribuinte como emitente; tipo saída; status <b>ativas</b>."],
                ["NF-e emitidas", "Contribuinte como emitente; tipo de nota <b>todas</b>; status <b>ativas</b>."],
                ["NF-e recebidas", "Contribuinte como destinatário; tipo de nota <b>todas</b>; status <b>ativas</b>."],
                ["Canceladas", "A mesma tela de cada tipo marcado, com status <b>canceladas</b> (botão Canceladas)."],
                ["Período", "Do primeiro ao último dia da competência."],
            ],
            [35, 135],
        ),
        H2("Notas canceladas"),
        *bullets(
            [
                "Desde a versão 1.2.32 o pedido normal traz só as notas <b>ativas</b> (antes, a NFC-e vinha com as "
                "canceladas misturadas). As canceladas vêm num pedido próprio, quando o botão <b>Canceladas</b> está "
                "ligado, e são salvas num ZIP separado: <i>EMPRESA - NF-e emitidas canceladas - 09-2026 - CLI000001.zip</i>, "
                "na pasta NFE_EMITIDAS_CANCELADAS da empresa. Assim uma nota cancelada nunca é importada como válida.",
                "Mês já processado: com <b>Canceladas</b> ligado, a empresa pode ser marcada de novo e o robô pede "
                "<b>só as canceladas</b> (os pedidos normais repetidos são ignorados).",
                "Na tela <b>Downloads</b>, o arquivo de canceladas aparece com a etiqueta vermelha <b>canceladas</b> ao "
                "lado do tipo. Mês sem nenhuma cancelada (o mais comum) não aparece na lista, só no Histórico do trabalho.",
                "Cada pedido de canceladas leva uns 15 a 20 segundos a mais por empresa.",
            ]
        ),
        H2("Pedidos repetidos"),
        *bullets(
            [
                "Cliente que já tem pedido na competência aparece com um <b>cadeado</b> (“será ignorado”). "
                "Erro e Cancelado podem ser agendados de novo.",
                "Se o SIAT responder <i>“Já existe um agendamento com os parâmetros passados”</i>, o robô "
                "aproveita o número (ID) do agendamento que já existe, em vez de dar erro.",
                "<b>Forçar reagendamento</b> (administrador e operador), no rodapé do resumo, libera os clientes "
                "com cadeado e pede de novo, com confirmação. Se o SIAT responder que o agendamento já existe, o "
                "robô <b>exclui esse agendamento no SIAT</b> (só o ID informado pelo SIAT e só se for da inscrição "
                "do cliente) e faz um novo. Os arquivos já baixados continuam nas pastas.",
                "Se agendar o <b>mês atual</b> antes de ele acabar, o SIAT só entrega as notas emitidas até "
                "aquele momento. Depois que o mês fechar, agende de novo com Forçar reagendamento para o arquivo "
                "vir completo.",
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
                ["85%", "Consultando se ficou pronto (logo depois de agendar e, se faltar algo, a cada 30 minutos)", "Robô"],
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
                "<b>Reprocessar</b> (administrador e operador): coloca de novo na fila um agendamento com erro. O que já "
                "foi agendado no SIAT não é pedido de novo.",
                "<b>Cancelar:</b> interrompe o agendamento. Se o computador do robô estiver desligado, o "
                "cancelamento é concluído assim que algum robô estiver ligado.",
                "<b>Continuar automação:</b> aparece quando o robô pede uma ação sua (status Intervenção). Faça a "
                "ação no Chrome aberto pelo robô e clique em continuar.",
            ]
        ),
        H2("Trabalho parado esperando um computador"),
        P(
            "Quando um trabalho fica parado porque nenhum computador ligado pode fazê-lo (o único PC com o "
            "certificado do cliente está desligado, ou nenhum robô está ligado), aparece um <b>aviso no canto "
            "inferior direito</b>, em qualquer tela. Ele diz qual computador está faltando, há quanto tempo está "
            "desligado e <b>o que fazer</b>, em passos. O <b>x</b> recolhe o aviso numa pílula; ele some sozinho "
            "quando o problema se resolve (em até 30 segundos) e abre de novo se outro trabalho parar. Na fila, a "
            "linha do trabalho mostra \"Aguardando o PC ...\". Se estiver tudo certo, o aviso não aparece."
        ),
        *tip(
            "Instalou o certificado no computador que estava ligado? Cancele o trabalho na fila e clique em "
            "Reprocessar: o computador que já tinha tentado só volta a pegar o trabalho depois disso."
        ),
    ]


def cap_downloads() -> list:
    return [
        H1("8. Downloads e pastas das notas"),
        H2("Onde ficam os arquivos"),
        P(
            "Os ZIPs ficam <b>no computador que fez o download</b> (ou no Google Drive, veja abaixo), "
            "organizados por mês e depois por empresa:"
        ),
        P(code("C:\\SIAT-Robo\\storage\\downloads\\2026\\08\\NOME DA EMPRESA\\NFCE\\NOME DA EMPRESA - NFC-e - 08-2026 - CLI000001.zip")),
        *bullets(
            [
                "Ano e mês primeiro: todas as notas de uma competência ficam numa pasta só.",
                "Dentro do mês, uma pasta por empresa, só com o nome dela. Se o nome mudar no painel, as pastas "
                "são renomeadas sozinhas. Se duas empresas tiverem o mesmo nome, a segunda ganha o código no fim, "
                "por exemplo " + code("SILVA VARIEDADES (CLI000013)") + ".",
                "O nome de cada arquivo traz a empresa, o tipo, o mês e, no fim, o código do cliente ("
                + code("LIA PAPELARIA - NFC-e - 08-2026 - CLI000001.zip") + "). Baixada pelo painel, a nota já "
                "chega identificada. O código é o que o robô e o painel usam para saber de quem é a nota: não o "
                "apague do nome. Uma segunda versão diferente do mesmo mês fica ao lado, com " + code("(2)") + ".",
                "Dentro da empresa, o tipo (" + code("NFCE") + ", " + code("NFE_EMITIDAS") + ", "
                + code("NFE_RECEBIDAS") + ").",
                "O robô <b>nunca apaga</b> os ZIPs. Você apaga quando quiser. Notas antigas, no formato "
                "empresa/ano/mês (até a versão 1.2.7), com o código na frente do nome da empresa (até a 1.2.10) "
                "ou com nome de arquivo " + code("CLI000001_2026-08_NFCE.zip") + " (até a 1.2.25) são "
                "reorganizadas e renomeadas sozinhas, aos poucos (só renomeia: o link do Google Drive continua o mesmo).",
            ]
        ),
        H2("Salvar as notas no Google Drive (opcional)"),
        P(
            "Assim a equipe baixa as notas de qualquer lugar, pelo navegador, e as notas de todos os computadores "
            "com o robô ficam na mesma pasta."
        ),
        *steps(
            [
                "Instale o <b>Google Drive para computador</b> e entre na conta Google.",
                "No primeiro computador, a ferramenta do passo 4 cria a pasta <b>JR Sistema - Notas</b>. Nos outros "
                "computadores com o robô, compartilhe essa pasta com a conta Google usada ali como <b>Editor</b>. "
                "Depois, em drive.google.com dessa conta, abra <b>Compartilhados comigo</b>, clique com o botão "
                "direito na pasta e escolha <b>Organizar → Adicionar atalho → Meu Drive</b>.",
                "Espere 1 minuto para o Google Drive sincronizar.",
                "Menu Iniciar → JR Sistema → <b>Salvar notas no Google Drive</b> e clique em <b>Sim</b> no pedido "
                "de administrador. A ferramenta testa a gravação, copia as notas já baixadas (sem apagar nada), "
                "troca a pasta do robô e confere que ele passou a usá-la. Se algo falhar, nada é mudado.",
            ]
        ),
        *tip(
            "Para a equipe só consultar, compartilhe a pasta com o e-mail de cada pessoa como <b>Leitor</b>. "
            "Evite “Qualquer pessoa com o link”: as notas têm dados fiscais dos clientes."
        ),
        P(
            "<b>Se o Google Drive estiver fechado</b> na hora de um download, o robô salva a nota na pasta "
            "do próprio computador (" + code("C:\\SIAT-Robo\\storage\\downloads") + "), avisa no histórico e a "
            "envia para o Drive sozinho quando ele voltar. Sem internet, o próprio Google Drive guarda e envia depois."
        ),
        H2("Tela Downloads"),
        P(
            "Lista todas as notas baixadas, com filtros por competência, cliente e tipo. Embaixo do tipo aparece a "
            "<b>quantidade de notas</b> do arquivo (o robô conta sozinho, alguns minutos depois do download). O ícone de "
            "informação (i), ao lado da quantidade, mostra o nome do arquivo, o tamanho, a data do download, o caminho "
            "completo e o código de conferência (SHA-256). A lista mostra os 500 itens mais recentes; no fim dela, "
            "<b>Carregar mais</b> traz os próximos 500, mantendo os filtros."
        ),
        H2("Sem movimento"),
        P(
            "Quando o SIAT processa o pedido e não há nenhuma nota no período (\"Processado sem notas\" ou ZIP vazio), "
            "não existe arquivo para baixar. A lista mostra a empresa assim mesmo, com <b>0 notas</b> e a etiqueta "
            "<b>Sem movimento</b> no lugar do botão Baixar (passe o mouse para ver o número do pedido e quando o SIAT "
            "respondeu). Assim fica claro que a empresa foi agendada e conferida."
        ),
        P(
            "O filtro <b>Situação</b> mostra só <b>Com notas</b> ou só <b>Sem movimento</b>. Ao escolher uma competência, "
            "o alto da lista resume o mês: quantas empresas, quantas vieram com notas, quantas sem movimento e quantas "
            "ainda sem resposta (na fila, aguardando a SEFAZ ou com erro). Cada empresa conta uma vez por tipo de nota."
        ),
        H2("Mês para conferir"),
        P(
            "Quando um mês vem <b>sem notas</b> ou com <b>bem menos notas</b> que a média dos 3 meses anteriores do mesmo "
            "cliente e tipo (menos da metade e pelo menos 10 notas a menos), a quantidade aparece em amarelo, com um "
            "triângulo. Passe o mouse para ver a comparação. No alto da lista, <b>meses para conferir</b> mostra só esses. "
            "Pode ser normal (empresa parada, férias, queda depois do Natal); se não for, confira no SIAT se vieram todas "
            "as notas do mês. O mês corrente, ou baixado antes de terminar, nunca gera aviso."
        ),
        H2("Mais de um escritório na mesma conta do Google"),
        P(
            "Cada escritório usa a <b>própria pasta</b>. O primeiro escritório de uma conta fica com "
            "<b>JR Sistema - Notas</b>; os outros escritórios da mesma conta ficam com "
            "<b>JR Sistema - Notas - Nome do Escritório</b>, criada pela ferramenta <b>Salvar notas no Google Drive</b> "
            "no computador de cada um. A pasta guarda um arquivo <b>.jr-sistema-escritorio.json</b> com o escritório "
            "dono: não apague nem copie esse arquivo."
        ),
        *tip(
            "Se um computador for apontado para a pasta de outro escritório, o robô não grava nem mexe nela: as "
            "notas ficam no próprio computador (plano B) e a tela Configurações avisa \"Pasta das notas é do "
            "escritório ...\". Rode Salvar notas no Google Drive nesse computador para criar a pasta certa."
        ),
        H2("Trocar a conta do Google Drive"),
        *steps(
            [
                "No Google Drive para computador (ícone ao lado do relógio → engrenagem → Preferências), "
                "<b>adicione</b> a conta nova sem desconectar a antiga.",
                "Rode <b>Salvar notas no Google Drive</b> e escolha, na lista, o Drive da conta nova. A ferramenta "
                "copia as notas para lá (nada é apagado) e troca a pasta do robô.",
                "O robô percebe a troca e refaz os links dos botões Baixar na conta nova em alguns minutos.",
                "Faça o mesmo em todos os computadores com robô e compartilhe a pasta nova com a equipe. Depois, "
                "se quiser, desconecte a conta antiga.",
            ]
        ),
        H2("Baixar uma nota ou o mês inteiro (Google Drive)"),
        P(
            "Com as notas no Google Drive, a tela Downloads mostra o botão <b>Baixar</b> em cada nota: ele baixa o "
            "ZIP direto do Drive, em qualquer computador, para quem tem a pasta <b>JR Sistema - Notas</b> "
            "compartilhada. O botão libera alguns minutos depois que a nota chega ao Drive."
        ),
        *steps(
            [
                "Para baixar <b>todas as notas de um mês</b>, escolha a competência no filtro e clique em "
                "<b>Baixar pasta do mês</b>. Para as de <b>um cliente</b> no mês, escolha também o cliente e clique "
                "em <b>Baixar pasta do cliente</b>.",
                "A pasta abre no Google Drive. Clique na setinha ao lado do nome da pasta (no topo) → "
                "<b>Fazer download</b>.",
                "O Drive gera um ZIP com as pastas dos clientes e dos tipos de nota, e o download começa.",
            ]
        ),
        H2("Botão Abrir pasta"),
        *steps(
            [
                "Clique em <b>Abrir pasta</b> na linha da nota.",
                "Na primeira vez, o navegador pergunta <b>“Abrir JR Sistema Robô?”</b>: marque <b>Sempre permitir</b> "
                "e clique em Abrir.",
                "O Explorer abre com o ZIP já selecionado.",
            ]
        ),
        *tip(
            "O botão funciona no computador onde o robô está instalado. Se a nota foi baixada por outro "
            "computador, aparece um aviso e abre a pasta de notas deste computador."
        ),
        H2("Mais de um arquivo no mesmo mês (versões)"),
        P(
            "Quando o mesmo mês e tipo é exportado de novo (por exemplo, <b>Forçar reagendamento</b> depois que "
            "entraram notas novas), o robô compara o ZIP novo com o que já está na pasta. Se for igual, não grava "
            "nada. Se o conteúdo mudou, grava uma versão ao lado, com " + code("(2)") + ", " + code("(3)") + "… "
            "e nunca apaga a anterior. A tela Downloads mostra só a versão mais nova; nos blocos com mais de uma, "
            "aparece o marcador <b>“N versões”</b>: passe o mouse para o resumo e clique para ver cada versão "
            "(data, se veio de agendamento normal ou forçado, quantidade de notas e a diferença para a anterior), "
            "cada uma com o botão de baixar. A versão atual é a mais completa."
        ),
        H2("Busca por chave de acesso (beta)"),
        P(
            "Em <b>Resultados › Busca por chave de acesso</b>, cole os <b>44 números</b> da chave da DANFE. O robô "
            "lê cada XML dos ZIPs baixados e guarda chave, número, data, valor, emitente e destinatário; se a nota "
            "já foi baixada, ela abre na hora, montada no formato da DANFE, com os botões <b>Baixar XML desta "
            "nota</b> e <b>Imprimir</b>. A visualização serve para conferência: o documento fiscal é o XML."
        ),
        P(
            "Se a nota ainda não foi baixada, a tela mostra o que a chave revela (tipo, número, série, mês, estado "
            "e CNPJ do emitente) e o campo <b>Buscar no SIAT com o certificado de</b>. Se o emitente é cliente do "
            "escritório, ele já vem escolhido; se a nota foi recebida, escolha quem comprou. O robô entra no SIAT "
            "com o certificado dessa empresa, usa <b>Pesquisar SOMENTE pela Chave da NFE</b> e o SIAT entrega o "
            "arquivo na hora. Leva cerca de 1 minuto e precisa de um computador do escritório com o robô ligado "
            "(versão 1.2.34 ou mais nova)."
        ),
        *bullets(
            [
                "Vale só para NF-e (modelo 55). NFC-e não tem busca pela chave no SIAT: ela vem junto com o mês.",
                "O SIAT só entrega a nota ao emitente ou ao destinatário. Com a empresa errada, a resposta é "
                "“nota não encontrada”; escolha outra empresa e busque de novo.",
                "O arquivo fica na pasta da empresa, em " + code("NFE_RECEBIDAS\\Avulsas") + " (ou "
                + code("NFE_EMITIDAS\\Avulsas") + "), fora da lista da tela Downloads. Quando o mês inteiro for "
                "exportado depois, a mesma nota vem no ZIP do mês; na busca ela continua aparecendo uma vez só.",
                "Ao terminar, chega um aviso no sino com o link para a nota.",
            ]
        ),
    ]


def cap_historico() -> list:
    return [
        H1("9. Histórico, Erros, Dashboard, Consulta EFD e Configurações"),
        H2("Histórico"),
        P(
            "Todas as execuções, com quem pediu, resultado e duração. Ao abrir uma, aparecem: período, "
            "tarefas de cada nota com o ID do SIAT, notas baixadas, o passo a passo (logs) e os prints. A lista "
            "mostra as 300 execuções mais recentes; no fim dela, <b>Carregar mais</b> traz as próximas."
        ),
        P(
            "Quando a empresa não teve notas no mês, o SIAT mostra <i>“Processado sem notas”</i> e não oferece "
            "arquivo. O robô conclui sem erro e a tarefa aparece como <b>Sem notas no período</b>."
        ),
        H2("Erros"),
        P("Lista das falhas com o código do erro, a mensagem e o print da tela no momento do erro."),
        H2("Dashboard"),
        P(
            "A tela inicial do painel, atualizada em tempo real:"
        ),
        *bullets(
            [
                "<b>Competência atual</b> (o mês anterior): barra colorida com a situação de cada cliente, "
                "downloads disponíveis, concluídos e erros. <b>Agendar pendentes</b> abre a Automação com quem "
                "falta já selecionado.",
                "<b>Últimas execuções</b>, com as abas Todas, Em andamento e a competência.",
                "<b>Agora</b>: o cliente que o robô está processando, a etapa e o tempo, e quando será a "
                "próxima consulta à SEFAZ.",
                "<b>Precisa de atenção</b>: intervenções, esperas longas da SEFAZ, erros, clientes sem pedido e "
                "certificados vencendo.",
                "<b>Certificados</b>: válidos, vencendo em 30 dias, vencidos e o próximo a vencer.",
            ]
        ),
        H2("Consulta EFD"),
        P(
            "Mostra se a EFD de cada cliente foi processada pela SEFAZ-PI, lendo as notificações "
            "<b>“EPE - EFD - Período AAAAMM”</b> do Domicílio Eletrônico (DT-e) do SIAT."
        ),
        *steps(
            [
                "Abra <b>Consulta EFD</b> e escolha a competência com as setas.",
                "Marque os clientes (ou <b>Selecionar os sem resultado</b>) e clique em "
                "<b>Consultar processamento de EFD</b>.",
                "O robô entra no SIAT de cada cliente, lê as mensagens da EFD e o resultado aparece sozinho.",
            ]
        ),
        table(
            [
                ["Situação", "O que significa"],
                ["Processada", "A SEFAZ-PI processou a declaração sem inconsistências."],
                ["Processada com malha", "Inconsistência tipo 3 (alerta): pode ser analisada por Auditor Fiscal."],
                ["Processada com pendência", "Inconsistência tipo 2: regularizar em até 45 dias."],
                ["Não processada", "Inconsistência tipo 1 (impeditiva): a EFD não tem validade para a SEFAZ-PI."],
                ["Sem mensagem no DT-e", "EFD não entregue ou mensagem expirada (o SIAT mantém por cerca de 60 dias)."],
            ],
            [45, 125],
        ),
        *bullets(
            [
                "Clique no cliente para ver finalidade (original ou retificadora), EPE, datas, as inconsistências "
                "e a mensagem completa. Quando há retificadora, vale a declaração processada por último.",
                "O robô abre <b>somente</b> as notificações da EFD e nunca exclui mensagens. Abrir registra a data "
                "de leitura no SIAT, como quando você abre à mão.",
            ]
        ),
        H2("Consulta de Malhas"),
        P(
            "Mostra, para cada cliente, as malhas fiscais em aberto no SIAT: o que aparece em Autoatendimento → "
            "Malhas Fiscais → Consulta de Malhas (tabelas DIEF/PGDAS e EFD/OIE), com a identificação da malha, "
            "a quantidade de períodos, o ICMS devido/destacado e a quantidade de NF-e."
        ),
        *steps(
            [
                "Marque os clientes (ou <b>Selecionar os sem resultado</b>) e clique em <b>Consultar malhas no SIAT</b>.",
                "O robô entra no SIAT de cada cliente, confere que a inscrição estadual da página é a do cliente, clica "
                "em <b>Consulta</b> e lê as duas tabelas. Só leitura: a lupa de cada malha não é aberta e nada é alterado.",
                "O resultado aparece na tela sozinho: <b>Sem malha</b> (verde) ou <b>Com malha</b> (vermelho), com o "
                "ICMS e a data da consulta. Clique na linha para ver cada malha e o texto da página do SIAT.",
            ]
        ),
        *tip(
            "A consulta não é por competência: ela mostra o que está em aberto agora. Peça de novo quando quiser "
            "atualizar. Malhas intimadas pelo DT-e não aparecem nessa página do SIAT; para essas, veja o e-AGEAT → "
            "Malhas Fiscais → Manifestação do Contribuinte."
        ),
        H2("Configurações (administrador)"),
        table(
            [
                ["Parâmetro", "Padrão", "Efeito"],
                ["Intervalo de consulta do Collector", "30 min", "De quanto em quanto tempo o robô verifica se a SEFAZ liberou."],
                ["Máximo de consultas por agendamento", "96", "Depois disso (cerca de 48 h), o agendamento é encerrado com aviso."],
                ["Alerta de vencimento de certificado", "30 dias", "Antecedência do aviso de certificado vencendo."],
                ["Conferência rápida depois de agendar", "180 s", "Quanto tempo o robô espera, com o navegador "
                 "aberto, para já baixar o que ficou pronto. 0 desliga."],
                ["Intervalo da conferência rápida", "60 s", "De quanto em quanto tempo ele confere nesse período."],
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
            [Paragraph("Ícone", S["cellb"]), Paragraph("Ponto", S["cellb"]), Paragraph("Significado", S["cellb"])],
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
                ["Abrir pasta das notas", "Abre a pasta das notas em uso (a do Google Drive, se estiver ligada)."],
                [
                    "Mostrar navegador do robô",
                    "O robô trabalha no SIAT com o Chrome <b>escondido fora da tela</b>. Este item traz a janela "
                    "para a frente, para acompanhar; depois vira <b>Esconder navegador do robô</b>. Fica cinza "
                    "quando o robô não está com o navegador aberto.",
                ],
                [
                    "Deixar navegador sempre visível",
                    "Liga e desliga (aparece uma marca quando está ligado). Ligado, o Chrome do robô trabalha "
                    "<b>na tela</b>, como nas versões antigas; desligado, volta a trabalhar escondido. Vale na "
                    "hora, inclusive para o trabalho em andamento, e continua valendo depois de reiniciar.",
                ],
                ["Ligar robô", "Liga o robô, se estiver parado."],
                ["Parar robô", "Termina o trabalho atual e para. Nada se perde."],
                ["Atualizar agora", "Aparece quando há versão nova. O robô termina o trabalho atual, instala e volta sozinho."],
                ["Status e verificação", "A mesma janela do menu Iniciar (veja abaixo)."],
                [
                    "Salvar notas no Google Drive",
                    "Liga o robô a uma pasta do Google Drive (capítulo 8). Pede permissão de administrador.",
                ],
                ["Ativar este computador", "Aparece só enquanto o computador não foi ativado com o código do painel."],
                [
                    "Ajuda e suporte",
                    "<b>Manual do JR Sistema</b> (este documento), <b>Falar com o suporte</b> (abre uma conversa no "
                    "WhatsApp) e <b>Mensagens do robô (log)</b>, o registro técnico que o suporte pode pedir.",
                ],
                ["Sair", "O robô termina o trabalho atual e para, e o ícone fecha. Para ligar de novo: menu Iniciar → JR Sistema → Ligar robô (ou entrar no Windows de novo)."],
            ],
            [50, 120],
        ),
        H2("Navegador do robô escondido"),
        P(
            "Para não atrapalhar quem usa o computador, o Chrome do robô abre <b>fora da tela</b>: ele funciona "
            "igual (certificado, Web PKI e as fotos de cada etapa no Histórico), só não aparece e não rouba o "
            "foco de quem está digitando. Para ver o que ele está fazendo, use <b>Mostrar navegador do robô</b> no "
            "ícone ou clique no botão do Chrome do robô na barra de tarefas. Quando o robô precisa de você "
            "(escolher o certificado, clicar em "
            "Permitir no Web PKI, resolver um CAPTCHA), a janela <b>aparece sozinha</b> e o painel mostra o "
            "pedido; depois ela volta a se esconder. Para ver sempre a janela, como antes, marque "
            "<b>Deixar navegador sempre visível</b> no ícone (a escolha fica gravada como "
            + code("BROWSER_WINDOW=visible") + " em " + code("C:\\SIAT-Robo\\.env") + ")."
        ),
        P(
            "O ícone também mostra avisos no canto da tela, por exemplo <i>“Notas baixadas: EMPRESA 08/2026 "
            "(NFC-e, NF-e emitidas, NF-e recebidas)”</i>."
        ),
        H2("Atalhos no menu Iniciar → JR Sistema"),
        *bullets(
            [
                "<b>Robô (ícone ao lado do relógio)</b>: reabre o ícone.",
                "<b>Painel JR Sistema</b> e <b>Pasta das notas</b> (abre a pasta em uso, inclusive a do Google Drive).",
                "<b>Salvar notas no Google Drive</b>: veja o capítulo 8.",
                "<b>Ligar robô</b> e <b>Parar robô</b>.",
                "<b>Status e verificação</b>: janela que mostra se o robô está ligado e a versão, e confere o "
                "acesso ao painel, o Chrome, a pasta das notas, o certificado de cada cliente e o início automático. "
                "Os itens com ✖ precisam de correção.",
                "<b>Desinstalar o robô</b>.",
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
                    "Botão direito no ícone → <b>Ligar robô</b>, ou menu Iniciar → JR Sistema → Ligar robô.",
                ],
                [
                    "Agendamento parado em 80% por muito tempo",
                    "Normal: é a SEFAZ processando (até 1 dia útil). O robô já conferiu logo depois de "
                    "agendar e agora consulta a cada 30 minutos.",
                ],
                [
                    "Status Erro: “Contribuinte aberto no portal difere do cliente”",
                    "O SIAT abriu com outro certificado. Nada foi feito. Confira se o .pfx certo está instalado e "
                    "clique em Reprocessar.",
                ],
                [
                    "Status Erro: “Nenhuma das opções de ‘Selecionar Tipo Usuário’ abriu o CNPJ”",
                    "O certificado está ligado a mais de um cadastro na SEFAZ e o robô tentou cada um, mas nenhum "
                    "abriu a empresa do cliente. Entre no SIAT com esse certificado e veja qual cadastro é o da "
                    "empresa; se for outro CNPJ, corrija o cadastro do cliente no painel.",
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
                    "Salvar notas no Google Drive: “Não encontrei o Google Drive”",
                    "Abra o Google Drive para computador e entre na conta. Se ele já está aberto, o Windows está "
                    "escondendo a unidade de programas de administrador: fale com o suporte.",
                ],
                [
                    "Salvar notas no Google Drive: “Não consegui gravar”",
                    "A conta deste computador está como Leitor na pasta: mude para <b>Editor</b>.",
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
                    "(ou menu Iniciar → JR Sistema → Ativar este computador).",
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
    story.append(Paragraph(f"JR Sistema Robô {__version__} · {PANEL_URL}", ParagraphStyle("end", parent=S["small"], alignment=TA_CENTER)))
    doc.multiBuild(story)
    return OUT


if __name__ == "__main__":
    print(build())
