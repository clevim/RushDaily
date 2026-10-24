#!/usr/bin/env python3
"""Recorta o fundo preto dos logos em PNG transparente.

Uso: python3 tools/cutout.py entrada.png saida.png [--furos]

--furos: também limpa regiões pretas fechadas (ex.: o miolo do R no emblema).

Só o fundo ligado às bordas vira transparente (o preto dentro das cartas fica).
Na faixa de transição usa "color to alpha" contra preto: brilho e antialias
ficam sem franja escura. Requer Pillow, numpy e scipy.
"""
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

source, target = sys.argv[1], sys.argv[2]
rgb = np.asarray(Image.open(source).convert('RGB')).astype(np.float32) / 255
bg = np.median(np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]]), axis=0)
distance = np.abs(rgb - bg).max(axis=2)

# Região de fundo: pixels próximos da cor da borda e conectados a ela.
near = distance < 0.10
labels, _ = ndimage.label(near)
edge_labels = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
background = near if '--furos' in sys.argv else np.isin(labels, edge_labels[edge_labels > 0])
# Faixa de transição: alguns pixels em volta do fundo ganham alfa suave.
band = ndimage.binary_dilation(background, iterations=3) & ~background

alpha = np.ones(distance.shape, np.float32)
alpha[background] = 0
soft = np.clip(distance / 0.35, 0, 1)
alpha[band] = soft[band]

# Desfaz a mistura com o preto na borda (cor = (c - bg*(1-a)) / a).
safe = np.maximum(alpha, 1e-3)[..., None]
color = np.clip((rgb - bg * (1 - safe)) / safe, 0, 1)
out = np.dstack([color, alpha])
image = Image.fromarray((out * 255).round().astype(np.uint8), 'RGBA')
image.crop(image.getbbox()).save(target, optimize=True)
print(target, image.crop(image.getbbox()).size)
