#!/usr/bin/env python3
"""Monta o pool clássico do RushDaily, separado por temporada.

  python3 tools/classic/import_cards.py fetch          # baixa YGOPRODeck (en + pt), BabelCDB e CardScripts para cache/
  python3 tools/classic/import_cards.py build [--ate N] # escreve src/data/classic/ e copia os scripts das temporadas 1..N
  python3 tools/classic/import_cards.py art             # baixa as artes recortadas das temporadas ativas (WebP 320px)
  python3 tools/classic/import_cards.py decks           # baixa decks de jogadores (YGOPRODeck) para medir sinergia
  python3 -I tools/classic/import_cards.py puzzles      # baixa os puzzles do EDOPro, confere no motor as soluções conhecidas e grava puzzles.json
  python3 -I tools/classic/import_cards.py puzzles --buscar [--nos 10000] [--meta 35]  # procura vitória nos que faltam até a meta (lento)

Temporada = data do primeiro lançamento (TCG ou OCG) comparada à estreia de cada mecânica.
Dados de regra vêm do cards.cdb do EDOPro (o motor lê esses números); nome e texto em PT-BR
vêm do YGOPRODeck quando existem, senão ficam em inglês.
"""
import json
import os
import re
import shutil
from concurrent.futures import ThreadPoolExecutor
import sqlite3
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = HERE / 'cache'
OUT = ROOT / 'src' / 'data' / 'classic'
SCRIPTS_OUT = ROOT / 'src' / 'vendor' / 'card-scripts'
ART_OUT = ROOT / 'src' / 'assets' / 'classic-art'
ART_URL = 'https://images.ygoprodeck.com/images/cards_cropped/{}.jpg'  # o YGOPRODeck pede para baixar e hospedar
UA = 'RushDaily/0.2 (projeto pessoal, sem fins comerciais)'
API = 'https://db.ygoprodeck.com/api/v7/cardinfo.php'

# Cada temporada termina na véspera da estreia da mecânica seguinte (datas tiradas dos próprios dados).
SEASONS = [
    (1, 'Duelistas Lendários', '2008-03-15'),  # até o primeiro Sincro
    (2, 'Era Sincro', '2011-03-19'),           # até o primeiro Xyz
    (3, 'Era Xyz', '2014-03-21'),              # até o primeiro Pêndulo
    (4, 'Era Pêndulo', '2017-03-25'),          # até o primeiro Link
    (5, 'Era Link', '9999-12-31'),
]
TYPE_TOKEN = 0x4000
TYPE_NORMAL = 0x10


def fetch_url(url, target):
    for attempt in range(4):
        result = subprocess.run(['curl', '--proto', '=https', '--max-filesize', '100M', '-sfL', '-m', '600', '-A', UA, '-o', str(target), url])
        if result.returncode == 0 and target.exists() and target.stat().st_size:
            return
        time.sleep(3 + attempt * 5)
    raise RuntimeError(f'falhou: {url}')


def fetch():
    CACHE.mkdir(exist_ok=True)
    fetch_url(f'{API}?misc=yes', CACHE / 'ygopro-en.json')
    fetch_url(f'{API}?language=pt', CACHE / 'ygopro-pt.json')
    fetch_url('https://raw.githubusercontent.com/ProjectIgnis/BabelCDB/master/cards.cdb', CACHE / 'cards.cdb')
    scripts = CACHE / 'CardScripts'
    # Commit fixo dos scripts (tools/classic/CARDSCRIPTS_SHA): o master passa a usar constantes que o core compilado não conhece.
    sha = (ROOT / 'tools' / 'classic' / 'CARDSCRIPTS_SHA').read_text().strip()
    if not scripts.exists():
        subprocess.run(['git', 'init', '-q', str(scripts)], check=True)
        subprocess.run(['git', '-C', str(scripts), 'remote', 'add', 'origin', 'https://github.com/ProjectIgnis/CardScripts.git'], check=True)
    if subprocess.run(['git', '-C', str(scripts), 'cat-file', '-e', sha], capture_output=True).returncode:
        subprocess.run(['git', '-C', str(scripts), 'fetch', '-q', '--depth', '1', 'origin', sha], check=True)
    subprocess.run(['git', '-C', str(scripts), 'checkout', '-q', '--detach', sha], check=True)
    print('cache pronto em', CACHE)


def first_release(card):
    misc = (card.get('misc_info') or [{}])[0]
    dates = [d for d in (misc.get('tcg_date'), misc.get('ocg_date')) if d and d > '1990-01-01']
    return min(dates) if dates else None


def rarity_of(card):
    """Raridade da primeira impressão: common | rare | super | ultra | secret (sem impressão: common)."""
    for item in card.get('card_sets') or []:
        name = item['set_rarity'].lower()
        if any(word in name for word in ('ultimate', 'ghost', 'starlight', 'secret', 'platinum', 'prismatic', 'quarter', 'grand master')):
            return 'secret'
        if any(word in name for word in ('ultra', 'gold', 'mosaic', 'shatterfoil', 'starfoil', "collector")):
            return 'ultra'
        if 'short print' in name or 'normal parallel' in name:
            return 'common'
        if 'super' in name:
            return 'super'
        if name.startswith('rare') or name.endswith(' rare'):
            return 'rare'
        if name == 'common':
            return 'common'
    return 'common'


def season_of(date):
    return next(number for number, _, end in SEASONS if date < end)


def synergy(seasons, until):
    """Sinergia aprendida de decks reais: quem aparece junto além do acaso (lift) e moldes de decks inteiros."""
    source = CACHE / 'decks.json'
    if not source.exists():
        print('sem cache/decks.json: rode "decks" para gerar a sinergia')
        return
    import math
    from collections import Counter
    from itertools import combinations

    pool = {card['id'] for n in range(1, until + 1) for card in seasons[n]}
    # Artes alternativas têm código próprio nos decks (ex.: Mago Negro): voltam para o código principal.
    canon = {image['id']: card['id'] for card in json.loads((CACHE / 'ygopro-en.json').read_text())['data'] for image in card.get('card_images', [])}
    decks = json.loads(source.read_text())
    for deck in decks:
        deck['main'] = [canon.get(cid, cid) for cid in deck['main']]
        deck['extra'] = [canon.get(cid, cid) for cid in deck['extra']]
    count, pairs = Counter(), Counter()
    templates = []
    for deck in decks:
        ids = sorted({cid for cid in deck['main'] + deck['extra'] if cid in pool})
        count.update(ids)
        pairs.update(combinations(ids, 2))
        main = [cid for cid in deck['main'] if cid in pool]
        # Molde: deck que cabe quase inteiro na temporada (ex.: Goat para a T1).
        if len(main) >= 0.9 * len(deck['main']) and len(main) >= 20:
            templates.append({'main': main, 'extra': [cid for cid in deck['extra'] if cid in pool], 'format': deck['format']})
    total = len(decks)
    links = {}
    for (a, b), together in pairs.items():
        if together < 3:
            continue
        lift = together * total / (count[a] * count[b])
        if lift <= 1.5:
            continue
        weight = math.log(lift) * min(together, 30) / 30
        links.setdefault(a, []).append((b, weight))
        links.setdefault(b, []).append((a, weight))
    table = {str(cid): [[other, round(w, 2)] for other, w in sorted(found, key=lambda item: -item[1])[:16]] for cid, found in links.items()}
    (OUT / f'synergy-s{until}.json').write_text(json.dumps({'decks': total, 'usage': {str(k): v for k, v in count.items()}, 'links': table}, separators=(',', ':')))
    (OUT / f'templates-s{until}.json').write_text(json.dumps(templates, separators=(',', ':')))
    print(f'sinergia: {total} decks, {len(table)} cartas com parceiras, {len(templates)} moldes')


# Erros de texto que vêm da tradução do YGOPRODeck (errado -> certo). Aplicada ao nome e ao texto de cada carta.
CORRECOES_TEXTO = {'Sntese': 'Síntese', 'Escorpiõão': 'Escorpião'}


def corrigir(texto):
    for errado, certo in CORRECOES_TEXTO.items():
        texto = texto.replace(errado, certo)
    return texto


def ficha_pt(name, desc):
    """Nome e texto em PT da ficha (o cdb só tem inglês): 'X Token' -> 'Ficha X'."""
    nome = 'Ficha ' + re.sub(r'\s*Token$', '', name).strip() if name.endswith('Token') else name
    achou = re.match(r'Special Summoned with the effect of ("[^"]+")', desc or '')
    texto = f'Invocada por Invocação-Especial com o efeito de {achou.group(1)}.' if achou else 'Ficha gerada pelo efeito de uma carta.'
    return nome or 'Ficha', texto


def trim(texts):
    while texts and not texts[-1]:
        texts = texts[:-1]
    return texts


def build(until):
    en = json.loads((CACHE / 'ygopro-en.json').read_text())['data']
    pt = {card['id']: card for card in json.loads((CACHE / 'ygopro-pt.json').read_text())['data']}
    db = sqlite3.connect(CACHE / 'cards.cdb')
    rows = {row[0]: row for row in db.execute('select id, alias, setcode, type, atk, def, level, race, attribute from datas')}
    # str1..str16: rótulos dos efeitos ("Invocar por Especial", "Destruir"...) que o motor manda nas perguntas.
    strings = {row[0]: [text or '' for text in row[1:]] for row in db.execute(f"select id, {', '.join(f'str{i}' for i in range(1, 17))} from texts")}
    scripts = CACHE / 'CardScripts'
    official = {int(path.stem[1:]) for path in (scripts / 'official').glob('c*.lua')}

    seasons = {number: [] for number, *_ in SEASONS}
    skipped = {'sem data': 0, 'fora do TCG/OCG': 0, 'sem dados no cdb': 0, 'sem script': 0}
    for card in en:
        if card['frameType'] in ('skill', 'token'):
            continue
        formats = (card.get('misc_info') or [{}])[0].get('formats') or []
        if not {'TCG', 'OCG'} & set(formats):
            skipped['fora do TCG/OCG'] += 1
            continue
        date = first_release(card)
        if not date:
            skipped['sem data'] += 1
            continue
        row = rows.get(card['id'])
        if not row:
            skipped['sem dados no cdb'] += 1
            continue
        # Monstro Normal sem efeito não tem script; qualquer outra carta precisa do dela.
        if card['id'] not in official and not (row[3] & TYPE_NORMAL and not row[3] & 0x1000000):
            skipped['sem script'] += 1
            continue
        local = pt.get(card['id'], {})
        cid, alias, setcode, kind, atk, defense, level, race, attribute = row
        seasons[season_of(date)].append({
            'id': cid, 'alias': alias, 'setcode': str(setcode), 'type': kind, 'atk': atk, 'def': defense,
            'level': level, 'race': race, 'attribute': attribute,
            'name': corrigir(local.get('name') or card['name']), 'nameEn': card['name'],
            'desc': corrigir(local.get('desc') or card['desc']), 'pt': bool(local),
            'archetype': card.get('archetype'), 'date': date, 'rarity': rarity_of(card),
            'pop': (card.get('misc_info') or [{}])[0].get('views', 0),
            **({'strings': trimmed} if (trimmed := trim(strings.get(cid, []))) else {}),
        })

    OUT.mkdir(parents=True, exist_ok=True)
    for pattern in ('s[0-9]*.json', 'synergy-s*.json', 'templates-s*.json'):
        for old in OUT.glob(pattern):
            old.unlink()
    index = []
    for number, label, end in SEASONS:
        cards = sorted(seasons[number], key=lambda item: item['id'])
        index.append({'season': number, 'label': label, 'until': end, 'count': len(cards), 'pt': sum(c['pt'] for c in cards), 'enabled': number <= until})
        if number <= until:
            (OUT / f's{number}.json').write_text(json.dumps(cards, ensure_ascii=False, separators=(',', ':')))
    # Fichas (tokens) não têm data nem script, mas o motor precisa dos números delas.
    names = {row[0]: (row[1], row[2]) for row in db.execute('select id, name, desc from texts')}
    tokens = [{'id': r[0], 'alias': r[1], 'setcode': str(r[2]), 'type': r[3], 'atk': r[4], 'def': r[5], 'level': r[6], 'race': r[7], 'attribute': r[8],
               **dict(zip(('name', 'desc'), ficha_pt(*names.get(r[0], ('', '')))))}
              for r in rows.values() if r[3] & TYPE_TOKEN]
    (OUT / 'tokens.json').write_text(json.dumps(tokens, separators=(',', ':')))
    (OUT / 'seasons.json').write_text(json.dumps(index, ensure_ascii=False, indent=1))

    # Scripts: os utilitários da raiz + o de cada carta das temporadas ativas.
    # Limpa só o que é do clássico: a pasta rush/ é do tools/rush/import_rush.py.
    if (SCRIPTS_OUT / 'official').exists():
        shutil.rmtree(SCRIPTS_OUT / 'official')
    for old in SCRIPTS_OUT.glob('*.lua'):
        old.unlink()
    (SCRIPTS_OUT / 'official').mkdir(parents=True)
    for path in scripts.glob('*.lua'):
        shutil.copy2(path, SCRIPTS_OUT / path.name)
    shutil.copy2(scripts / 'COPYING', SCRIPTS_OUT / 'COPYING')
    # O navegador pré-carrega os utilitários da raiz antes do duelo (o motor lê scripts de forma síncrona).
    (SCRIPTS_OUT / 'index.json').write_text(json.dumps(sorted(path.name for path in scripts.glob('*.lua'))))
    copied = 0
    for number in range(1, until + 1):
        for card in seasons[number]:
            source = scripts / 'official' / f'c{card["id"]}.lua'
            if source.exists():
                shutil.copy2(source, SCRIPTS_OUT / 'official' / source.name)
                copied += 1

    synergy(seasons, until)
    print('scripts dos puzzles:', copy_puzzle_scripts())

    from collections import Counter
    for number in range(1, until + 1):
        print(f'T{number} raridades:', dict(Counter(card['rarity'] for card in seasons[number])))
    for item in index:
        print(f"T{item['season']} {item['label']:<20} {item['count']:>5} cartas ({item['pt']} em PT) {'ativa' if item['enabled'] else ''}")
    print('ignoradas:', skipped, '| fichas:', len(tokens), '| scripts copiados:', copied)


DECK_FORMATS = {  # formato do YGOPRODeck -> páginas (a API entrega 20 decks por página)
    'Goat Format Decks': 150, 'Edison Format Decks': 150, 'Meta Decks': 100, 'Tournament Meta Decks': 60, 'Non-Meta Decks': 100,
}


def decks():
    """Listas de jogadores: só main e extra, para contar quais cartas aparecem juntas."""
    target = CACHE / 'decks.json'
    seen = {d['id']: d for d in json.loads(target.read_text())} if target.exists() else {}
    for fmt, pages in DECK_FORMATS.items():
        for page in range(pages):
            url = f'https://ygoprodeck.com/api/decks/getDecks.php?format={urllib.parse.quote(fmt)}&limit=20&offset={page * 20}'
            tmp = CACHE / 'page.json'
            try:
                fetch_url(url, tmp)
                batch = json.loads(tmp.read_text())
            except (RuntimeError, ValueError):
                break
            if not isinstance(batch, list) or not batch:
                break
            for deck in batch:
                try:
                    main = [int(x) for x in json.loads(deck.get('main_deck') or '[]')]
                    extra = [int(x) for x in json.loads(deck.get('extra_deck') or '[]')]
                except (TypeError, ValueError, KeyError):
                    continue
                if len(main) >= 20:
                    seen[int(deck['deckNum'])] = {'id': int(deck['deckNum']), 'format': fmt, 'main': main, 'extra': extra}
            time.sleep(1)  # bem abaixo do limite de 20/s
        print(fmt, '->', len(seen), 'decks no total', flush=True)
    target.write_text(json.dumps(list(seen.values())))


PUZZLES_URL = 'https://github.com/ProjectIgnis/Puzzles.git'
PUZZLE_FOLDERS = {  # pasta do repositório -> nome curto em PT (Rush, Speed Duel e tutoriais ficam de fora)
    'Nightmare Troubadour': 'Nightmare Troubadour',
    'World Championship': 'Campeonato Mundial',
    'GX Spirit Caller': 'GX Spirit Caller',
    'Miscellaneous': 'Comunidade',
}
PUZZLE_SHORT = {'Nightmare Troubadour': 'nt', 'World Championship': 'wc', 'GX Spirit Caller': 'gx', 'Miscellaneous': 'misc'}
PUZZLE_MAX = 40  # quantos entram no jogo (um por dia, escolhido pela data)


def card_row(row, local, en_card):
    cid, alias, setcode, kind, atk, defense, level, race, attribute = row
    return {'id': cid, 'alias': alias, 'setcode': str(setcode), 'type': kind, 'atk': atk, 'def': defense, 'level': level,
            'race': race, 'attribute': attribute, 'name': local.get('name') or (en_card or {}).get('name') or str(cid),
            'nameEn': (en_card or {}).get('name') or '', 'desc': local.get('desc') or (en_card or {}).get('desc') or '', 'pt': bool(local)}


def strip_lua_comments(text):
    """Tira os comentários (inclusive a solução escrita no fim) do script do puzzle."""
    import re
    text = re.sub(r'--\[(=*)\[.*?\]\1\]', '', text, flags=re.S)
    text = re.sub(r'--[^\n]*', '', text)
    return '\n'.join(line.rstrip() for line in text.splitlines() if line.strip()) + '\n'


def puzzle_candidates():
    """Lê os .lua do repositório e devolve os puzzles de "vença neste turno" do clássico."""
    import re
    source = CACHE / 'Puzzles'
    if source.exists():
        subprocess.run(['git', '-C', str(source), 'pull', '-q', '--depth', '1'], check=False)
    else:
        subprocess.run(['git', 'clone', '-q', '--depth', '1', PUZZLES_URL, str(source)], check=True)
    official = {int(path.stem[1:]) for path in (CACHE / 'CardScripts' / 'official').glob('c*.lua')}
    db = sqlite3.connect(CACHE / 'cards.cdb')
    rows = {row[0]: row for row in db.execute('select id, alias, setcode, type, atk, def, level, race, attribute from datas')}
    out = []
    for folder, label in PUZZLE_FOLDERS.items():
        for path in sorted((source / folder).rglob('*.lua')):
            text = path.read_text(errors='replace')
            if 'aux.BeginPuzzle' not in text or 'DUEL_MODE_RUSH' in text or 'DUEL_MODE_SPEED' in text:
                continue
            objective = re.search(r'Objective:\s*([^\n]+)', text)
            if not objective or not re.fullmatch(r'(win|defeat (the )?opponent)( in)? this turn\.?', objective.group(1).strip(), re.I):
                continue
            ids = [int(cid) for cid in re.findall(r'Debug\.AddCard\(\s*(\d+)', text)]
            if not ids or any(cid not in rows for cid in ids):
                continue
            # Toda carta com efeito precisa do script oficial (Normais não têm).
            if any(cid not in official and not (rows[cid][3] & TYPE_NORMAL and not rows[cid][3] & 0x1000000) for cid in ids):
                continue
            complexity = re.search(r'Complexity:\s*(\d+)', text)
            slug = re.sub(r'[^a-z0-9]+', '-', f'{PUZZLE_SHORT[folder]} {path.stem}'.lower()).strip('-')[:64]
            out.append({'id': slug, 'folder': folder, 'title': puzzle_title(folder, path.stem), 'complexity': int(complexity.group(1)) if complexity else None,
                        'cards': sorted(set(ids)), 'count': len(ids), 'script': strip_lua_comments(text)})
    assert len({item['id'] for item in out}) == len(out), 'ids de puzzle repetidos'
    return out, rows


def puzzle_title(folder, stem):
    """Título curto em PT a partir do nome do arquivo (sem o subtítulo em inglês)."""
    import re
    label = PUZZLE_FOLDERS[folder]
    if folder == 'World Championship':
        found = re.match(r'\[WCS(\d{4})\]\s*(?:Download Puzzle\s*)?(\d+)', stem)
        return f'{label} {found[1]} nº {int(found[2])}' if found else label
    if folder == 'Nightmare Troubadour':
        found = re.search(r'Puzzle\s*(\w+)', stem)
        return f'{label} {found[1]}' if found else label
    if folder == 'GX Spirit Caller':
        found = re.search(r'\]([BIA]\d+)', stem)
        return f'{label} {found[1]}' if found else label
    author = re.split(r'[_ ]', stem)[0]
    number = next((part for part in re.split(r'[_ ]', stem) if part[:2].isdigit()), '')
    return f'{label} · {author} {number}'.strip()


def puzzles(search=False, budget=10000, meta=35):
    candidates, rows = puzzle_candidates()
    en = {card['id']: card for card in json.loads((CACHE / 'ygopro-en.json').read_text())['data']}
    pt = {card['id']: card for card in json.loads((CACHE / 'ygopro-pt.json').read_text())['data']}
    for item in candidates:
        dates = [first_release(en[cid]) for cid in item['cards'] if cid in en]
        item['newest'] = max([d for d in dates if d] or ['9999'])
    print(len(candidates), 'candidatos; validando no motor...', flush=True)
    check_in = CACHE / 'puzzle-candidates.json'
    check_out = CACHE / 'puzzle-results.json'
    core = {str(cid): card_row(rows[cid], {}, None) for item in candidates for cid in item['cards']}
    solutions_file = HERE / 'puzzle-solutions.json'
    known = json.loads(solutions_file.read_text()) if solutions_file.exists() else {}
    found = CACHE / 'puzzle-found.jsonl'  # vitórias achadas por buscas anteriores (inclusive interrompidas)
    if found.exists():
        for line in found.read_text().splitlines():
            try:
                item = json.loads(line)
                known.setdefault(item['found'], item['solution'])
            except (ValueError, KeyError):
                pass
    # Sem --buscar só confere as soluções já conhecidas (segundos). --buscar procura nas que faltam (dezenas de minutos).
    candidates.sort(key=lambda item: item['id'] not in known)  # conhecidos primeiro: a meta fecha rápido
    options = {'known': known, 'search': search, 'budget': budget, 'ms': budget * 10, 'meta': meta}
    check_in.write_text(json.dumps({'puzzles': candidates, 'cards': core, 'options': options}))
    threads = str(max(1, (os.cpu_count() or 2) - 2))
    subprocess.run(['node', str(HERE / 'puzzle-check.mjs'), str(check_in), str(check_out), threads], check=True)
    results = json.loads(check_out.read_text())
    good = [item for item in candidates if results.get(item['id'], {}).get('solved')]  # sem resultado = parou na meta
    print('carregam:', sum(1 for r in results.values() if r.get('loads')), '| resolvidos pelo solucionador:', len(good))
    # Curtos e antigos primeiro: menos respostas na solução, cartas mais velhas.
    good.sort(key=lambda item: (item['newest'] >= SEASONS[0][2], len(results[item['id']]['solution']), item['newest']))
    chosen = sorted(good[:PUZZLE_MAX], key=lambda item: item['id'])
    data = []
    for item in chosen:
        data.append({'id': item['id'], 'title': item['title'], 'goal': 'Vença neste turno.', 'script': item['script'],
                     'cards': [card_row(rows[cid], pt.get(cid, {}), en.get(cid)) for cid in item['cards']]})
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'puzzles.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
    # Soluções achadas pelo solucionador: só para o teste (npm test refaz cada uma e confere a vitória).
    # Guarda as soluções conhecidas (as novas e as antigas): cache da próxima execução e base do teste.
    known.update({item['id']: results[item['id']]['solution'] for item in good})
    solutions_file.write_text(json.dumps(known, separators=(',', ':')))
    copied = copy_puzzle_scripts()
    print(f'{len(data)} puzzles em {OUT / "puzzles.json"} ({(OUT / "puzzles.json").stat().st_size // 1024} KB) | scripts novos copiados: {copied}')


def copy_puzzle_scripts():
    """Copia para o site os scripts das cartas dos puzzles que não estão nas temporadas ativas."""
    target = OUT / 'puzzles.json'
    if not target.exists():
        return 0
    copied = 0
    for item in json.loads(target.read_text()):
        for card in item['cards']:
            source = CACHE / 'CardScripts' / 'official' / f'c{card["id"]}.lua'
            dest = SCRIPTS_OUT / 'official' / source.name
            if source.exists() and not dest.exists():
                shutil.copy2(source, dest)
                copied += 1
    return copied


def art():
    from PIL import Image  # só este comando precisa do Pillow

    raw = CACHE / 'art'
    raw.mkdir(parents=True, exist_ok=True)
    ART_OUT.mkdir(parents=True, exist_ok=True)
    ids = [int(card['id']) for path in sorted(OUT.glob('s[0-9]*.json')) for card in json.loads(path.read_text())]
    if (OUT / 'puzzles.json').exists():  # cartas dos puzzles, mesmo fora da temporada
        ids = list(dict.fromkeys(ids + [int(card['id']) for item in json.loads((OUT / 'puzzles.json').read_text()) for card in item['cards']]))

    def one(cid):
        target = ART_OUT / f'{cid}.webp'
        if target.exists():
            return 'ok'
        source = raw / f'{cid}.jpg'
        if not source.exists():
            time.sleep(0.6)  # ~16 pedidos/s com 10 threads: abaixo do limite de 20/s
            try:
                fetch_url(ART_URL.format(cid), source)
            except RuntimeError:
                return 'falhou'
        Image.open(source).convert('RGB').resize((320, 320), Image.LANCZOS).save(target, 'WEBP', quality=74, method=6)
        return 'nova'

    with ThreadPoolExecutor(10) as pool:
        results = list(pool.map(one, ids))
    print({status: results.count(status) for status in set(results)}, '->', ART_OUT)


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    if command == 'fetch':
        fetch()
    elif command == 'decks':
        decks()
    elif command == 'puzzles':
        arg = lambda name, default: int(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default
        puzzles(search='--buscar' in sys.argv, budget=arg('--nos', 10000), meta=arg('--meta', 35))
    elif command == 'art':
        art()
    elif command == 'build':
        build(int(sys.argv[sys.argv.index('--ate') + 1]) if '--ate' in sys.argv else 1)
    else:
        print(__doc__)
