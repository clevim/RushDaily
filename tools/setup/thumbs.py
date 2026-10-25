#!/usr/bin/env python3
"""Miniaturas webp das cartas clássicas: classic-cards-sm (140 px). As Rush saem prontas de tools/rush/render.mjs (rush-cards-sm).

As grades de coleção/decks mostram a carta em 90-150 px; baixar a carta inteira (418x609, 44-98 KB)
só para isso custa 4-10x mais bytes (e passa pelo túnel). Pula as que já existem e estão mais novas que a original.
Uso: python3 tools/setup/thumbs.py [--force]
"""
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
JOBS = [('src/assets/classic-cards', 'src/assets/classic-cards-sm', 140)]
force = '--force' in sys.argv

for origem, destino, largura in JOBS:
    src, dst = ROOT / origem, ROOT / destino
    if not src.is_dir():
        print(f'{origem}: não existe (rode a etapa de render antes)')
        continue
    dst.mkdir(parents=True, exist_ok=True)
    feitas = puladas = 0
    for arquivo in sorted(src.glob('*.webp')):
        saida = dst / arquivo.name
        if not force and saida.exists() and saida.stat().st_mtime >= arquivo.stat().st_mtime:
            puladas += 1
            continue
        with Image.open(arquivo) as imagem:
            imagem = imagem.convert('RGBA')
            altura = round(imagem.height * largura / imagem.width)
            imagem.resize((largura, altura), Image.LANCZOS).save(saida, 'WEBP', quality=80, method=4)
        feitas += 1
    print(f'{destino}: {feitas} geradas, {puladas} já existiam')
