"""Ícone do robô no estilo da marca JR Sistema (desenhado com Pillow, sem arquivos de imagem).

Cabeça do robô da logo (branca, visor azul-marinho com olhos sorrindo, orelhas e
antena verdes). O estado aparece num ponto no canto:
verde = ligado e aguardando, azul = trabalhando no SIAT,
vermelho = algo precisa de atenção, cinza = robô parado. "brand" = sem ponto
(instalador, atalhos e favicon do painel).

`python -m app.tray_icons <destino.ico>` gera o ícone do instalador.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

COLORS = {
    "idle": (34, 160, 98),  # verde
    "busy": (37, 99, 235),  # azul
    "attention": (220, 38, 38),  # vermelho
    "stopped": (130, 130, 125),  # cinza
}

# cores da logo
WHITE = (255, 255, 255, 255)
OUTLINE = (196, 208, 220, 255)
VISOR = (16, 34, 61, 255)
GREEN = (31, 181, 122, 255)
GREEN_DARK = (15, 125, 99, 255)
STEM = (43, 61, 85, 255)


def draw(state: str = "idle", size: int = 64) -> Image.Image:
    s = 4 * size  # desenha grande e reduz: bordas suaves
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = s / 64

    def box(x0: float, y0: float, x1: float, y1: float, dy: float = 6) -> tuple[float, float, float, float]:
        # dy centraliza a cabeça (antena no alto, sobra embaixo)
        return (x0 * u, (y0 + dy) * u, x1 * u, (y1 + dy) * u)

    # antena
    d.line(box(32, 5, 32, 14), fill=STEM, width=int(3 * u))
    d.ellipse(box(27.5, 1, 36.5, 10), fill=GREEN)
    # orelhas
    d.rounded_rectangle(box(3, 22, 12, 40), radius=4 * u, fill=GREEN_DARK)
    d.rounded_rectangle(box(52, 22, 61, 40), radius=4 * u, fill=GREEN_DARK)
    # cabeça (contorno cinza-claro para aparecer também em fundo branco)
    d.rounded_rectangle(box(8, 12, 56, 50), radius=13 * u, fill=OUTLINE)
    d.rounded_rectangle(box(9.5, 13.5, 54.5, 48.5), radius=12 * u, fill=WHITE)
    # visor
    d.rounded_rectangle(box(15, 20, 49, 42), radius=9 * u, fill=VISOR)
    # olhos sorrindo (arcos)
    w = max(1, int(3.2 * u))
    d.arc(box(19.5, 26, 29.5, 36), start=200, end=340, fill=WHITE, width=w)
    d.arc(box(34.5, 26, 44.5, 36), start=200, end=340, fill=WHITE, width=w)

    if state in COLORS:
        # ponto de estado no canto inferior direito, com anel branco
        d.ellipse(box(40, 40, 64, 64, dy=0), fill=WHITE)
        d.ellipse(box(43, 43, 61, 61, dy=0), fill=COLORS[state] + (255,))
    return img.resize((size, size), Image.LANCZOS)


ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
# abaixo disto a logo completa (JR + robô) vira borrão: usa a cabeça do robô desenhada
LOGO_MIN_SIZE = 32


def _square(img: Image.Image) -> Image.Image:
    img = img.crop(img.getbbox())
    side = max(img.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
    return sq


def save_ico(path: Path, state: str = "brand", logo: Path | None = None) -> Path:
    """Ícone .ico com vários tamanhos.

    Com `logo` (branding/logo-mark.png), os tamanhos a partir de 32 px usam a logo da marca
    (atalhos da Área de Trabalho e do menu Iniciar); 16 e 24 px ficam com a cabeça do robô.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    mark = _square(Image.open(logo).convert("RGBA")) if logo is not None else None
    images = [
        mark.resize((s, s), Image.LANCZOS) if mark is not None and s >= LOGO_MIN_SIZE else draw(state, s)
        for s in ICO_SIZES
    ]
    # o maior é o principal; os demais entram prontos (sem o Pillow redimensionar o maior)
    images[-1].save(path, format="ICO", sizes=[(s, s) for s in ICO_SIZES], append_images=images[:-1])
    return path


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("robo.ico")
    print(save_ico(target))
