#!/usr/bin/env python3
"""Monta o pool do Rush Duel para o motor do EDOPro (ocgcore), a partir do BabelCDB e do CardScripts.

  python3 -I tools/rush/import_rush.py fetch   # baixa cards-rush.cdb (BabelCDB) e os scripts Rush (CardScripts) para cache/
  python3 -I tools/rush/import_rush.py build   # escreve src/data/rush/cards.json e copia os scripts para src/vendor/card-scripts/rush/
  python3 -I tools/rush/import_rush.py art [--force] [id ...]   # baixa as artes do Yugipedia -> src/assets/rush-art/<id>.webp

Dados de regra vêm do cards-rush.cdb (o motor lê esses números). Nome e texto em PT-BR vêm de
tools/card-render/pt-br.json (traduções do desafio diário), casados pelo nome em inglês, e depois da memória de tradução
em tools/rush/traducao/ (nomes.json e frases.json, ver traducao.py); sem tradução completa, fica o inglês.
"""
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
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
# Artes: yaml-yugi (nomes dos arquivos do Yugipedia) e o CDN do Yugipedia; nada disso vai para o git.
RUSH_JSON = CACHE / 'rush.json'
RUSH_JSON_URL = 'https://raw.githubusercontent.com/DawnbrandBots/yaml-yugi/aggregate/rush.json'
ART_SOURCES = CACHE / 'art-sources.json'
ART_OUT = ROOT / 'src' / 'assets' / 'rush-art'
ART_PX = 400  # a janela de arte do RushDuelCard é ~376x377 na escala 0.3
ART_PATTERNS = ['-OW-RD.png', '-DBR-JP-VG-artwork.png', '-G002-JP-VG-artwork.png', '-MADU-EN-VG-artwork.png', '-OW.png', '-TF05-JP-VG-artwork.png']  # padrões de arte limpa do Yugipedia
SKIP_ART = {'WarriorofZera-OW-RD.png'}  # arte com marca d'água
SCAN_BOX = (22 / 421, 61 / 614, 376 / 421, 380 / 614)  # janela de arte no scan (x, y, largura, altura), como no render.py
MIN_INTERVAL = 0.35  # segundos entre pedidos ao Yugipedia (~3 por segundo, somando os dois downloads em paralelo)
RACES_EN = ['Warrior', 'Spellcaster', 'Fairy', 'Fiend', 'Zombie', 'Machine', 'Aqua', 'Pyro', 'Rock', 'Winged Beast', 'Plant', 'Insect',
            'Thunder', 'Dragon', 'Beast', 'Beast-Warrior', 'Dinosaur', 'Fish', 'Sea Serpent', 'Reptile', 'Psychic', 'Divine-Beast',
            'Creator God', 'Wyrm', 'Cyberse', 'Illusion', 'Cyborg', 'Magical Knight', 'High Dragon', 'Omega Psychic', 'Celestial Warrior', 'Galaxy']
ATTRIBUTES_EN = {'EARTH': 1, 'WATER': 2, 'FIRE': 4, 'WIND': 8, 'LIGHT': 16, 'DARK': 32, 'DIVINE': 64}

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


def pool(skipped=None):
    """Cartas do pool, em inglês, como saem do cards-rush.cdb: (id, ot, alias, setcode, type, atk, def, level, race,
    attribute, nome sem " (Rush)", desc, strings). Também usado pelo traducao.py."""
    db = sqlite3.connect(CDB)
    rows = {row[0]: row for row in db.execute('select id, ot, alias, setcode, type, atk, def, level, race, attribute from datas')}
    texts = {row[0]: row[1:] for row in db.execute(f"select id, name, desc, {', '.join(f'str{i}' for i in range(1, 17))} from texts")}
    scripts = {int(path.stem[1:]) for path in (SCRIPTS / 'rush').glob('c*.lua')}
    skipped = {} if skipped is None else skipped
    for key in ('sem tipo/escondida', 'ficha/skill', 'arte alternativa', 'sem script'):
        skipped.setdefault(key, 0)
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
        yield cid, ot, alias, setcode, kind, atk, defense, level, race, attribute, name_en, (desc or '').replace('\r\n', '\n'), strings


def traducao():
    """tools/rush/traducao.py carregado pelo caminho (o -I tira a pasta do script do sys.path)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('traducao', HERE / 'traducao.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build():
    pt = translations()
    memoria = traducao().Memoria()

    cards = []
    skipped = {}
    for cid, ot, alias, setcode, kind, atk, defense, level, race, attribute, name_en, desc, strings in pool(skipped):
        # Manual (pt-br.json) primeiro; senão a memória de tradução, só com a carta inteira traduzida (nunca meio a meio).
        local = pt.get(norm(name_en), {})
        if not local.get('desc') and (traduzida := memoria.carta(name_en, desc)):
            local = {**traduzida, 'name': local.get('name') or traduzida['name']}
        cards.append({
            'id': cid, 'alias': alias, 'setcode': str(setcode), 'type': kind, 'atk': atk, 'def': defense,
            'level': level, 'race': race, 'attribute': attribute,
            'name': local.get('name') or name_en, 'nameEn': name_en,
            'desc': local.get('desc') or desc, 'pt': bool(local.get('desc')),
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


# ---- artes ----
_last_request = [0.0]
_failures = [0]
_lock = threading.Lock()


def yugipedia_get(url):
    """GET no Yugipedia via curl (só HTTPS, inclusive nos redirecionamentos), espaçado por MIN_INTERVAL entre todos os pedidos.
    404/403 não repetem; muitas falhas seguidas param tudo (site fora do ar ou bloqueando)."""
    for attempt in range(4):
        with _lock:
            wait = _last_request[0] + MIN_INTERVAL - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            _last_request[0] = time.monotonic()
        result = subprocess.run(['curl', '--proto', '=https', '--proto-redir', '=https', '--max-filesize', '30M', '-sSfL', '-m', '120', '-A', UA, url], capture_output=True)
        if result.returncode == 0 and result.stdout:
            _failures[0] = 0
            return result.stdout
        if result.returncode == 22 and re.search(rb'\b(403|404|410)\b', result.stderr):
            break
        time.sleep(2 + attempt * 3)
    with _lock:
        _failures[0] += 1
        if _failures[0] >= 15:
            print('ERRO: 15 pedidos seguidos ao Yugipedia falharam (fora do ar ou bloqueado). Rode de novo mais tarde: o que já baixou fica.', flush=True)
            write_art_index()
            os._exit(3)  # o setup segue sem as artes (etapa rush-art)
    return None


def cdn(filename):
    """O CDN do Yugipedia guarda o arquivo num caminho pelo md5 do nome (o mesmo do render.py)."""
    digest = hashlib.md5(filename.encode()).hexdigest()
    return f'https://ms.yugipedia.com//{digest[0]}/{digest[:2]}/{urllib.parse.quote(filename)}'


def yaml_key(card):
    """Chave de atributos de um monstro do yaml-yugi: (ATK, DEF, nível, atributo, tipo) no formato do EDOPro."""
    race = (card.get('monster_type_line') or '').split(' /')[0]
    if card.get('card_type') != 'Monster' or race not in RACES_EN:
        return None
    return (card.get('atk'), card.get('def'), card.get('level'), ATTRIBUTES_EN.get(card.get('attribute')), 1 << RACES_EN.index(race))


def cdb_key(card):
    if not card['type'] & TYPE_MONSTER:
        return None
    stat = lambda value: '?' if value < 0 else value
    return (stat(card['atk']), stat(card['def']), card['level'], card['attribute'], card['race'])


def cdb_kind(card):
    return 'Monster' if card['type'] & TYPE_MONSTER else 'Spell' if card['type'] & 0x2 else 'Trap'


def match_yaml(cards, yaml):
    """id do EDOPro -> carta do yaml-yugi. O BabelCDB e o Yugipedia traduzem nomes de cartas só japonesas de jeitos
    diferentes, então: 1) nome em inglês; 2) monstros com ATK/DEF/nível/atributo/tipo únicos dos dois lados;
    3) Magias/Armadilhas pelo nome mais parecido (>= 0.85, sem empate)."""
    by_name = {}
    for entry in yaml:
        name = (entry.get('name') or {}).get('en')
        if name:
            by_name.setdefault(norm(name), entry)
    renamed = {norm(babel): norm(pool) for pool, babel in NOMES_EN.items()}
    found = {}
    for card in cards:
        key = norm(card['nameEn'])
        entry = by_name.get(key) or by_name.get(renamed.get(key, ''))
        if entry:
            found[card['id']] = entry
    used = {id(entry) for entry in found.values()}
    free = [entry for entry in yaml if id(entry) not in used]
    yaml_keys, cdb_keys = {}, {}
    for entry in free:
        if (key := yaml_key(entry)) is not None:
            yaml_keys.setdefault(key, []).append(entry)
    for card in cards:
        if card['id'] not in found and (key := cdb_key(card)) is not None:
            cdb_keys.setdefault(key, []).append(card)
    for key, group in cdb_keys.items():
        if len(group) == 1 and len(yaml_keys.get(key, [])) == 1:
            found[group[0]['id']] = yaml_keys[key][0]
            used.add(id(yaml_keys[key][0]))
    spells = [entry for entry in yaml if id(entry) not in used and entry.get('card_type') in ('Spell', 'Trap') and (entry.get('name') or {}).get('en')]
    for card in cards:
        if card['id'] in found or card['type'] & TYPE_MONSTER:
            continue
        scores = sorted(((SequenceMatcher(None, norm(card['nameEn']), norm(entry['name']['en'])).ratio(), i) for i, entry in enumerate(spells) if entry['card_type'] == cdb_kind(card)), reverse=True)
        if scores and scores[0][0] >= 0.85 and (len(scores) == 1 or scores[1][0] < scores[0][0]) and id(spells[scores[0][1]]) not in used:
            found[card['id']] = spells[scores[0][1]]
            used.add(id(spells[scores[0][1]]))
    return found


def check_files(names, known):
    """Quais arquivos existem no Yugipedia (API em lotes de 50; resultado guardado em art-sources.json)."""
    names = [name for name in dict.fromkeys(names) if name not in known]
    for start in range(0, len(names), 50):
        chunk = names[start:start + 50]
        for name in chunk:
            known[name] = False
        query = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'prop': 'imageinfo', 'iiprop': 'size', 'titles': '|'.join(f'File:{name}' for name in chunk)})
        body = yugipedia_get(f'https://yugipedia.com/api.php?{query}')
        if body is None:
            continue
        for page in json.loads(body).get('query', {}).get('pages', {}).values():
            info = page.get('imageinfo')
            if info and info[0].get('width', 0) >= 300:
                known[page['title'].removeprefix('File:').replace(' ', '_')] = True
        print(f'artes limpas conferidas: {min(start + 50, len(names))}/{len(names)}', flush=True)


def page_images(titles, known):
    """Cartas fora do yaml-yugi: imagem principal da página "<nome> (Rush Duel)" ou "<nome>" (só se for scan de coleção Rush)."""
    titles = [title for title in dict.fromkeys(titles) if title not in known]
    for start in range(0, len(titles), 50):
        chunk = titles[start:start + 50]
        for title in chunk:
            known[title] = None
        query = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'redirects': 1, 'prop': 'pageimages', 'piprop': 'name', 'titles': '|'.join(chunk)})
        body = yugipedia_get(f'https://yugipedia.com/api.php?{query}')
        if body is None:
            continue
        data = json.loads(body).get('query', {})
        alias = {item['from']: item['to'] for key in ('normalized', 'redirects') for item in data.get(key, [])}
        images = {page.get('title'): page.get('pageimage') for page in data.get('pages', {}).values()}
        for title in chunk:
            final = alias.get(alias.get(title, title), alias.get(title, title))
            image = images.get(final)
            if image and re.search(r'-RD[A-Z0-9]+-', image):  # scan de coleção Rush (RD/...), nunca a carta do OCG/TCG
                known[title] = image
        print(f'páginas conferidas: {min(start + 50, len(titles))}/{len(titles)}', flush=True)


def art_source(card, entry, sources):
    """(arquivo no Yugipedia, recortar do scan?) ou None."""
    if entry:
        image = (entry.get('images') or [{}])[0]
        clean = image.get('illustration')
        if clean and clean not in SKIP_ART:
            return clean, False
        if image.get('image'):
            prefix = image['image'].split('-')[0]
            for suffix in ART_PATTERNS:
                if sources['files'].get(prefix + suffix):
                    return prefix + suffix, False
            return image['image'], True
    for title in (f"{card['nameEn']} (Rush Duel)", card['nameEn']):
        if sources['pages'].get(title):
            return sources['pages'][title], True
    return None


def to_webp(raw, crop, target):
    import io
    from PIL import Image
    with Image.open(io.BytesIO(raw)) as image:
        image = image.convert('RGB')
        if crop:
            x, y, w, h = SCAN_BOX
            image = image.crop((round(x * image.width), round(y * image.height), round((x + w) * image.width), round((y + h) * image.height)))
        else:  # arte limpa: recorte central quadrado (a moldura usa "cover")
            side = min(image.width, image.height)
            left, top = (image.width - side) // 2, (image.height - side) // 2
            image = image.crop((left, top, left + side, top + side))
        tmp = target.with_suffix('.tmp')
        image.resize((ART_PX, ART_PX), Image.LANCZOS).save(tmp, 'WEBP', quality=76, method=6)
        tmp.replace(target)


def write_art_index():
    """Lista dos ids com arte: o navegador (rush-render.js) só pede as que existem."""
    ids = sorted(int(path.stem) for path in ART_OUT.glob('*.webp') if path.stem.isdigit())
    (ART_OUT / 'index.json').write_text(json.dumps(ids, separators=(',', ':')))
    return ids


def art(args):
    force = '--force' in args
    only = {int(arg) for arg in args if arg.isdigit()}
    cards = json.loads((OUT / 'cards.json').read_text())
    if only:
        cards = [card for card in cards if card['id'] in only]
    CACHE.mkdir(exist_ok=True)
    if not RUSH_JSON.exists():
        fetch_url(RUSH_JSON_URL, RUSH_JSON)
    yaml = json.loads(RUSH_JSON.read_text())
    sources = json.loads(ART_SOURCES.read_text()) if ART_SOURCES.exists() and not force else {'files': {}, 'pages': {}}
    found = match_yaml(json.loads((OUT / 'cards.json').read_text()), yaml)
    ART_OUT.mkdir(parents=True, exist_ok=True)
    todo = [card for card in cards if force or not (ART_OUT / f"{card['id']}.webp").exists()]
    print(f"{len(cards)} cartas | {sum(1 for card in cards if card['id'] in found)} casadas com o yaml-yugi | faltam {len(todo)} artes", flush=True)

    # Descobre as fontes (lotes na API, guardados em cache para a próxima vez).
    candidates = []
    for card in todo:
        image = ((found.get(card['id']) or {}).get('images') or [{}])[0]
        if image.get('image') and not image.get('illustration'):
            candidates += [image['image'].split('-')[0] + suffix for suffix in ART_PATTERNS if image['image'].split('-')[0] + suffix not in SKIP_ART]
    check_files(candidates, sources['files'])
    page_images([title for card in todo if card['id'] not in found for title in (f"{card['nameEn']} (Rush Duel)", card['nameEn'])], sources['pages'])
    ART_SOURCES.write_text(json.dumps(sources, ensure_ascii=False))

    jobs = [(card, source) for card in todo if (source := art_source(card, found.get(card['id']), sources))]
    without = len(todo) - len(jobs)
    done, failed = [0], []

    def work(job):
        card, (filename, crop) = job
        raw = yugipedia_get(cdn(filename))
        try:
            if raw is None:
                raise ValueError('download falhou')
            to_webp(raw, crop, ART_OUT / f"{card['id']}.webp")
        except Exception as error:  # imagem corrompida ou indisponível: segue com as outras
            failed.append(f"{card['id']} {filename}: {error}")
        done[0] += 1
        if done[0] % 25 == 0 or done[0] == len(jobs):
            print(f'{done[0]}/{len(jobs)}', flush=True)

    with ThreadPoolExecutor(2) as workers:
        list(workers.map(work, jobs))
    for line in failed[:20]:
        print('falhou:', line)
    ids = write_art_index()
    total = len(json.loads((OUT / 'cards.json').read_text()))
    print(f'artes: {len(ids)} de {total} | baixadas agora {len(jobs) - len(failed)} | falharam {len(failed)} | sem fonte {without} -> {ART_OUT}')


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    if command == 'fetch':
        fetch()
    elif command == 'build':
        build()
    elif command == 'art':
        art(sys.argv[2:])
    else:
        print(__doc__)
