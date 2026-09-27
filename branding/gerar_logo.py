"""Gera logo-full.png e logo-mark.png (fundo transparente) a partir de logo-original.png.

Uso: python branding/gerar_logo.py (precisa do Pillow; o venv do worker tem).
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
SRC = HERE / "logo-original.png"
OUT = HERE

im = Image.open(SRC).convert("RGBA")


def knock_out_white(img: Image.Image) -> Image.Image:
    """Fundo branco -> transparente só no que está ligado à borda (o branco do robô fica).
    Borda suave: pixels claros vizinhos do fundo ganham alfa parcial."""
    from collections import deque
    img = img.copy()
    px = img.load()
    w, h = img.size

    def light(x, y):
        r, g, b, _ = px[x, y]
        return min(r, g, b) >= 238 and max(r, g, b) - min(r, g, b) < 14

    bg = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if light(x, y) and not bg[y * w + x]:
                bg[y * w + x] = 1; q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if light(x, y) and not bg[y * w + x]:
                bg[y * w + x] = 1; q.append((x, y))
    while q:
        x, y = q.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not bg[ny * w + nx] and light(nx, ny):
                bg[ny * w + nx] = 1; q.append((nx, ny))
    for y in range(h):
        for x in range(w):
            if bg[y * w + x]:
                r, g, b, a = px[x, y]
                px[x, y] = (r, g, b, 0)
            else:
                # antisserrilhado: pixel claro encostado no fundo fica semitransparente
                near = any(
                    0 <= x + dx < w and 0 <= y + dy < h and bg[(y + dy) * w + x + dx]
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                )
                if near:
                    r, g, b, a = px[x, y]
                    m = min(r, g, b)
                    if m > 200:
                        px[x, y] = (r, g, b, int(255 * (255 - m) / 55))
    return img


# logo completa
full = knock_out_white(im.crop((50, 274, 1410, 727)))
full.save(OUT / "logo-full.png")

# símbolo: parte de cima inteira (robô) + parte de baixo só até antes do texto "JR"
X0, X1, Y0, Y1 = 55, 620, 279, 722
CUT_Y, CUT_X = 566, 486
sym = Image.new("RGBA", (X1 - X0, Y1 - Y0), (255, 255, 255, 0))
top = im.crop((X0, Y0, X1, CUT_Y))
bottom = im.crop((X0, CUT_Y, CUT_X, Y1))
sym.paste(top, (0, 0))
sym.paste(bottom, (0, CUT_Y - Y0))
# área à direita-embaixo (onde está o texto) fica branca
d = ImageDraw.Draw(sym)
d.rectangle((CUT_X - X0, CUT_Y - Y0, X1 - X0, Y1 - Y0), fill=(255, 255, 255, 255))
# topo das letras do texto que sobe acima do corte, à direita do corpo do robô
d.rectangle((528 - X0, 548 - Y0, X1 - X0, CUT_Y - Y0), fill=(255, 255, 255, 255))
# canto do "J" do texto logo abaixo do robô: só os pixels verdes (o corpo do robô é branco)
spx = sym.load()
for yy in range(540 - Y0, CUT_Y - Y0):
    for xx in range(CUT_X - 6 - X0, 530 - X0):
        r, g, b, a = spx[xx, yy]
        if g > r + 35:
            spx[xx, yy] = (255, 255, 255, 255)
sym = knock_out_white(sym)
bbox = sym.getbbox()
sym = sym.crop(bbox)
# quadrado com margem
side = max(sym.size) + 16
sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
sq.paste(sym, ((side - sym.width) // 2, (side - sym.height) // 2), sym)
sq.save(OUT / "logo-mark.png")
print("full", full.size, "mark", sq.size)
