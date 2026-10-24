#!/usr/bin/env python3
"""Gera as frentes Rush Duel em PT-BR a partir de src/data/cards.mjs.

Uso: python3 tools/card-render/render.py [id ...]

Saída: src/assets/cards/<id>.jpg (842x1228, 2x) e <id>-art.jpg (arte limpa 752x760).
Moldura, ícones e fontes: rush-hub (github.com/JLtheking2/rush-hub, molduras de AlixSep),
selo LEGEND: yugioh-card (MIT). Os dois repositórios são baixados sozinhos (sparse, fixados por commit) para cache/. Geometria segue docs/renderer.md do rush-hub (espaço 421x614).
Arte: ilustração limpa do Yugipedia (achada por import_pool.py fetch); senão, recorte do scan japonês.
Requer Pillow e node (para ler o pool).
"""
import hashlib
import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = HERE / 'cache'
# Recursos de terceiros: baixados na primeira execução (ver baixar_recursos). Commits fixos = resultado reprodutível.
RUSH_HUB = CACHE / 'rush-hub'
YGO_CARD = CACHE / 'yugioh-card'
REPOS = [  # (url, destino, commit, pastas)
    ('https://github.com/JLtheking2/rush-hub', RUSH_HUB, 'cf84a5488b6d1d1f64f7dcdf006a7b6e248b0289', ['public/assets/rush', 'public/fonts']),
    ('https://github.com/kooriookami/yugioh-card', YGO_CARD, '92462bbd2aa3aa0075ebcc9b633bdc05137fd7ac', ['src/assets/yugioh-card/rush-duel']),  # mesmo commit em tools/setup/setup.mjs
]
FONTS = RUSH_HUB / 'public/fonts'
RUSH_ASSETS = RUSH_HUB / 'public/assets/rush'
LEGEND = YGO_CARD / 'src/assets/yugioh-card/rush-duel/image/legend.png'  # o rush-hub não traz o selo LEGEND
OUT = ROOT / 'src' / 'assets' / 'cards'
S = 1.5  # 632x921: texto nítido no celular sem pesar 400+ cartas
W, H = 421, 614
ART_BOX = (22, 61, 376, 380)
UA = 'RushDaily/0.1 (projeto pessoal, sem fins comerciais)'

FONT = {
    'name': FONTS / 'MatrixRegularSmallCaps.ttf',
    'effect': FONTS / 'MatrixBook.ttf',
    'flavor': FONTS / 'AmiriItalic.ttf',
    'type': FONTS / 'StoneSerifSmallCapsBold.ttf',
    'serial': FONTS / 'StoneSerif.otf',
    'stat': FONTS / 'EurostileCandyBold.ttf',
}
ATTRIBUTE = {'DARK': 'Dark', 'LIGHT': 'Light', 'EARTH': 'Earth', 'WATER': 'Water', 'FIRE': 'Fire', 'WIND': 'Wind', 'DIVINE': 'Divine'}
INK = '#17110a'


def s(*values):
    return tuple(round(value * S) for value in values) if len(values) > 1 else round(values[0] * S)


def font(role, size):
    return ImageFont.truetype(str(FONT[role]), s(size))


def asset(path, size=None):
    image = Image.open(LEGEND if path == 'legend.png' else RUSH_ASSETS / path).convert('RGBA')
    return image.resize(s(*size), Image.LANCZOS) if size else image.resize(s(image.width, image.height), Image.LANCZOS)


def baixar_recursos():
    """Clona (sparse, sem histórico) as molduras, ícones e fontes para cache/, uma vez."""
    for url, dest, commit, folders in REPOS:
        if all((dest / folder).exists() for folder in folders):
            continue
        print('baixando', url, '...', flush=True)
        CACHE.mkdir(exist_ok=True)
        git = lambda *args: subprocess.run(['git', '-C', str(dest), *args], check=True, capture_output=True)
        if not dest.exists():
            subprocess.run(['git', 'init', '-q', str(dest)], check=True)
            git('remote', 'add', 'origin', url)
        git('sparse-checkout', 'set', *folders)
        git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', commit)
        git('checkout', '-q', '--force', 'FETCH_HEAD')


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read()


def yugipedia(filename):
    """Baixa uma vez para cache/ (o CDN do Yugipedia usa caminho por md5)."""
    target = CACHE / filename
    if not target.exists():
        digest = hashlib.md5(filename.encode()).hexdigest()
        CACHE.mkdir(exist_ok=True)
        target.write_bytes(fetch(f'https://ms.yugipedia.com//{digest[0]}/{digest[:2]}/{filename}'))
    return Image.open(target).convert('RGB')


def cover(image, size):
    """Recorte central no aspecto de `size` (object-fit: cover)."""
    tw, th = size
    scale = max(tw / image.width, th / image.height)
    resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    left, top = (resized.width - tw) // 2, (resized.height - th) // 2
    return resized.crop((left, top, left + tw, top + th))


def artwork(card):
    size = s(*ART_BOX[2:])
    clean = card.get('illustration')
    if clean:
        return cover(yugipedia(clean), size), True
    scan = yugipedia(card['scan'])
    # O scan oficial tem a mesma proporção 421x614: a janela de arte escala junto.
    sx, sy = scan.width / W, scan.height / H
    x, y, w, h = ART_BOX
    return scan.crop((round(x * sx), round(y * sy), round((x + w) * sx), round((y + h) * sy))).resize(size, Image.LANCZOS), False


def squash_text(canvas, box, text, role, size, fill, stroke=0, stroke_fill=None, align='left', dy=0, tracking=0):
    """Uma linha; comprime na horizontal se não couber (como o FitText do rush-hub)."""
    x, y, w, h = s(*box)
    f, st = font(role, size), s(stroke)
    widths = [f.getlength(char) + s(tracking) for char in text]
    tw = round(sum(widths)) + st * 2 + 4
    th = round(s(size) * 1.35) + st * 2
    layer = Image.new('RGBA', (tw, th))
    draw = ImageDraw.Draw(layer)
    cursor = st + 2
    for char, advance in zip(text, widths):
        draw.text((cursor, st), char, font=f, fill=fill, stroke_width=st, stroke_fill=stroke_fill)
        cursor += advance
    if layer.width > w:
        layer = layer.resize((w, layer.height), Image.LANCZOS)
    px = x + (w - layer.width) // 2 if align == 'center' else x + w - layer.width if align == 'right' else x
    canvas.alpha_composite(layer, (round(px), round(y + s(dy))))
    return min(layer.width, w) / S


def wrap(draw, words, f, width):
    lines, line = [], []
    for word in words:
        if line and draw.textlength(' '.join(line + [word]), font=f) > width:
            lines.append(line)
            line = [word]
        else:
            line.append(word)
    return lines + [line] if line else lines


def paragraph(canvas, box, blocks, role, start_size, dy=1, leading_ratio=1.12):
    """Texto justificado que encolhe até caber na caixa de efeito."""
    x, y, w, h = s(*box)
    draw = ImageDraw.Draw(canvas)
    size = start_size
    while size > 9:
        f = font(role, size)
        leading = s(size) * leading_ratio
        laid = [wrap(draw, block.split(), f, w) for block in blocks]
        if sum(len(lines) for lines in laid) * leading <= h:
            break
        size -= 0.25
    cursor = y + s(dy)
    for lines in laid:
        for index, line in enumerate(lines):
            if index == len(lines) - 1 or len(line) == 1:
                draw.text((x, cursor), ' '.join(line), font=f, fill=INK)
            else:
                gap = (w - sum(draw.textlength(word, font=f) for word in line)) / (len(line) - 1)
                cx = x
                for word in line:
                    draw.text((cx, cursor), word, font=f, fill=INK)
                    cx += draw.textlength(word, font=f) + gap
            cursor += leading


def type_line(canvas, card):
    monster = card['type'] == 'monster'
    text = f"{card['race']} / Normal" if monster else 'Carta Mágica' if card['type'] == 'spell' else 'Carta de Armadilha'
    box = (37, 443.5, 350, 30) if monster else (39, 443.5, 330, 20)
    width = squash_text(canvas, box, text, 'type', 16, INK, tracking=0.3)
    canvas.alpha_composite(asset('icons/leftbracket.png', (5, 15)), s(30, 446))
    right = int(39 + width) if monster else int(width + 43)
    canvas.alpha_composite(asset('icons/rightbracket.png', (5, 15)), s(right, 446))


def render(card, index):
    art, clean = artwork(card)
    canvas = Image.new('RGBA', s(W, H), 'black')
    canvas.paste(art, s(*ART_BOX[:2]))
    if card['type'] == 'monster':
        # A barra de ATK/DEF da moldura é translúcida: um fundo escuro esconde os números do scan.
        ImageDraw.Draw(canvas).polygon([s(56, 409), s(374, 409), s(399, 440), s(38, 440)], fill='#141414')
    frame = {'monster': 'normal', 'spell': 'spell', 'trap': 'trap'}[card['type']]
    canvas.alpha_composite(asset(f'frames/{frame}.png', (W, H)))

    attribute = ATTRIBUTE.get(card.get('attribute'), 'Void') if card['type'] == 'monster' else frame.capitalize()
    canvas.alpha_composite(asset(f'attributes/{attribute}.png', (54, 54)), s(345, 22))
    squash_text(canvas, (29, 5, 308, 48), card['name'], 'name', 44, INK, dy=8, tracking=0.2)

    if card['type'] == 'monster':
        canvas.alpha_composite(asset('stars/normal.png', (63, 68)), s(24, 370))
        squash_text(canvas, (32, 392, 45, 32), str(card['level']), 'stat', 28, 'white', 2.5, '#b8231a', 'center', 4)
        for box, value in (((146, 411, 75, 30), card['atk']), ((276, 411, 75, 30), card['def'])):
            squash_text(canvas, box, str(value), 'stat', 19.5, 'white', 2.5, 'black', 'right', 3.5, tracking=0.4)

    if card.get('legend'):
        canvas.alpha_composite(asset('legend.png', (104, 25)), s(28, 66))

    type_line(canvas, card)
    if card['type'] == 'monster':
        paragraph(canvas, (31, 468, 358, 100), [card['desc']], 'flavor', 17, 3, 1.18)
    else:
        requirement = card.get('requirement') or 'Nenhum.'
        paragraph(canvas, (31, 467, 358, 101), [f'[Requisito] {requirement}', f"[Efeito] {card['desc']}"], 'effect', 18.5)

    squash_text(canvas, (264, 576, 131, 16), f'RD/DAY-PT{index:03d}', 'serial', 11.5, 'white', align='right', dy=2)

    OUT.mkdir(parents=True, exist_ok=True)
    canvas.convert('RGB').save(OUT / f"{card['id']}.webp", quality=82, method=6)
    return clean


def load_pool():
    script = f"import('{(ROOT / 'src/data/cards.mjs').as_uri()}').then(m => console.log(JSON.stringify(m.CARD_POOL)))"
    return json.loads(subprocess.run(['node', '-e', script], check=True, capture_output=True, text=True).stdout)


if __name__ == '__main__':
    # Uso: render.py [--force] [id ...]  (sem --force, pula cartas já renderizadas)
    baixar_recursos()
    force = '--force' in sys.argv
    wanted = {int(arg) for arg in sys.argv[1:] if arg != '--force'}
    jobs = [(card, number) for number, card in enumerate(load_pool(), start=1)
            if (not wanted or card['id'] in wanted) and (force or wanted or not (OUT / f"{card['id']}.webp").exists())]
    print(len(jobs), 'cartas para renderizar', flush=True)
    with ThreadPoolExecutor(6) as pool:
        for (card, _), clean in zip(jobs, pool.map(lambda job: render(*job), jobs)):
            print('ok' if clean else 'scan', card['id'], card['name'])
