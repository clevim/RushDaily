"""Converte o texto das Magias/Armadilhas Rush (YAML Yugi, inglês) numa lista de passos que o engine executa.

Cada frase do [EFFECT] precisa virar um passo conhecido; se alguma frase não for entendida,
a carta fica fora do pool (assim o texto PT-BR gerado sempre bate com o que acontece no jogo).
Rodando direto: python3 classify.py rush.json  -> contagem e exemplos.
"""
import re

RACES = {
    'Dragon': 'Dragão', 'Warrior': 'Guerreiro', 'Spellcaster': 'Mago', 'Machine': 'Máquina', 'Beast': 'Besta',
    'Beast-Warrior': 'Besta-Guerreira', 'Winged Beast': 'Besta Alada', 'Fiend': 'Demônio', 'Fairy': 'Fada', 'Insect': 'Inseto',
    'Dinosaur': 'Dinossauro', 'Reptile': 'Réptil', 'Fish': 'Peixe', 'Sea Serpent': 'Serpente Marinha', 'Aqua': 'Aqua',
    'Pyro': 'Piro', 'Thunder': 'Trovão', 'Rock': 'Rocha', 'Plant': 'Planta', 'Zombie': 'Zumbi', 'Psychic': 'Psíquico',
    'Wyrm': 'Wyrm', 'Cyberse': 'Cyberse', 'Galaxy': 'Galáxia', 'Celestial Warrior': 'Guerreiro Celestial',
    'Omega Psychic': 'Psíquico Ômega', 'High Dragon': 'Alto Dragão', 'Magical Knight': 'Cavaleiro Mágico', 'Cyborg': 'Ciborgue',
    'Divine-Beast': 'Besta Divina',
}
ATTRIBUTES = ['DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND', 'DIVINE']
RACE_RE = '|'.join(sorted(map(re.escape, RACES), key=len, reverse=True))


def text(card, key):
    return ((card.get(key) or {}).get('en') or '').replace('\n', ' ').strip()


def parse_filter(phrase):
    """'face-up Level 7 or higher DARK Attribute Spellcaster Type Normal monster with 1500 or less ATK' -> dict."""
    found = re.fullmatch(
        rf"(?P<faceup>face-up )?(?:Level (?P<lvl>\d+) or (?P<lvldir>higher|lower) )?(?:(?P<attr>{'|'.join(ATTRIBUTES)}) Attribute )?"
        rf"(?:(?P<race>{RACE_RE}) Type )?(?P<normal>Normal )?(?:monster|Monster)s?(?: with (?P<atk>\d+) or (?P<atkdir>less|more) ATK)?",
        phrase.strip())
    if not found:
        return None
    result = {}
    if found['faceup']:
        result['faceUp'] = True
    if found['lvl']:
        result['minLevel' if found['lvldir'] == 'higher' else 'maxLevel'] = int(found['lvl'])
    if found['attr']:
        result['attribute'] = found['attr']
    if found['race']:
        result['race'] = found['race']
    if found['normal']:
        result['normal'] = True
    if found['atk']:
        result['minAtk' if found['atkdir'] == 'more' else 'maxAtk'] = int(found['atk'])
    return result


SIDE = r"(?P<side>your field|your opponent's field|the field)"
SIDES = {'your field': 'own', "your opponent's field": 'opponent', 'the field': 'any'}


def step_for(sentence):
    """Uma frase do efeito -> passo do engine (ou None)."""
    s = re.sub(r'^(Then, )?(you can )?', '', sentence.strip().rstrip('.')).strip()
    s = s[0].upper() + s[1:] if s else s
    if m := re.fullmatch(r'Gain (\d+) LP', s):
        return {'do': 'heal', 'value': int(m[1])}
    if m := re.fullmatch(r'Inflict (\d+) damage to your opponent', s):
        return {'do': 'burn', 'value': int(m[1])}
    if m := re.fullmatch(r'Draw (\d+) cards?', s):
        return {'do': 'draw', 'value': int(m[1])}
    if m := re.fullmatch(r'Send (\d+) cards? from your hand to the (?:GY|Graveyard)', s):
        return {'do': 'discard', 'value': int(m[1])}
    if s == 'Destroy all monsters on the field':
        return {'do': 'destroy', 'count': 'all', 'side': 'any', 'filter': {}}
    if s == 'Destroy 1 Attack Position monster with the highest ATK on the field':
        return {'do': 'destroy-strongest'}
    if m := re.fullmatch(rf'Destroy all (?P<what>.+?) on {SIDE}', s):
        if m['what'] == 'Spell/Trap Cards':
            return {'do': 'destroy-backrow', 'count': 'all', 'side': SIDES[m['side']]}
        attack_pos = m['what'].startswith('Attack Position ')
        flt = parse_filter(m['what'].removeprefix('Attack Position '))
        if flt is None:
            return None
        if attack_pos:
            flt['attackPosition'] = True
        return {'do': 'destroy', 'count': 'all', 'side': SIDES[m['side']], 'filter': flt}
    if m := re.fullmatch(rf'Destroy (?:up to )?(?P<n>\d+) (?P<what>.+?) on {SIDE}', s):
        if m['what'] in ('Spell/Trap Card', 'Spell/Trap Cards'):
            return {'do': 'destroy-backrow', 'count': int(m['n']), 'side': SIDES[m['side']]}
        attack_pos = m['what'].startswith('Attack Position ')
        flt = parse_filter(m['what'].removeprefix('Attack Position '))
        if flt is None:
            return None
        if attack_pos:
            flt['attackPosition'] = True
        return {'do': 'destroy', 'count': int(m['n']), 'side': SIDES[m['side']], 'filter': flt}
    if m := re.fullmatch(r'Special Summon 1 (.+?) from your hand face-up to your field', s):
        flt = parse_filter(m[1])
        return {'do': 'special-summon', 'from': 'hand', 'filter': flt} if flt is not None else None
    if m := re.fullmatch(rf'1 (?P<what>.+?) on your field with (?P<atk>\d+) or less ATK gains (?P<v>\d+) ATK until the end of (?:this|the) turn', s):
        flt = parse_filter(m['what'])
        return {'do': 'atk', 'target': 'own', 'filter': {**flt, 'maxAtk': int(m['atk'])}, 'value': int(m['v'])} if flt is not None else None
    if re.fullmatch(r'Destroy (?:the|that) attacking monster', s):
        return {'do': 'destroy-attacker'}
    if m := re.fullmatch(r'Destroy (?:that|the) (?:1 )?(?:Normal (?:or Special )?Summoned|Summoned) monster', s):
        return {'do': 'destroy-summoned'}
    if m := re.fullmatch(r'The attacking monster loses (\d+) ATK until the end of this turn', s):
        return {'do': 'atk', 'target': 'attacker', 'value': -int(m[1])}
    if m := re.fullmatch(rf'(?:Choose |Make )?(?P<n>1) (?P<what>.+?) on {SIDE} (?:gains?|loses?) (?P<v>\d+) ATK until the end of (?:this|the) turn', s):
        flt = parse_filter(m['what'])
        if flt is None or m['side'] == 'the field':
            return None
        sign = -1 if ' lose' in s else 1
        return {'do': 'atk', 'target': 'own' if m['side'] == 'your field' else 'opponent', 'filter': flt, 'value': sign * int(m['v'])}
    if m := re.fullmatch(rf'Make (?P<n>1) (?P<what>.+?) on {SIDE} (?P<verb>gain|lose) (?P<v>\d+) ATK until the end of (?:this|the) turn', s):
        flt = parse_filter(m['what'])
        if flt is None or m['side'] == 'the field':
            return None
        return {'do': 'atk', 'target': 'own' if m['side'] == 'your field' else 'opponent', 'filter': flt, 'value': (1 if m['verb'] == 'gain' else -1) * int(m['v'])}
    return None


def parse_requirement(req, is_trap):
    """Requisito -> (custo/condição, gatilho)."""
    r = req.strip().rstrip('.')
    if r in ('', 'None'):
        return ({}, None)
    if m := re.fullmatch(r'Send (\d+) cards? from your hand to the (?:GY|Graveyard)', r):
        return ({'cost': 'discard', 'costValue': int(m[1])}, None)
    if m := re.fullmatch(r'Send (\d+) monsters? from your hand to the (?:GY|Graveyard)', r):
        return ({'cost': 'discard-monster', 'costValue': int(m[1])}, None)
    if m := re.fullmatch(r'Send the top (?:(\d+) cards|card) of your Deck to the (?:GY|Graveyard)', r):
        return ({'cost': 'mill', 'costValue': int(m[1] or 1)}, None)
    if m := re.fullmatch(r'Pay (\d+) LP', r):
        return ({'cost': 'lp', 'costValue': int(m[1])}, None)
    if m := re.fullmatch(r'You have "([^"]+)" face-up on your field', r):
        return ({'condition': {'haveName': m[1]}}, None)
    if m := re.fullmatch(r'You have (?:a|an) (.+?) on your field', r):
        flt = parse_filter(m[1])
        return ({'condition': {'have': flt}}, None) if flt is not None else None
    if is_trap:
        if re.fullmatch(r"When (?:an|your) opponent's monster declares an attack", r):
            return ({}, 'attack')
        if re.fullmatch(r"When (?:an|your) opponent's monster declares a direct attack", r):
            return ({}, 'direct-attack')
        if re.fullmatch(r"When an opponent's monster declares an attack while they have 3 Attack Position monsters on their field", r):
            return ({'condition': {'attackerSideAttackers': 3}}, 'attack')
        if m := re.fullmatch(r"When (?:an|your) opponent's (.+?) declares an attack", r):
            flt = parse_filter(m[1])
            return ({'attackerFilter': flt}, 'attack') if flt is not None else None
        if re.fullmatch(r'When your opponent Normal (?:or Special )?Summons a monster(?: face-up)?', r):
            return ({}, 'summon')
        if m := re.fullmatch(r'When your opponent Normal (?:or Special )?Summons (?:a|an) (.+?)(?: face-up)?', r):
            flt = parse_filter(m[1])
            return ({'summonFilter': flt}, 'summon') if flt is not None else None
    return None


def classify(card):
    """Campos do engine para a Magia/Armadilha, ou None se algum pedaço não é suportado."""
    if card.get('property', 'Normal') not in ('Normal', None):
        return None
    is_trap = card['card_type'] == 'Trap'
    parsed = parse_requirement(text(card, 'requirement') or 'None', is_trap)
    if parsed is None:
        return None
    fields, trigger = parsed
    if is_trap != (trigger is not None):
        return None
    sentences = [part for part in re.split(r'(?<=\.)\s+', text(card, 'effect')) if part.strip()]
    steps = [step_for(sentence) for sentence in sentences]
    if not steps or any(step is None for step in steps):
        return None
    reactive = {'destroy-attacker', 'destroy-summoned'}
    if any(step['do'] in reactive or step.get('target') == 'attacker' for step in steps):
        needs = 'summon' if any(step['do'] == 'destroy-summoned' for step in steps) else 'attack'
        if trigger is None or (needs == 'attack') != (trigger in ('attack', 'direct-attack')):
            return None
    result = {**fields, 'steps': steps}
    if trigger:
        result['trigger'] = trigger
    return result


if __name__ == '__main__':
    import collections
    import json
    import sys
    data = json.load(open(sys.argv[1]))
    counts = collections.Counter()
    examples = {}
    for card in data:
        if card['card_type'] in ('Spell', 'Trap'):
            fields = classify(card)
            if fields:
                key = (card['card_type'], '+'.join(step['do'] for step in fields['steps']), fields.get('trigger', ''))
                counts[key] += 1
                examples.setdefault(key, card['name']['en'])
    for key, total in counts.most_common():
        print(total, *key, '| ex.:', examples[key])
    print('Magias/Armadilhas suportadas:', sum(counts.values()))
