#!/usr/bin/env python3
"""Converte o Enigma do Milênio em STL (39 arquivos já na posição de montagem) para o formato do jogo.

Uso: python3 tools/puzzle/build_puzzle.py <pasta-com-os-stl> src/assets/puzzle

Modelo: "Yu-Gi-Oh! Millennium Puzzle Remix" por TechSpiderbot (Printables 517699), CC BY-NC-SA,
remix do enigma de Sho Tozuka. Uso pessoal e não comercial, com crédito na página do Enigma.

Saída:
  puzzle.bin  Int16 x,y,z por vértice (triângulos soltos), todas as peças em sequência
  puzzle.json escala e início/contagem de cada peça (38) e da argola
As 38 partes da pirâmide são as 38 peças do jogo.
A argola com o miolo (_00) é simplificada (fast-simplification) e só aparece com o enigma completo.
"""
import json
import struct
import sys
from pathlib import Path

import numpy as np

GAME_PIECES = 38  # uma peça do jogo por parte real do modelo


def simplify(vertices, keep=0.12):
    """Decimação de malha (quádricas) da argola com o miolo: 40k triângulos -> ~5k, sem furos.
    Requer o pacote fast-simplification; sem ele, mantém a malha inteira."""
    try:
        import fast_simplification
    except ImportError:
        return vertices
    points, faces = np.unique(np.round(vertices, 4), axis=0, return_inverse=True)
    faces = faces.reshape(-1, 3)
    points, faces = fast_simplification.simplify(points.astype(np.float32), faces.astype(np.int32), target_reduction=1 - keep)
    return points[faces].reshape(-1, 3).astype(np.float64)


def read_stl(path):
    data = path.read_bytes()
    count = struct.unpack_from('<I', data, 80)[0]
    records = np.frombuffer(data, dtype=np.dtype([('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')]), count=count, offset=84)
    return records['v'].reshape(-1, 3).astype(np.float64)  # 3 vértices por triângulo


def main(source, out):
    source, out = Path(source), Path(out)
    parts = {}
    for path in sorted(source.glob('*.stl')):
        stem = path.stem.split('_')[-1] if not path.stem.endswith('v2') else None
        if stem is None:
            continue  # usa as peças originais (as _v2 vêm fora da posição de montagem)
        parts[int(stem)] = read_stl(path)
    ring = parts.pop(0)
    everything = np.vstack(list(parts.values()) + [ring])
    lo, hi = everything.min(0), everything.max(0)
    center = (lo + hi) / 2
    size = (hi - lo).max()

    def to_game(vertices):
        # mm, Z para cima -> unidades do jogo, Y para cima, ponta da pirâmide para baixo, centro na origem
        v = (vertices - center) / size * 3.2
        return np.stack([v[:, 0], v[:, 2], -v[:, 1]], axis=1)

    pieces = [{'parts': [index], 'verts': to_game(vertices)} for index, vertices in parts.items()]
    while len(pieces) > GAME_PIECES:
        pieces.sort(key=lambda piece: len(piece['verts']))
        small = pieces.pop(0)
        centroid = small['verts'].mean(0)
        nearest = min(pieces, key=lambda piece: np.linalg.norm(piece['verts'].mean(0) - centroid))
        nearest['parts'] += small['parts']
        nearest['verts'] = np.vstack([nearest['verts'], small['verts']])
    # Ordem de montagem: de baixo (ponta) para cima, como se monta o enigma de verdade.
    pieces.sort(key=lambda piece: piece['verts'][:, 1].mean())
    ring_verts = to_game(simplify(ring))

    all_verts = [piece['verts'] for piece in pieces] + [ring_verts]
    extent = max(np.abs(v).max() for v in all_verts)
    quant = 32767 / extent
    blobs, meta, offset = [], {'scale': 1 / quant, 'pieces': [], 'credit': 'Millennium Puzzle Remix por TechSpiderbot (Printables 517699), CC BY-NC-SA, a partir do enigma de Sho Tozuka'}, 0
    for piece in pieces:
        blobs.append(np.round(piece['verts'] * quant).astype('<i2').tobytes())
        meta['pieces'].append({'start': offset, 'count': len(piece['verts']), 'parts': sorted(piece['parts']), 'center': [round(float(c), 4) for c in piece['verts'].mean(0)]})
        offset += len(piece['verts'])
    blobs.append(np.round(ring_verts * quant).astype('<i2').tobytes())
    meta['ring'] = {'start': offset, 'count': len(ring_verts)}
    # Forma da pirâmide para o shader de profundidade: ponta, topo e meia-largura no topo.
    body = np.vstack([piece['verts'] for piece in pieces])
    meta['shape'] = {'apex': round(float(body[:, 1].min()), 4), 'top': round(float(body[:, 1].max()), 4), 'half': round(float(np.abs(body[:, [0, 2]]).max()), 4)}
    out.mkdir(parents=True, exist_ok=True)
    (out / 'puzzle.bin').write_bytes(b''.join(blobs))
    (out / 'puzzle.json').write_text(json.dumps(meta, indent=1))
    eye = next(index for index, piece in enumerate(pieces) if 38 in piece['parts'])
    print(f"{len(pieces)} peças, {offset // 3} triângulos + argola {len(ring_verts) // 3}; olho na peça {eye}; {(out / 'puzzle.bin').stat().st_size // 1024} KB")


if __name__ == '__main__':
    main(*sys.argv[1:3])
