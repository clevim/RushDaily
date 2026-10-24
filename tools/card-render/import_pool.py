#!/usr/bin/env python3
"""Monta o pool do RushDaily a partir do YAML Yugi (rush.json).

  python3 tools/card-render/import_pool.py fetch   # escolhe as cartas, acha as artes e baixa tudo para cache/
  python3 tools/card-render/import_pool.py build   # junta com pt-br.json e escreve src/data/cards.mjs

Entram: todos os monstros Normais e as Magias/Armadilhas cujo texto o engine executa (classify.py).
"""
import hashlib
import json
import re
import subprocess
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from classify import RACES, classify, text

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = HERE / 'cache'
SOURCE = CACHE / 'rush.json'
SELECTED = HERE / 'pool-en.json'
PT = HERE / 'pt-br.json'
OUT = ROOT / 'src' / 'data' / 'cards.mjs'
UA = 'RushDaily/0.1 (projeto pessoal, sem fins comerciais)'
ART_PATTERNS = ['-OW-RD.png', '-DBR-JP-VG-artwork.png', '-G002-JP-VG-artwork.png', '-MADU-EN-VG-artwork.png', '-OW.png', '-TF05-JP-VG-artwork.png']
SKIP_ART = {'WarriorofZera-OW-RD.png'}  # arte com marca d'água


def fetch_url(url):
    """Via curl: o Yugipedia responde em segundos ao curl e trava o urllib do Python."""
    for attempt in range(4):
        result = subprocess.run(['curl', '-sfL', '-m', '120', '-A', UA, url], capture_output=True)
        if result.returncode == 0 and result.stdout:
            return result.stdout
        time.sleep(2 + attempt * 3)
    raise RuntimeError(f'falhou: {url}')


def cdn(filename):
    digest = hashlib.md5(filename.encode()).hexdigest()
    return f'https://ms.yugipedia.com//{digest[0]}/{digest[:2]}/{filename}'


def select(data):
    pool = []
    for card in data:
        line = card.get('monster_type_line') or ''
        images = card.get('images') or []
        if not images or not images[0].get('image'):
            continue
        if card['card_type'] == 'Monster' and line.endswith('/ Normal'):
            race = line.split(' /')[0]
            if race not in RACES or card.get('atk') is None:
                continue
            entry = {'kind': 'monster', 'race': race, 'level': card.get('level'), 'atk': card['atk'], 'def': card.get('def', 0), 'attribute': card.get('attribute')}
        elif card['card_type'] in ('Spell', 'Trap') and (fields := classify(card)):
            entry = {'kind': card['card_type'].lower(), **fields, 'requirementEn': text(card, 'requirement'), 'effectEn': text(card, 'effect')}
        else:
            continue
        pool.append({
            # Algumas cartas não têm id Konami: usa o id da página do Yugipedia.
            'id': card['konami_id'] or 9_000_000 + card['yugipedia_page_id'], 'en': card['name']['en'], 'legend': bool(card.get('legend')),
            'flavorEn': text(card, 'text'), 'scan': images[0]['image'], 'illustration': images[0].get('illustration'), **entry,
        })
    return pool


def resolve_art(pool):
    """Procura em lote (50 títulos por chamada) qual arte limpa existe para cada carta."""
    wanted = {}
    for card in pool:
        prefix = card['scan'].split('-')[0]
        card['artCandidates'] = [f'{prefix}{suffix}' for suffix in ART_PATTERNS if f'{prefix}{suffix}' not in SKIP_ART]
        for name in card['artCandidates']:
            wanted[name] = False
    names = list(wanted)
    for start in range(0, len(names), 50):
        chunk = names[start:start + 50]
        query = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'prop': 'imageinfo', 'iiprop': 'size', 'titles': '|'.join(f'File:{name}' for name in chunk)})
        pages = json.loads(fetch_url(f'https://yugipedia.com/api.php?{query}'))['query']['pages']
        for page in pages.values():
            info = page.get('imageinfo')
            if info and info[0].get('width', 0) >= 300:
                wanted[page['title'].removeprefix('File:').replace(' ', '_')] = True
        print(f'artes: {min(start + 50, len(names))}/{len(names)}', flush=True)
    for card in pool:
        card['art'] = card['illustration'] if card.get('illustration') and card['illustration'] not in SKIP_ART else next((name for name in card['artCandidates'] if wanted.get(name)), None)
        del card['artCandidates']


def download(filename):
    target = CACHE / filename
    if target.exists() and target.stat().st_size > 0:
        return True
    try:
        target.write_bytes(fetch_url(cdn(filename)))
        return True
    except RuntimeError:
        return False


def fetch():
    CACHE.mkdir(exist_ok=True)
    if not SOURCE.exists():
        SOURCE.write_bytes(fetch_url('https://dawnbrandbots.github.io/yaml-yugi/rush.json'))
    pool = select(json.loads(SOURCE.read_text()))
    print('cartas escolhidas:', len(pool), flush=True)
    resolve_art(pool)
    SELECTED.write_text(json.dumps(pool, ensure_ascii=False, indent=1))
    files = sorted({card['art'] or card['scan'] for card in pool})
    done = 0
    with ThreadPoolExecutor(4) as workers:
        for filename, ok in zip(files, workers.map(download, files)):
            done += 1
            if not ok:
                print('falhou:', filename, flush=True)
            if done % 25 == 0:
                print(f'downloads: {done}/{len(files)}', flush=True)
    # Arte limpa que não baixou: volta para o scan (que também precisa existir).
    for card in pool:
        if card['art'] and not (CACHE / card['art']).exists():
            card['art'] = None
            download(card['scan'])
    pool = [card for card in pool if (CACHE / (card['art'] or card['scan'])).exists()]
    SELECTED.write_text(json.dumps(pool, ensure_ascii=False, indent=1))
    print('pronto:', len(pool), 'cartas,', sum(1 for card in pool if card['art']), 'com arte limpa', flush=True)


ATTR_PT = {'DARK': 'TREVAS', 'LIGHT': 'LUZ', 'EARTH': 'TERRA', 'WATER': 'ÁGUA', 'FIRE': 'FOGO', 'WIND': 'VENTO', 'DIVINE': 'DIVINO'}
LABELS = {
    'Dragon': 'Dragões', 'Warrior': 'Guerreiros', 'Machine': 'Máquinas', 'Beast': 'Bestas', 'Aqua': 'Aquáticos',
    'Galaxy': 'Galáxias', 'Spellcaster': 'Feiticeiros', 'Pyro': 'Piros', 'Fiend': 'Demônios', 'Reptile': 'Répteis',
    'Fairy': 'Fadas', 'Beast-Warrior': 'Bestas-Guerreiras',
}
MIN_ARCHETYPE = 15  # monstros Normais mínimos para um Tipo virar arquétipo do desafio


def plural(n, one, many):
    return one if n == 1 else many


def monster_phrase(f, n=1):
    """Filtro -> 'monstro com a face para cima de Nível 7 ou mais do Tipo Mago'."""
    f = f or {}
    words = [plural(n, 'monstro', 'monstros')]
    if f.get('race'):
        words.append(f"do Tipo {RACES[f['race']]}")
    if f.get('normal'):
        words.append(plural(n, 'Normal', 'Normais'))
    if f.get('attackPosition'):
        words.append('em Posição de Ataque')
    if f.get('faceUp'):
        words.append('com a face para cima')
    if f.get('attribute'):
        words.append(f"de {ATTR_PT[f['attribute']]}")
    if f.get('minLevel'):
        words.append(f"de Nível {f['minLevel']} ou mais")
    if f.get('maxLevel'):
        words.append(f"de Nível {f['maxLevel']} ou menos")
    if 'maxAtk' in f:
        words.append(f"com {f['maxAtk']} ou menos de ATK")
    if 'minAtk' in f:
        words.append(f"com {f['minAtk']} ou mais de ATK")
    return ' '.join(words)


WHERE = {'own': 'no seu campo', 'opponent': 'no campo do seu oponente', 'any': 'no campo'}


def step_pt(step):
    do = step['do']
    if do == 'heal':
        return f"Ganhe {step['value']} PV."
    if do == 'burn':
        return f"Cause {step['value']} de dano ao seu oponente."
    if do == 'draw':
        return f"Compre {step['value']} {plural(step['value'], 'card', 'cards')}."
    if do == 'discard':
        return f"Envie {step['value']} {plural(step['value'], 'card', 'cards')} da sua mão para o Cemitério."
    if do == 'destroy':
        if step['count'] == 'all':
            return f"Destrua todos os {monster_phrase(step['filter'], 2)} {WHERE[step['side']]}."
        return f"Destrua {step['count']} {monster_phrase(step['filter'], step['count'])} {WHERE[step['side']]}."
    if do == 'destroy-strongest':
        return 'Destrua 1 monstro em Posição de Ataque com o maior ATK no campo.'
    if do == 'destroy-backrow':
        if step['count'] == 'all':
            return f"Destrua todos os Cartas Mágicas e de Armadilha {WHERE[step['side']]}."
        return f"Destrua {step['count']} {plural(step['count'], 'Carta Mágica ou de Armadilha', 'Cartas Mágicas ou de Armadilha')} {WHERE[step['side']]}."
    if do == 'destroy-attacker':
        return 'Destrua o monstro atacante.'
    if do == 'destroy-summoned':
        return 'Destrua o monstro que foi invocado.'
    if do == 'atk':
        verb = 'ganha' if step['value'] > 0 else 'perde'
        if step['target'] == 'attacker':
            return f"O monstro atacante {verb} {abs(step['value'])} de ATK até o fim deste turno."
        return f"1 {monster_phrase(step.get('filter'))} {WHERE[step['target']]} {verb} {abs(step['value'])} de ATK até o fim deste turno."
    if do == 'special-summon':
        return f"Invoque por Invocação-Especial 1 {monster_phrase(step.get('filter'))} da sua mão, com a face para cima, no seu campo."
    raise ValueError(do)


def requirement_pt(card, names):
    if card.get('trigger') == 'summon':
        what = monster_phrase(card.get('summonFilter')) if card.get('summonFilter') else 'monstro'
        return f'Quando seu oponente fizer a Invocação-Normal de um {what}.'
    if card.get('trigger') in ('attack', 'direct-attack'):
        who = monster_phrase(card.get('attackerFilter')) if card.get('attackerFilter') else 'monstro'
        kind = 'um ataque direto' if card['trigger'] == 'direct-attack' else 'um ataque'
        extra = ' enquanto ele tiver 3 monstros em Posição de Ataque no campo' if (card.get('condition') or {}).get('attackerSideAttackers') else ''
        return f'Quando um {who} do seu oponente declarar {kind}{extra}.'
    cost = card.get('cost')
    n = card.get('costValue', 1)
    if cost == 'discard':
        return f"Envie {n} {plural(n, 'card', 'cards')} da sua mão para o Cemitério."
    if cost == 'discard-monster':
        return f"Envie {n} {plural(n, 'monstro', 'monstros')} da sua mão para o Cemitério."
    if cost == 'mill':
        return 'Envie o card do topo do seu Deck para o Cemitério.' if n == 1 else f'Envie os {n} cards do topo do seu Deck para o Cemitério.'
    if cost == 'lp':
        return f'Pague {n} PV.'
    condition = card.get('condition') or {}
    if condition.get('have'):
        return f"Você tem 1 {monster_phrase(condition['have'])} no seu campo."
    if condition.get('haveName'):
        return f"Você tem \"{names.get(condition['haveName'], condition['haveName'])}\" com a face para cima no seu campo."
    return None


def slug(race):
    return race.lower().replace(' ', '-')


def build():
    pool = json.loads(SELECTED.read_text())
    page_ids = {card['name']['en']: card['yugipedia_page_id'] for card in json.loads(SOURCE.read_text()) if card.get('name', {}).get('en')}
    for card in pool:
        card['id'] = card['id'] or 9_000_000 + page_ids[card['en']]
    pt = json.loads(PT.read_text())
    tr = lambda card: pt.get(str(card['id'])) or pt[card['en']]
    names = {card['en']: tr(card)['name'] for card in pool}
    counts = {}
    for card in pool:
        if card['kind'] == 'monster':
            counts[card['race']] = counts.get(card['race'], 0) + 1
    archetypes = [race for race, total in sorted(counts.items(), key=lambda item: -item[1]) if total >= MIN_ARCHETYPE and race in LABELS]
    cards = []
    for card in pool:
        base = {'id': card['id'], 'name': tr(card)['name'], 'enName': card['en'], 'legend': card['legend'] or None}
        if card['kind'] == 'monster':
            power = min(1, round((card['atk'] + card['def'] * 0.25) / 3300 + (0.05 if card['legend'] else 0), 2))
            cards.append({**base, 'type': 'monster', 'archetype': slug(card['race']) if card['race'] in archetypes else 'misc', 'role': 'monster',
                          'power': power, 'atk': card['atk'], 'def': card['def'], 'level': card['level'], 'race': RACES[card['race']],
                          'raceKey': card['race'], 'attribute': card['attribute'], 'desc': tr(card)['desc'],
                          'scan': card['scan'], 'illustration': card['art']})
            continue
        engine = {key: card[key] for key in ('steps', 'cost', 'costValue', 'condition', 'trigger', 'attackerFilter', 'summonFilter') if card.get(key) is not None}
        filters = [card.get('attackerFilter'), card.get('summonFilter'), (card.get('condition') or {}).get('have'), *[step.get('filter') for step in card['steps']]]
        race = next((f['race'] for f in filters if f and f.get('race')), None)
        cards.append({**base, 'type': card['kind'], 'archetype': slug(race) if race in archetypes else None, 'role': card['kind'],
                      'power': round(min(1, 0.35 + 0.15 * len(card['steps']) + (0.2 if card['legend'] else 0)), 2),
                      **engine, 'requirement': requirement_pt(card, names), 'desc': ' '.join(step_pt(step) for step in card['steps']),
                      'scan': card['scan'], 'illustration': card['art']})
    cards.sort(key=lambda card: ({'monster': 0, 'spell': 1, 'trap': 2}[card['type']], card['archetype'] or '~', -card['power']))
    for card in cards:
        for key in [key for key, value in card.items() if value is None]:
            del card[key]
    header = """// GERADO por tools/card-render/import_pool.py build. Não edite à mão: mude pt-br.json ou classify.py.
// Pool Rush Duel em PT-BR (tradução não oficial). Stats e textos-base: YAML Yugi; imagens: Yugipedia.
"""
    body = 'export const CARD_POOL = [\n' + ''.join(f'  {json.dumps(card, ensure_ascii=False)},\n' for card in cards) + '];\n'
    labels = {slug(race): LABELS[race] for race in archetypes}
    footer = f"""
export const ARCHETYPES = {json.dumps([slug(race) for race in archetypes])};
export const ARCHETYPE_LABELS = {json.dumps(labels, ensure_ascii=False)};

const ASSETS = new URL('../assets/', import.meta.url).href;

export function cardImage(card) {{
  return `${{ASSETS}}cards/${{card.id}}.webp`;
}}

// Miniatura (316 px) para a home e listas: 3x menos bytes que a carta inteira. Gerada por tools/setup/thumbs.py.
export function cardThumb(card) {{
  return `${{ASSETS}}cards-sm/${{card.id}}.webp`;
}}

export function cardBackImage() {{
  return `${{ASSETS}}card-back.svg`;
}}

export function cardManifest(card) {{
  return {{ id: card.id, front: cardImage(card), back: cardBackImage() }};
}}
"""
    OUT.write_text(header + body + footer)
    print('cards.mjs:', len(cards), 'cartas,', len(archetypes), 'arquétipos:', ', '.join(LABELS[race] for race in archetypes))


if __name__ == '__main__':
    {'fetch': fetch, 'build': build}[sys.argv[1]]()
