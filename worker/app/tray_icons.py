"""Ícone do robô (desenhado com Pillow, sem arquivos de imagem).

Cabeça de robô branca sobre um círculo com a cor do estado:
verde = ligado e aguardando, azul = trabalhando no SIAT,
vermelho = algo precisa de atenção, cinza = robô parado.

`python -m app.tray_icons <destino.ico>` gera o ícone do instalador.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

COLORS = {
    "idle": (22, 163, 74),  # verde
    "busy": (37, 99, 235),  # azul
    "attention": (220, 38, 38),  # vermelho
    "stopped": (115, 115, 115),  # cinza
    "brand": (15, 118, 110),  # verde-azulado (ícone do instalador/atalhos)
}


def draw(state: str = "idle", size: int = 64) -> Image.Image:
    s = 4 * size  # desenha grande e reduz: bordas suaves
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((0, 0, s - 1, s - 1), fill=COLORS.get(state, COLORS["idle"]) + (255,))

    white = (255, 255, 255, 255)
    u = s / 64
    # antena
    d.line((32 * u, 10 * u, 32 * u, 17 * u), fill=white, width=int(3 * u))
    d.ellipse((28.5 * u, 7 * u, 35.5 * u, 14 * u), fill=white)
    # cabeça
    d.rounded_rectangle((14 * u, 17 * u, 50 * u, 45 * u), radius=8 * u, fill=white)
    # orelhas
    d.rounded_rectangle((9 * u, 25 * u, 14 * u, 37 * u), radius=2 * u, fill=white)
    d.rounded_rectangle((50 * u, 25 * u, 55 * u, 37 * u), radius=2 * u, fill=white)
    # olhos e boca na cor do estado
    eye = COLORS.get(state, COLORS["idle"]) + (255,)
    d.ellipse((21 * u, 24 * u, 29 * u, 32 * u), fill=eye)
    d.ellipse((35 * u, 24 * u, 43 * u, 32 * u), fill=eye)
    d.rounded_rectangle((24 * u, 37 * u, 40 * u, 40 * u), radius=1.5 * u, fill=eye)
    # "pescoço" e corpo
    d.rounded_rectangle((20 * u, 48 * u, 44 * u, 56 * u), radius=4 * u, fill=white)
    return img.resize((size, size), Image.LANCZOS)


def save_ico(path: Path, state: str = "brand") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    big = draw(state, 256)
    big.save(path, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return path


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("robo.ico")
    print(save_ico(target))
