"""Gera os versos com o emblema (logo-mark.png) embutido em base64.

Uso: python3 tools/card-render/back.py src/assets [feltro|rubi|safira]
feltro -> card-back.svg (padrão do jogo); rubi/safira -> card-back-<tema>.svg (cartas de booster). Uso: python3 tools/card-render/back.py src/assets"""
import math
import re
import sys
from pathlib import Path

assets = Path(sys.argv[1])
THEMES = {
    'feltro': ('#1D4A40', '#0F2A25', '#050B0A', 'card-back.svg'),
    'rubi': ('#5A1420', '#2A0A10', '#0A0305', 'card-back-rubi.svg'),
    'safira': ('#16346A', '#0B1A3A', '#03060F', 'card-back-safira.svg'),
}
center_hi, center_mid, edge, out_name = THEMES[sys.argv[2] if len(sys.argv) > 2 else 'feltro']
import base64
from PIL import Image
mark_png = assets / 'logo-mark.png'
vw, vh = Image.open(mark_png).size
mark_uri = 'data:image/png;base64,' + base64.b64encode(mark_png.read_bytes()).decode()

W, H = 421, 614


def chamfer(x, y, w, h, c):
    return f'M{x + c} {y}H{x + w - c}L{x + w} {y + c}V{y + h - c}L{x + w - c} {y + h}H{x + c}L{x} {y + h - c}V{y + c}Z'


rays = ''.join(f'<path d="M210.5 300 L{210.5 + 420 * math.cos(math.radians(a - 1.1)):.1f} {300 + 420 * math.sin(math.radians(a - 1.1)):.1f} L{210.5 + 420 * math.cos(math.radians(a + 1.1)):.1f} {300 + 420 * math.sin(math.radians(a + 1.1)):.1f}Z"/>' for a in range(0, 360, 10))
rings = ''.join(f'<circle cx="210.5" cy="300" r="{r}" stroke-opacity="{o}"/>' for r, o in ((88, .55), (104, .28), (148, .18), (176, .1)))
ticks = ''.join(f'<path d="M210.5 {300 - 112}v-9" transform="rotate({a} 210.5 300)"/>' for a in range(0, 360, 15))
ew = 196
eh = ew * vh / vw

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">
  <defs>
    <linearGradient id="cb-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFE7A0"/><stop offset=".28" stop-color="#E9A51C"/><stop offset=".55" stop-color="#8E560C"/><stop offset=".78" stop-color="#F3B62A"/><stop offset="1" stop-color="#7A4708"/>
    </linearGradient>
    <radialGradient id="cb-felt" cx=".5" cy=".49" r=".72">
      <stop offset="0" stop-color="{center_hi}"/><stop offset=".45" stop-color="{center_mid}"/><stop offset="1" stop-color="{edge}"/>
    </radialGradient>
    <radialGradient id="cb-glow" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#F7B51D" stop-opacity=".42"/><stop offset="1" stop-color="#F7B51D" stop-opacity="0"/>
    </radialGradient>
    <pattern id="cb-weave" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <path d="M0 0V7" stroke="#000" stroke-opacity=".22" stroke-width="2"/>
    </pattern>
    <clipPath id="cb-field"><path d="{chamfer(30, 30, W - 60, H - 60, 22)}"/></clipPath>
  </defs>
  <rect width="{W}" height="{H}" rx="16" fill="#0A0807"/>
  <path d="{chamfer(12, 12, W - 24, H - 24, 30)}" fill="url(#cb-gold)"/>
  <path d="{chamfer(20, 20, W - 40, H - 40, 26)}" fill="#0A0807"/>
  <path d="{chamfer(26, 26, W - 52, H - 52, 24)}" fill="none" stroke="url(#cb-gold)" stroke-width="2"/>
  <g clip-path="url(#cb-field)">
    <rect width="{W}" height="{H}" fill="url(#cb-felt)"/>
    <rect width="{W}" height="{H}" fill="url(#cb-weave)"/>
    <g fill="#F7B51D" fill-opacity=".07">{rays}</g>
    <circle cx="210.5" cy="300" r="170" fill="url(#cb-glow)"/>
    <g fill="none" stroke="#F3B62A" stroke-width="1.4">{rings}</g>
    <g stroke="#F3B62A" stroke-opacity=".6" stroke-width="2">{ticks}</g>
    <path d="M30 96 L120 30 M391 96 L301 30 M30 518 L120 584 M391 518 L301 584" stroke="url(#cb-gold)" stroke-width="3"/>
    <path d="M30 112 L140 30 M391 112 L281 30 M30 502 L140 584 M391 502 L281 584" stroke="#F3B62A" stroke-opacity=".35" stroke-width="1"/>
  </g>
  <image x="{210.5 - ew / 2:.1f}" y="{300 - eh / 2 - 6:.1f}" width="{ew}" height="{eh:.1f}" href="{mark_uri}"/>
  <g fill="url(#cb-gold)">
    <path d="M190 548h41l-6 10h-29z"/>
    <path d="M190 56h41l-6 -10h-29z"/>
  </g>
</svg>
'''
(assets / out_name).write_text(svg)
print('ok', len(svg) // 1024, 'KB')
