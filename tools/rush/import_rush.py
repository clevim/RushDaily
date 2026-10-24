#!/usr/bin/env python3
"""Monta o pool do Rush Duel para o motor do EDOPro (ocgcore), a partir do BabelCDB e do CardScripts.

  python3 -I tools/rush/import_rush.py fetch   # baixa cards-rush.cdb (BabelCDB) e os scripts Rush (CardScripts) para cache/
  python3 -I tools/rush/import_rush.py build   # escreve src/data/rush/cards.json e copia os scripts para src/vendor/card-scripts/rush/

Dados de regra vêm do cards-rush.cdb (o motor lê esses números). Nome e texto em PT-BR vêm de
tools/card-render/pt-br.json (traduções do desafio diário), casados pelo nome em inglês; sem tradução, fica o inglês.
"""
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = HERE / 'cache'
CDB = CACHE / 'cards-rush.cdb'
SCRIPTS = CACHE / 'CardScripts'
OUT = ROOT / 'src' / 'data' / 'rush'
SCRIPTS_OUT = ROOT / 'src' / 'vendor' / 'card-scripts'
PT = ROOT / 'tools' / 'card-render' / 'pt-br.json'
POOL_EN = ROOT / 'tools' / 'card-render' / 'pool-en.json'
CDB_URL = 'https://raw.githubusercontent.com/ProjectIgnis/BabelCDB/master/cards-rush.cdb'
UA = 'RushDaily/0.2 (projeto pessoal, sem fins comerciais)'

TYPE_MONSTER = 0x1
TYPE_NORMAL = 0x10
TYPE_TOKEN = 0x4000
TYPE_MAXIMUM = 0x8000
TYPE_SKILL = 0x8000000
OT_LEGEND = 0x400  # escopo "Lenda" do EDOPro (Card.IsLegend no proc_rush.lua usa a mesma ideia)
OT_HIDDEN = 0x1000  # cartas de teste/escondidas do BabelCDB
# Nome do pool do desafio diário (yaml-yugi) -> nome no BabelCDB, quando a tradução oficial em inglês mudou.
NOMES_EN = {
    'Hydro Sword Yoshimitsu Goblin Shark': 'Surging-Wave Swordsman Yoshimitsu Shark',
    'Grandmaster Bathynomus': 'Groundmaster Bathynomus',
    'Heartless Hound Apex Katana Danbiramatian': 'Mean Mutt Apex Katana Danbiramatian',
    'Heartless Hound Striking Kai Ken Knuckle': 'Mean Mutt Striking Kai Ken Knuckle',
}


def fetch_url(url, target):
    tmp = target.with_suffix(target.suffix + '.tmp')
    for attempt in range(4):
        result = subprocess.run(['curl', '--proto', '=https', '--max-filesize', '100M', '-sfL', '-m', '600', '-A', UA, '-o', str(tmp), url])
        if result.returncode == 0 and tmp.exists() and tmp.stat().st_size:
            tmp.replace(target)
            return
        time.sleep(3 + attempt * 5)
    raise RuntimeError(f'falhou: {url}')


def fetch():
    CACHE.mkdir(exist_ok=True)
    fetch_url(CDB_URL, CDB)
    # Mesmo commit fixo do clássico (tools/classic/CARDSCRIPTS_SHA); clone sparse só com rush/ e os .lua da raiz.
    sha = (ROOT / 'tools' / 'classic' / 'CARDSCRIPTS_SHA').read_text().strip()
    git = lambda *a, **k: subprocess.run(['git', '-C', str(SCRIPTS), *a], **k)
    if not (SCRIPTS / '.git').exists():
        subprocess.run(['git', 'init', '-q', str(SCRIPTS)], check=True)
        git('remote', 'add', 'origin', 'https://github.com/ProjectIgnis/CardScripts.git', check=True)
    git('sparse-checkout', 'set', 'rush', check=True)
    if git('cat-file', '-e', sha, capture_output=True).returncode:
        git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', sha, check=True)
    git('checkout', '-q', '--force', '--detach', sha, check=True)
    print('cache pronto em', CACHE, '|', sum(1 for _ in (SCRIPTS / 'rush').glob('c*.lua')), 'scripts Rush')


def norm(name):
    """Nome em inglês comparável: sem o sufixo " (Rush)" do BabelCDB, aspas e caixa."""
    name = re.sub(r'\s*\(Rush\)$', '', name or '')
    return re.sub(r'[^a-z0-9]+', ' ', name.lower().replace('’', "'")).strip()


def translations():
    """nome em inglês normalizado -> {name, desc} em PT (pt-br.json é indexado pelo id da Konami do pool-en.json)."""
    if not PT.exists() or not POOL_EN.exists():
        return {}
    pt = json.loads(PT.read_text())
    out = {}
    for card in json.loads(POOL_EN.read_text()):
        local = pt.get(str(card['id']))
        if local and local.get('name'):
            out[norm(NOMES_EN.get(card['en'], card['en']))] = local
    return out


def maximum_piece(name, kind):
    """Peças do Máximo: [L] e [R] são as laterais; a do meio (sem marca) é a que fica no campo."""
    if not kind & TYPE_MAXIMUM:
        return None
    return 'L' if name.endswith('[L]') else 'R' if name.endswith('[R]') else 'C'


def trim(texts):
    while texts and not texts[-1]:
        texts = texts[:-1]
    return texts


def build():
    db = sqlite3.connect(CDB)
    rows = {row[0]: row for row in db.execute('select id, ot, alias, setcode, type, atk, def, level, race, attribute from datas')}
    texts = {row[0]: row[1:] for row in db.execute(f"select id, name, desc, {', '.join(f'str{i}' for i in range(1, 17))} from texts")}
    scripts = {int(path.stem[1:]) for path in (SCRIPTS / 'rush').glob('c*.lua')}
    pt = translations()

    cards = []
    skipped = {'sem tipo/escondida': 0, 'ficha/skill': 0, 'arte alternativa': 0, 'sem script': 0}
    for cid, (_, ot, alias, setcode, kind, atk, defense, level, race, attribute) in sorted(rows.items()):
        if not kind or ot & OT_HIDDEN:
            skipped['sem tipo/escondida'] += 1
            continue
        if kind & (TYPE_TOKEN | TYPE_SKILL):
            skipped['ficha/skill'] += 1
            continue
        # Reimpressão com código próprio que aponta para outra carta Rush: fica só a original.
        if alias and alias in rows:
            skipped['arte alternativa'] += 1
            continue
        # Monstro Normal não tem script; qualquer outra carta precisa do dela.
        if cid not in scripts and not (kind & TYPE_NORMAL and kind & TYPE_MONSTER):
            skipped['sem script'] += 1
            continue
        name, desc, *strings = texts.get(cid, ('', '') + ('',) * 16)
        name_en = re.sub(r'\s*\(Rush\)$', '', name or '')
        local = pt.get(norm(name_en), {})
        cards.append({
            'id': cid, 'alias': alias, 'setcode': str(setcode), 'type': kind, 'atk': atk, 'def': defense,
            'level': level, 'race': race, 'attribute': attribute,
            'name': local.get('name') or name_en, 'nameEn': name_en,
            'desc': local.get('desc') or (desc or '').replace('\r\n', '\n'), 'pt': bool(local.get('desc')),
            **({'legend': True} if ot & OT_LEGEND else {}),
            **({'maximum': piece} if (piece := maximum_piece(name_en, kind)) else {}),
            **({'strings': trimmed} if (trimmed := trim([s or '' for s in strings])) else {}),
        })

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'cards.json').write_text(json.dumps(cards, ensure_ascii=False, separators=(',', ':')))

    # Scripts: rush/cNNN.lua das cartas do pool + os utilitários da raiz (os mesmos do clássico, mesmo commit).
    rush_out = SCRIPTS_OUT / 'rush'
    if rush_out.exists():
        shutil.rmtree(rush_out)
    rush_out.mkdir(parents=True)
    copied = 0
    for card in cards:
        source = SCRIPTS / 'rush' / f'c{card["id"]}.lua'
        if source.exists():
            shutil.copy2(source, rush_out / source.name)
            copied += 1
    root_lua = sorted(path.name for path in SCRIPTS.glob('*.lua'))
    for name in root_lua:
        shutil.copy2(SCRIPTS / name, SCRIPTS_OUT / name)  # mesmo commit do clássico: conteúdo idêntico
    for target in (SCRIPTS_OUT / 'COPYING', rush_out / 'COPYING'):
        shutil.copy2(SCRIPTS / 'COPYING', target)
    # O navegador pré-carrega os utilitários da raiz antes do duelo (o motor lê scripts de forma síncrona).
    (rush_out / 'index.json').write_text(json.dumps(root_lua))
    if not (SCRIPTS_OUT / 'index.json').exists():
        (SCRIPTS_OUT / 'index.json').write_text(json.dumps(root_lua))

    from collections import Counter
    monsters = [c for c in cards if c['type'] & TYPE_MONSTER]
    kinds = Counter('monstro' if c['type'] & TYPE_MONSTER else 'magia' if c['type'] & 0x2 else 'armadilha' for c in cards)
    print(f"{len(cards)} cartas ({dict(kinds)}) | Normais {sum(1 for c in monsters if c['type'] & TYPE_NORMAL)} | "
          f"Fusão {sum(1 for c in monsters if c['type'] & 0x40)} | Lenda {sum(1 for c in cards if c.get('legend'))} | "
          f"peças de Máximo {sum(1 for c in cards if c.get('maximum'))}")
    print(f"em PT: {sum(c['pt'] for c in cards)} de {len(cards)} | ignoradas: {skipped} | scripts copiados: {copied} | utilitários: {len(root_lua)}")


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    if command == 'fetch':
        fetch()
    elif command == 'build':
        build()
    else:
        print(__doc__)
