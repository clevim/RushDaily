#!/usr/bin/env python3
"""Tradução das cartas Rush para PT-BR: memória de frases, nomes e glossário (plano em tools/rush/traducao/PLANO.md).

  python3 -I tools/rush/traducao.py medir                       # frases, frases únicas, nomes e cobertura atual
  python3 -I tools/rush/traducao.py pendentes [--top N] [--json] [--cartas id,id,...]
                                                                # nomes e frases sem tradução, por frequência;
                                                                # --json sai no formato de lote, pronto para preencher
  python3 -I tools/rush/traducao.py verificar                   # roda as verificações em nomes.json e frases.json
  python3 -I tools/rush/traducao.py aplicar <lote.json> [--origem automatica]
                                                                # junta um lote {"nomes": {en: pt}, "frases": {en: pt}}
                                                                # nos JSON; só entra o que passar nas verificações
  python3 -I tools/rush/traducao.py corpus                      # pares EN->PT oficiais das cartas clássicas (precisa do
                                                                # cache do YGOPRODeck do import_cards.py; não roda na nuvem)

O texto em inglês vem do cards-rush.cdb (tools/rush/cache, do `import_rush.py fetch`), filtrado como no build.
As traduções manuais do tools/card-render/pt-br.json têm prioridade: essas cartas não entram nas pendências.
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
PASTA = HERE / 'traducao'
GLOSSARIO = PASTA / 'glossario.json'
NOMES = PASTA / 'nomes.json'
FRASES = PASTA / 'frases.json'
CORPUS = HERE / 'cache' / 'corpus-classico.json'
YGOPRO = HERE.parents[1] / 'tools' / 'classic' / 'cache'
ORIGENS = ('oficial', 'manual', 'revisada', 'automatica')
FIXAS = ('oficial', 'manual')  # o aplicar nunca sobrescreve

MARCADOR = re.compile(r'^\[[A-Z][A-Z -]+\]$')
MAXIMUM_ATK = re.compile(r'^MAXIMUM ATK = \d+$')  # fica em inglês: o rush-card-data.js lê esse número para o selo ATK MAX
MATERIAIS = re.compile(r'^"[^"]+"(\s*\+\s*"[^"]+")+$')  # matérias de Fusão: só nomes, montadas pelo nomes.json
# Abreviações (o "Mr. Plow" de um texto de Normal) não terminam frase.
FIM_DE_FRASE = re.compile(r'(?<=[.!?])(?<!Mr\.)(?<!Mrs\.)(?<!Dr\.)(?<!St\.)(?<!vs\.)(\s+)(?=[A-Z0-9\[("●“])')
CITACAO = re.compile(r'"([^"]+)"')
NUMERO = re.compile(r'\d+')
# Palavras que não existem em português ("for" e "a" existem): sobrando fora das aspas, é texto sem traduzir.
INGLES = {'the', 'your', 'you', 'this', 'that', 'card', 'cards', 'monster', 'monsters', 'opponent', "opponent's", 'field',
          'hand', 'from', 'with', 'each', 'turn', 'when', 'then', 'if', 'and', 'or', 'of', 'to', 'gains', 'gain', 'loses',
          'send', 'draw', 'attack', 'destroy', 'effect', 'face-up', 'face-down', 'graveyard', 'level', 'type', 'attribute',
          'until', 'end', 'can', 'cannot', 'activate', 'summon', 'summoned', 'other', 'all', 'its', 'their', 'have', 'has',
          'is', 'are', 'an', 'by', 'on', 'in', 'during', 'any', 'select', 'add', 'shuffle', 'position', 'higher', 'lower'}


def ler(path, padrao):
    return json.loads(path.read_text()) if path.exists() else padrao


def gravar(path, dados):
    """Escrita atômica, chaves em ordem e uma entrada por linha (diff estável e fácil de revisar no git)."""
    linha = lambda k: f'{json.dumps(k, ensure_ascii=False)}: {json.dumps(dados[k], ensure_ascii=False)}'
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text('{\n' + ',\n'.join(linha(k) for k in sorted(dados)) + '\n}\n')
    tmp.replace(path)


# ---- segmentação ----
def linhas(desc):
    """Cada linha do desc: ('marcador'|'fixo'|'materiais'|'vazio', linha) ou ('texto', [frases], [separadores])."""
    out = []
    for linha in desc.split('\n'):
        limpa = linha.strip()
        if not limpa:
            out.append(('vazio', linha))
        elif MARCADOR.match(limpa):
            out.append(('marcador', limpa))
        elif MAXIMUM_ATK.match(limpa):
            out.append(('fixo', limpa))
        elif MATERIAIS.match(limpa):
            out.append(('materiais', limpa))
        else:
            partes = FIM_DE_FRASE.split(limpa)
            out.append(('texto', partes[0::2], partes[1::2]))
    return out


def frases(desc):
    return [f for linha in linhas(desc) if linha[0] == 'texto' for f in linha[1]]


def molde(frase):
    """Frase com nomes citados e números trocados por marcadores (só para medir quanto se repete)."""
    return NUMERO.sub('#', CITACAO.sub('"X"', frase))


def fora_das_aspas(texto):
    return CITACAO.sub(' ', texto)


# ---- dados ----
class Memoria:
    """nomes.json + frases.json + glossario.json; monta a carta em PT só se tudo estiver traduzido."""

    def __init__(self):
        self.glossario = ler(GLOSSARIO, [])
        self.nomes = ler(NOMES, {})
        self.frases = ler(FRASES, {})
        self.marcadores = {g['en']: g['pt'] for g in self.glossario if g.get('tipo') == 'marcador'}
        self.arquetipos = {g['en']: g['pt'] for g in self.glossario if g.get('tipo') == 'arquetipo'}
        # Alguns textos citam com outra caixa ("Beta The Magnet Warrior").
        self.caixa = {en.lower(): e['pt'] for en, e in self.nomes.items() if e.get('pt')}

    def nome(self, en):
        """Nome em PT de uma carta (nomes.json) ou de um nome citado entre aspas que não é carta do pool (glossário)."""
        entrada = self.nomes.get(en)
        return (entrada and entrada.get('pt')) or self.arquetipos.get(en) or self.caixa.get(en.lower())

    def frase(self, en):
        if en in self.marcadores:
            return self.marcadores[en]
        entrada = self.frases.get(en)
        return entrada and entrada.get('pt')

    def materiais(self, linha):
        nomes = CITACAO.findall(linha)
        if not all(self.nome(n) for n in nomes):
            return None
        return CITACAO.sub(lambda m: f'"{self.nome(m.group(1))}"', linha)

    def texto(self, desc):
        """desc em PT, ou None se faltar qualquer pedaço."""
        out = []
        for linha in linhas(desc):
            tipo = linha[0]
            if tipo in ('vazio', 'fixo'):
                out.append(linha[1])
            elif tipo == 'marcador':
                if linha[1] not in self.marcadores:
                    return None
                out.append(self.marcadores[linha[1]])
            elif tipo == 'materiais':
                if not (pt := self.materiais(linha[1])):
                    return None
                out.append(pt)
            else:
                _, partes, seps = linha
                pt = [self.frase(f) for f in partes]
                if not all(pt):
                    return None
                out.append(''.join(p + s for p, s in zip(pt, seps + [''])))
        return '\n'.join(out)

    def carta(self, nome_en, desc):
        """{name, desc} em PT quando o nome e todas as frases têm tradução; senão None (nunca meio a meio)."""
        nome = self.nome(nome_en)
        texto = nome and self.texto(desc)
        return {'name': nome, 'desc': texto} if texto else None


def pool():
    """Cartas do pool em inglês (id, tipo, nome, desc, lenda), como no build; marca as que já têm texto (ou só nome) manual."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('import_rush', HERE / 'import_rush.py')
    rush = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rush)
    if not rush.CDB.exists():
        sys.exit(f'falta {rush.CDB}: rode python3 -I tools/rush/import_rush.py fetch')
    manuais = rush.translations()
    cards = []
    for cid, ot, _, _, kind, *_, name_en, desc, _ in rush.pool():
        manual = manuais.get(rush.norm(name_en), {})
        cards.append({'id': cid, 'type': kind, 'legend': bool(ot & rush.OT_LEGEND), 'nameEn': name_en, 'desc': desc,
                      'manual': manual if manual.get('desc') else None, 'nomeManual': manual.get('name')})
    return cards


# ---- rótulos das perguntas do motor (str1..str16 do cdb; Rush e clássico) ----
# Rótulos curtos ("Destroy 1 Spell/Trap on your opponent's field ?") viram PT por gramática: os sintagmas de carta são
# reordenados ("1 face-up Level 4 monster" -> "1 monstro de Nível 4 com a face para cima") e o resto sai de trechos fixos.
# O que sobrar com palavra em inglês vai para frases.json (texto da carta) e, em último caso, para um rótulo genérico
# "Efeito de "Nome": <verbo>" — nunca inglês cru. Correções à mão: traducao/strings.json ({"en": "pt"}, chave sem "?" final).
STRINGS = PASTA / 'strings.json'
ATRIBUTOS = {'EARTH': 'TERRA', 'WATER': 'ÁGUA', 'FIRE': 'FOGO', 'WIND': 'VENTO', 'LIGHT': 'LUZ', 'DARK': 'TREVAS', 'DIVINE': 'DIVINO'}
TIPOS = {'Warrior': 'Guerreiro', 'Spellcaster': 'Mago', 'Fairy': 'Fada', 'Fiend': 'Demônio', 'Zombie': 'Zumbi', 'Machine': 'Máquina',
         'Aqua': 'Aqua', 'Pyro': 'Piro', 'Rock': 'Rocha', 'Winged Beast': 'Besta Alada', 'Plant': 'Planta', 'Insect': 'Inseto',
         'Thunder': 'Trovão', 'Dragon': 'Dragão', 'Beast': 'Besta', 'Beast-Warrior': 'Besta-Guerreira', 'Dinosaur': 'Dinossauro',
         'Fish': 'Peixe', 'Sea Serpent': 'Serpente Marinha', 'Reptile': 'Réptil', 'Psychic': 'Psíquico', 'Divine-Beast': 'Besta Divina',
         'Creator God': 'Deus Criador', 'Wyrm': 'Wyrm', 'Cyberse': 'Ciberso', 'Illusion': 'Ilusão', 'Cyborg': 'Ciborgue',
         'Magical Knight': 'Cavaleiro Mágico', 'High Dragon': 'Dragão Supremo', 'Omega Psychic': 'Psíquico Ômega',
         'Celestial Warrior': 'Guerreiro Celestial', 'Galaxy': 'Galáxia'}
_alt = lambda nomes: '|'.join(re.escape(n) for n in sorted(nomes, key=len, reverse=True))
_TIPO = rf'(?:{_alt(TIPOS)})'
_ATR = rf'(?:{_alt(ATRIBUTOS)})'
_NIVEL = r'Level \d+(?:-\d+)?(?: or (?:lower|higher|more|less|below|above|\d+))?'
_MOD = rf'(?:face-up|face-down|Attack Position|Defense Position|excavated|sent|other|non-Effect|Normal|Effect|Fusion|Ritual|Maximum|Legend|non-(?:Level \d+|\w+)|{_NIVEL}|{_ATR}(?:(?:/|, or |, | or ){_ATR})*|{_TIPO})(?:[ -](?:Type|Attribute))?'
_NUCLEO = r'(?:Monster Cards?|Spell/Trap Cards?|Spells?/Traps?|Spell Cards?|Trap Cards?|Spells?|Traps?|monsters?|monser|cards?)'
# Sintagma de carta: modificadores + núcleo ("face-up Level 4 LIGHT Machine monster"), ou modificadores terminando num Tipo ("Level 2 Psychic").
SINTAGMA = re.compile(rf'(?<![\w-])((?:{_MOD}\s+)*)({_NUCLEO})(?![\w-])|(?<![\w-])((?:{_MOD}\s+)*)({_TIPO})s?(?:[ -]Type)?(?: monsters?)?(?![\w-])', re.I)
_MOD_UM = re.compile(rf'{_MOD}', re.I)
NUCLEOS = {'spell/trap': ('Magia/Armadilha', 'f'), 'spell': ('Magia', 'f'), 'trap': ('Armadilha', 'f'), 'monster': ('monstro', 'm'),
           'monser': ('monstro', 'm'), 'card': ('carta', 'f')}
# Trechos fixos, em ordem (os mais longos e específicos antes). \N{...} não: tudo literal ou grupo numerado.
TRECHOS = [
    (r"\bfrom (?:the )?top of your Deck\b", 'do topo do seu Deck'),
    (r"\bthe top (\d+) cards of (?:your|their|your opponent's) Deck\b", r'as \1 cartas do topo do Deck'),
    (r"\b(?:the )?top card of (?:your|their|your opponent's) Deck\b", 'a carta do topo do Deck'),
    (r"\bthe top (\d+) cards\b", r'as \1 cartas do topo'), (r"\bthe top (\d+)\b", r'as \1 do topo'), (r"\bthe top card\b", 'a carta do topo'),
    (r"\bthis card's\b", 'desta carta'), (r"\bthis card\b", 'esta carta'), (r"\bthis monster\b", 'este monstro'),
    (r"\b(the |your )?(attacking|attacked|summoned|destroyed) monster\b",
     lambda m: ('o ' if m[1] else '') + 'monstro ' + {'attacking': 'atacante', 'attacked': 'atacado', 'summoned': 'Invocado', 'destroyed': 'destruído'}[m[2].lower()]),
    (r"\bthis card's (Level|ATK|DEF)\b", lambda m: ('o Nível' if m[1].lower() == 'level' else 'o ' + m[1]) + ' desta carta'),
    (r"\bnegate (?:the |an |that )?attack\b", 'Negar o ataque'), (r"\bto (?:your )?opponent\b", 'ao oponente'), (r"\s+(?:it|them)$", ''),
    (r"(\x00\d+\x00) (monster|card)(s)?\b", lambda m: ('monstro' if m[2].lower() == 'monster' else 'carta') + ('s' if m[3] else '') + ' ' + m[1]),
    (r"\b(?:your )?opponent'?s'? monsters'?\b", 'monstros do oponente'), (r"\b(?:your )?opponent(?:'s)? monster\b", 'monstro do oponente'),
    (r"\b(?:a |1 )?random card\b", 'uma carta aleatória'), (r"\b(\d+) random cards\b", r'\1 cartas aleatórias'),
    (r"\b(\d+) Set cards?\b", r'\1 carta(s) baixada(s)'), (r"^Set\b", 'Baixar'), (r"\bSelect (?:a |the |your )?targets?\b", 'Escolher o alvo'),
    (r"\bSpell Counters?\b", 'Marcador Mágico'), (r"\bA-Counters?\b", 'Marcador A'), (r"\b(\d+) damage\b", r'\1 de dano'),
    (r"\b(?:the )?declared Type\b", 'Tipo declarado'), (r"\bin a row\b", 'seguida'), (r"\bonce again\b", 'mais uma vez'),
    (r"\bthis face-up card\b", 'esta carta com a face para cima'), (r"\b(?:that|the chosen|the selected) monster'?s?\b", 'esse monstro'),
    (r"\b(?:that|the chosen|the selected) card\b", 'essa carta'), (r"\b(?:1 )?(?:the )?listed (monsters?|cards?)\b", 'uma das cartas listadas'),
    (r"\bof the listed (?:monsters|cards)\b", 'das cartas listadas'), (r"\b(\d+) of these effects\b", r'\1 destes efeitos'),
    (r"\bfrom (?:your )?opponent's hand\b", 'da mão do oponente'), (r"\bof your opponent's Deck\b", 'do Deck do oponente'),
    (r"\bopponent's top Deck\b", 'a carta do topo do Deck do oponente'), (r"\bto (?:the )?top of (?:its owner's |the owner's |the |your )?Deck\b", 'no topo do Deck'),
    (r"\bit face-up\b", 'com a face para cima'), (r"\bcards? to discard\b", 'cartas para descartar'),
    (r"\b(?:a )?number of cards\b", 'quantas cartas'), (r"\bhow many cards\b", 'quantas cartas'),
    (r"\bwith the same (name|Attribute|Type)\b", lambda m: 'com o mesmo ' + {'name': 'nome', 'attribute': 'Atributo', 'type': 'Tipo'}[m[1].lower()]),
    (r"\bField Spells?\b", 'Magia de Campo'), (r"\bEquip Spells?\b", 'Magia de Equipamento'), (r"\bQuick-Play Spells?\b", 'Magia Rápida'),
    (r"\bContinuous Traps?\b", 'Armadilha Contínua'), (r"\bContinuous Spells?\b", 'Magia Contínua'), (r"\bNormal Traps?\b", 'Armadilha Normal'),
    (r"\bContinuous Effects?\b", 'Efeito Contínuo'),
    (r"\bSpell (?:&|and) Trap Zone\b", 'Zona de Magias e Armadilhas'), (r"\bSpell/Trap Zone\b", 'Zona de Magias e Armadilhas'), (r"\bMonster Zone\b", 'Zona de Monstros'),
    (r"\binstead of destruction\b", 'em vez de ser destruída'), (r"\b(?:for )?the effect of\b", 'o efeito de'),
    (r"\b(becomes?) (%s)(?:[ -]Type)?\b" % _TIPO, lambda m: ('passa a ser' if m[1].lower() == 'becomes' else 'passar a ser') + ' do Tipo ' + _tipo(m[2])),
    (r"\b(becomes?) (%s)(?: Attribute)?\b" % _ATR, lambda m: ('passa a ser' if m[1].lower() == 'becomes' else 'passar a ser') + ' de ' + ATRIBUTOS[m[2].upper()]),
    (r"\b(gain|lose)s? attack\b", lambda m: ('ganhar' if m[1].lower() == 'gain' else 'perder') + ' ATK'),
    (r"\bchange (?:the )?battle positions?\b", 'Mudar a posição de batalha'), (r"\bchange (ATK|DEF)\b", r'Mudar o \1'),
    (r"\b(?:an |your |the )?opponent(?:'s)? monster's (ATK|DEF|battle position)\b", lambda m: ('a posição de batalha' if m[1].lower() == 'battle position' else 'o ' + m[1]) + ' do monstro do oponente'),
    (r"\b(?:a |1 )monster's (ATK|DEF|battle position)\b", lambda m: ('a posição de batalha' if m[1].lower() == 'battle position' else 'o ' + m[1]) + ' de um monstro'),
    (r"\bunable to be destroyed\b", 'ficar indestrutível'), (r"^Tribute(?! Summon)\b", 'Oferecer como Tributo'), (r"^Treat as (\d+) (?:Tributes|materials)\b", r'Valer como \1 Tributos'),
    (r"\bto treat as (\d+) Tributes\b", r'para valer como \1 Tributos'),
    (r"\b(?:your )?opponent's ((?:face-up |face-down )?(?:monsters?|cards?|Spells?/Traps?)|hand|Deck)\b",
     lambda m: ({'hand': 'a mão', 'deck': 'o Deck', 'field': 'o campo'}.get(m[1].lower()) or SINTAGMA.sub(_sintagma, m[1])) + ' do oponente'),
    (r"\bby (\d+)\b", r'em \1'), (r"\b(\d+) additional cards?\b", lambda m: m[1] + (' carta adicional' if m[1] == '1' else ' cartas adicionais')),
    (r"\b(\d+) appropriate cards?\b", lambda m: m[1] + (' carta adequada' if m[1] == '1' else ' cartas adequadas')),
    None,  # aqui entra o sintagma de carta
    (r"\bon (?:the )?top of (?:the |your )?Deck\b", 'no topo do Deck'), (r"\bon (?:the )?bottom of (?:the |your )?Deck\b", 'no fundo do Deck'),
    (r"\bon top\b", 'no topo'), (r"\bon (?:the )?bottom\b", 'no fundo'), (r"\bat (?:the )?bottom of (?:the )?deck\b", 'no fundo do Deck'),
    (r"\b(?:in|on) your opponent's field\b", 'no campo do oponente'), (r"\bon the opponent's field\b", 'no campo do oponente'),
    (r"\bto your opponent's field\b", 'para o campo do oponente'), (r"\bfrom your opponent's field\b", 'do campo do oponente'),
    (r"\b(?:on|in) your field\b", 'no seu campo'), (r"\bto your field\b", 'para o seu campo'), (r"\bfrom your field\b", 'do seu campo'),
    (r"\b(?:on|in) the field\b", 'no campo'), (r"\bfrom the field\b", 'do campo'), (r"\bon field\b", 'no campo'),
    (r"\b(?:that )?(?:your|the) opponent controls?\b", 'que o oponente controla'), (r"\b(?:that )?you control\b", 'que você controla'),
    (r"\bfrom (?:your |the )?(?:Graveyard|GY|grave)\b", 'do Cemitério'), (r"\bfrom your opponent's (?:Graveyard|GY)\b", 'do Cemitério do oponente'),
    (r"\bfrom each player's (?:Graveyard|GY)\b", 'do Cemitério de cada jogador'),
    (r"\bin (?:your |the |their )?(?:Graveyard|GY)s?\b", 'no Cemitério'), (r"\bto (?:your |the |their )?(?:Graveyard|GY|grave)\b", 'para o Cemitério'),
    (r"\bfrom (?:your |the )?hand\b", 'da mão'), (r"\bfrom (?:your |the )?Deck\b", 'do Deck'), (r"\bfrom (?:your |the )?Extra Deck\b", 'do Deck Adicional'),
    (r"\bto (?:your |the |their |its )?(?:owner'?s'? )?hand\b", 'à mão'), (r"\binto (?:your |the |their )?Deck\b", 'no Deck'),
    (r"\bto (?:the |your |their |its owner's )?Deck\b", 'para o Deck'), (r"\b(?:the )?Extra Deck\b", 'Deck Adicional'),
    (r"\b(?:the |your )?(?:Graveyard|GY|Graveayrd)\b", 'Cemitério'), (r"\byour opponent's hand\b", 'a mão do oponente'),
    (r"\byour hand\b", 'sua mão'), (r"\bhand size limit\b", 'limite de cartas na mão'), (r"\bin hand\b", 'na mão'), (r"\bhand\b", 'mão'),
    (r"\buntil the end of (?:this|the) turn\b", 'até o fim do turno'), (r"\bthis turn\b", 'neste turno'), (r"\bnext turn\b", 'no próximo turno'),
    (r"\bface-up Attack Position\b", 'Posição de Ataque com a face para cima'), (r"\bface-up Defense Position\b", 'Posição de Defesa com a face para cima'),
    (r"\bface-down Defense Position\b", 'Posição de Defesa com a face para baixo'), (r"\bface-down Defense\b", 'Defesa com a face para baixo'),
    (r"\bface-up Defense\b", 'Defesa com a face para cima'), (r"\bface-up Attack\b", 'Ataque com a face para cima'),
    (r"\bAttack Position\b", 'Posição de Ataque'), (r"\bDefense Position\b", 'Posição de Defesa'), (r"\bbattle position\b", 'posição de batalha'),
    (r"\bDefense\b", 'Defesa'), (r"\bface-up\b", 'com a face para cima'), (r"\bface-down\b", 'com a face para baixo'),
    (r"\bMain Phase\b", 'Fase Principal'), (r"\bBattle Phase\b", 'Fase de Batalha'), (r"\bEnd Phase\b", 'Fase Final'), (r"\bDraw Phase\b", 'Fase de Compra'),
    (r"\bStandby Phase\b", 'Fase de Apoio'), (r"\bbattle damage\b", 'dano de batalha'), (r"\beffect damage\b", 'dano de efeito'),
    (r"\bdirect attack\b", 'ataque direto'), (r"\battack directly\b", 'atacar diretamente'), (r"\bpiercing(?: damage)?\b", 'dano de perfuração'),
    (r"\b(?:Life Points|LP)\b", 'PV'), (r"\b(\d+) ?PV\b", r'\1 PV'),
    (r"\boriginal ATK\b", 'ATK original'), (r"\b(\d+) (ATK/DEF|ATK|DEF)\b", r'\1 de \2'), (r"\battack points\b", 'ATK'),
    (r"\b(\d+) (?:or more|or higher)\b", r'\1 ou mais'), (r"\b(\d+) or (?:less|lower)\b", r'\1 ou menos'), (r"\bor (?:less|lower)\b", 'ou menos'), (r"\bor (?:more|higher)\b", 'ou mais'),
    (r"\bLevel\b", 'Nível'), (r"\blevels?\b", 'Nível'), (r"\bType\b", 'Tipo'), (r"\bAttribute\b", 'Atributo'),
    (r"\bcounters?\b", 'marcador'),
    (r"\bTokens?\b", 'Ficha'), (r"\btoken\b", 'Ficha'), (r"\bChain\b", 'Corrente'),
    (r"\b(?:the )?attack target\b", 'o alvo do ataque'),
    (r"\byour opponent's\b", 'do oponente'), (r"\byour opponent\b", 'o oponente'), (r"\bthe opponent\b", 'o oponente'), (r"\bopponent's\b", 'do oponente'),
    (r"\bopponent\b", 'oponente'), (r"\bboth players\b", 'ambos os jogadores'), (r"\beach player\b", 'cada jogador'),
    (r"\bcard effects?\b", 'efeitos de cartas'), (r"\bits effects?\b", 'os efeitos dele'), (r"\beffects\b", 'efeitos'), (r"\beffect\b", 'efeito'),
    (r"\bby battle\b", 'em batalha'), (r"\bbattle\b", 'batalha'), (r"\bdamage\b", 'dano'),
    # Invocações (antes dos verbos soltos).
    (r"\bSpecial Summoned\b", 'Invocado por Especial'), (r"\bNormal Summoned\b", 'Invocado por Normal'), (r"\bTribute Summoned\b", 'Invocado por Tributo'),
    (r"\bSpecial Summons\b", 'Invocações-Especiais'), (r"\bTribute Summons\b", 'Invocações-Tributo'),
    (r"\bSpecial Summon\b", 'Invocar por Especial'), (r"\bNormal Summon/Set\b", 'Invocar por Normal ou Baixar'), (r"\bNormal Summon\b", 'Invocar por Normal'),
    (r"\bTribute Summon\b", 'Invocar por Tributo'), (r"\bFusion Summon\b", 'Invocar por Fusão'), (r"\bRitual Summon\b", 'Invocar por Ritual'),
    (r"\bFlip Summon\b", 'Invocar por Virada'), (r"\bMaximum Summon\b", 'Invocar no Modo Máximo'), (r"\bSummon\b", 'Invocar'),
    (r"\bwithout Tributing\b", 'sem Tributo'), (r"\bwithout (?:a )?Tributes?\b", 'sem Tributo'), (r"\bby Tributing\b", 'oferecendo como Tributo'),
    (r"\bTributing\b", 'oferecendo como Tributo'), (r"\btreated as (\d+)\b", r'que valem \1'), (r"\bwith (\d+) Tributes?\b", r'com \1 Tributo(s)'),
    (r"\bTributes?\b", 'Tributo'), (r"\bTribute\b", 'Tributo'), (r"\bMaximum Mode\b", 'Modo Máximo'),
    # Verbos: 3ª pessoa ("this card gains") e infinitivo (rótulo de ação).
    (r"\bgains\b", 'ganha'), (r"\bgain\b", 'ganhar'), (r"\bloses\b", 'perde'), (r"\blose\b", 'perder'), (r"\bbecomes\b", 'passa a ser'),
    (r"\bbecome\b", 'passar a ser'), (r"\bName becomes\b", 'O nome passa a ser'), (r"\bName change\b", 'Mudar o nome'),
    (r"\bChange name to\b", 'Mudar o nome para'), (r"\bChange (?:the )?name\b", 'Mudar o nome'), (r"\bChange Position\b", 'Mudar a posição'),
    (r"\bTake control of\b", 'Tomar o controle de'), (r"\bTake control\b", 'Tomar o controle'), (r"\bSwitch control\b", 'Trocar o controle'),
    (r"\bLook at\b", 'Olhar'), (r"\bCoin toss\b", 'Lançar uma moeda'), (r"\bRoll a (?:six-sided )?die\b", 'Jogar um dado'),
    (r"\bdice roll\b", 'resultado do dado'), (r"\bAttack again\b", 'Atacar de novo'), (r"\bAttack twice\b", 'Atacar duas vezes'),
    (r"\bcan attack (\d+) times\b", r'pode atacar \1 vezes'), (r"\bup to\b", 'até'), (r"\bequal to\b", 'igual a'),
    (r"^Affected by\b", 'Afetado por'), (r"\bFlip into\b", 'Virar para'), (r"\bChanged to\b", 'Mudado para'), (r"\bBack to\b", 'Voltar para'),
    (r"\bCan (?:make multiple attacks|attack multiple times)\b", 'Pode atacar várias vezes'), (r"\b(?:Multiple|Double) attacks?\b", 'Ataques múltiplos'),
    (r"\b(?:attack|attacks) (three times|thrice)\b", 'atacar três vezes'), (r"\b(?:Grant|give) piercing\b", 'Dar dano de perfuração'),
    (r"\bAllow (?:monsters to )?(?:attack directly|direct attack)\b", 'Permitir ataque direto'), (r"\bBattle protection\b", 'Proteção em batalha'),
    (r"\b(?:Self[ -]Destruct|Destroy immediately)\b", 'Destruir'), (r"\bLP Recovery\b", 'Recuperar PV'), (r"\bSpell recovery\b", 'Recuperar Magia'),
    (r"\bS/T Destruction\b", 'Destruir Magia/Armadilha'), (r"\bSwitch attack target\b", 'Trocar o alvo do ataque'), (r"^Heads?$", 'Cara'), (r"^Tails?$", 'Coroa'),
    (r"\bApply (restriction|protection)\b", lambda m: 'Aplicar ' + ('restrição' if m[1].lower() == 'restriction' else 'proteção')),
    (r"\b(?:Take|takes) no damage\b", 'Não sofrer dano'), (r"\b(?:Take|takes) (\d+) damage\b", r'Sofrer \1 de dano'),
    (r"\bindestructible\b", 'indestrutível'), (r"\b(?:unable to be destroyed|cannot be destroyed)\b", 'não pode ser destruído'),
    (r"\b(?:able to )?attack twice\b", 'atacar duas vezes'), (r"\bhalve (?:its|their) ATK\b", 'reduzir o ATK à metade'),
    (r"\bas (\d+) Tributes\b", r'como \1 Tributos'), (r"\b(?:treat|treated) as (\d+) (?:Tributes|materials)\b", r'que vale \1 Tributos'),
    (r"\bTribute this card\b", 'Oferecer esta carta como Tributo'), (r"\b(?:by )?using\b", 'usando'), (r"\bappropriate\b", 'adequada'),
    (r"\bcurrently\b", ''), (r"\bdepending on\b", 'conforme'), (r"\bbased on the result\b", 'conforme o resultado'), (r"\bresult\b", 'resultado'),
    (r"\bChange Monster Zone\b", 'Mudar de Zona de Monstros'), (r"\b(?:Toss a coin|Coin toss)\b", 'Lançar uma moeda'), (r"\bneither player\b", 'nenhum jogador'),
    (r"\bamong\b", 'entre'), (r"\bduring\b", 'durante'), (r"\bnext\b", 'próximo'), (r"\balso\b", 'e'), (r"\bonly\b", 'só'), (r"\bonce\b", 'uma vez'),
    (r"\bentire\b", 'inteira'), (r"\bimmediately\b", 'imediatamente'), (r"\bthat\b", 'esse'), (r"\bthese\b", 'estes'), (r"\bthis\b", 'este'),
    (r"\bwhich\b", 'que'), (r"\bsame\b", 'mesmo'), (r"\bdifferent\b", 'diferente'), (r"\buntil\b", 'até'), (r"\bremove\b", 'remover'),
    (r"\bhave\b", 'ter'), (r"\byou\b", 'você'), (r"\bmaterials?\b", 'matéria'), (r"\bprotection\b", 'proteção'), (r"\btoss\b", 'lançar'),
    (r"\bcoin\b", 'moeda'), (r"\bdice|die\b", 'dado'), (r"\broll\b", 'resultado'), (r"\bnumber\b", 'número'), (r"\binto\b", 'para'),
    (r"\bShuffles?\b", 'Embaralhar'), (r"\bSpecial\b", 'Especial'),
    (r"\bdestroys?\b", 'destruir'), (r"\bdestruction\b", 'destruição'), (r"\bdraws?\b", 'comprar'), (r"\bsends?\b", 'mandar'),
    (r"\badds?\b", 'adicionar'), (r"\breturns?\b", 'devolver'), (r"\bbanish(?:es)?\b", 'banir'), (r"\bdiscards?\b", 'descartar'),
    (r"\bexcavate\b", 'escavar'), (r"\bequip\b", 'equipar'), (r"\bincrease\b", 'aumentar'), (r"\b(?:decrease|reduce)\b", 'reduzir'),
    (r"\binflict\b", 'causar'), (r"\brecover\b", 'recuperar'), (r"\bchange\b", 'mudar'), (r"\bnegate\b", 'negar'), (r"\bactivate\b", 'ativar'),
    (r"\bplace\b", 'colocar'), (r"\breveal\b", 'revelar'), (r"\bdeclare\b", 'declarar'), (r"\bpay\b", 'pagar'), (r"\bselect\b", 'escolher'),
    (r"\bchoose\b", 'escolher'), (r"\bsearch\b", 'procurar'), (r"\bset\b", 'Baixar'), (r"\bmake\b", 'fazer'), (r"\bgive\b", 'dar'),
    (r"\bprevent\b", 'impedir'), (r"\bskip\b", 'pular'), (r"\bflip\b", 'virar'), (r"\btarget\b", 'escolher como alvo'), (r"\bput\b", 'colocar'),
    (r"\bmove\b", 'mover'), (r"\bconfirm\b", 'confirmar'), (r"\buse\b", 'usar'), (r"\bapply\b", 'aplicar'), (r"\bpierce\b", 'causar dano de perfuração'),
    (r"\battacks\b", 'ataques'), (r"\battack\b", 'atacar'), (r"\bcannot\b", 'não pode'), (r"\bcan\b", 'pode'),
    (r"\bimmune\b", 'imune'), (r"\bunable to\b", 'incapaz de'), (r"\brandom(?:ly)?\b", 'aleatória'),
    (r"\bNormal\b", 'Normal'), (r"\bFusion\b", 'Fusão'), (r"\bRitual\b", 'Ritual'), (r"\bMaximum\b", 'Máximo'), (r"\bLegend\b", 'Lenda'),
    (r"\bthen\b", 'e depois'), (r"\band/or\b", 'e/ou'), (r"\band\b", 'e'), (r"\bor\b", 'ou'), (r"\binstead\b", 'em vez disso'),
    (r"\bequal\b", 'igual'), (r"\bwith\b", 'com'), (r"\bwithout\b", 'sem'), (r"\bfrom\b", 'de'), (r"\bfor each\b", 'para cada'),
    (r"\bto\b", 'para'), (r"\bof\b", 'de'), (r"\bthe\b", 'o'), (r"\ban?\b", 'um'), (r"\bone\b", 'um'), (r"\bits\b", 'seu'),
    (r"\byour\b", 'seu'), (r"\btheir\b", 'seu'), (r"\bit\b", 'o'), (r"\bthem\b", 'os'), (r"\ball\b", 'todos os'), (r"\beach\b", 'cada'),
    (r"\bmore\b", 'mais'), (r"\badditional\b", 'adicional'), (r"\bagain\b", 'de novo'), (r"\btimes\b", 'vezes'), (r"\btwice\b", 'duas vezes'),
    (r"\bon\b", 'em'), (r"\bin\b", 'em'), (r"\bby\b", 'por'), (r"\bwhile\b", 'enquanto'), (r"\bwhen\b", 'quando'), (r"\bif\b", 'se'),
    (r"\bturn\b", 'turno'), (r"\bfield\b", 'campo'), (r"\bplayer\b", 'jogador'), (r"\bLP\b", 'PV'), (r"\bname\b", 'nome'),
    (r"\bposition\b", 'posição'), (r"\bcontrol\b", 'controle'), (r"\bequal\b", 'igual'), (r"\bdeck\b", 'Deck'), (r"\bdifference\b", 'diferença'),
]
TRECHOS = [t and (re.compile(t[0], re.I), t[1]) for t in TRECHOS]
ERROS = [(r'(?i)\bsumon\b|\bsmmon\b', 'Summon'), (r'(?i)\bmon?sers?\b|\bmosters?\b', 'monsters'), (r'\byuor\b', 'your'), (r'\byou Deck\b', 'your Deck'), (r'[“”]', '"'), (r'^Excavated\b', 'Excavate'),
         (r'\bTrbuting\b', 'Tributing'), (r'\bGrvaveyard\b', 'Graveyard'), (r'\bFuson\b', 'Fusion'),
         (r'\bose\b', 'lose'), (r'six-dided', 'six-sided'), (r'(?i)\bAdd(\d)', r'Add \1'), (r'(?i)\bGraveayrd\b', 'Graveyard'),
         (r'(?i)\bcontrol loses\b', 'controls lose'), (r'\bGrave\b', 'Graveyard')]
CONCORDANCIA = [(r'\btodos os (?=(?:Magias|Armadilhas|cartas)\b)', 'todas as'), (r'\bseu (?=cartas?\b|Magias?\b|Armadilhas?\b|mão\b)', 'sua '),
                (r'\bsua (?=cartas\b|Magias\b|Armadilhas\b)', 'suas '), (r'\bseu (?=monstros\b)', 'seus '), (r'\bo oponente cartas\b', 'cartas do oponente'),
                (r'\bde (ess|est)([ea]s?)\b', r'd\1\2'), (r'\bem (ess|est)([ea]s?)\b', r'n\1\2'), (r'\bem o(s?)\b', r'no\1'), (r'\bem a(s?)\b', r'na\1'),
                (r'\bde o(s?)\b', r'do\1'), (r'\bde a(s?)\b', r'da\1')]
# Palavras que existem igual nas duas línguas (não contam como inglês sobrando).
IGUAIS = {'atk', 'def', 'pv', 'deck', 'normal', 'ritual', 'a', 'o', 'e', 'x', 'total', 'mega', 'super', 'aqua', 'wyrm', 'ninja'}
VERBO_GENERICO = [('special summon', 'Invocar por Especial'), ('fusion summon', 'Invocar por Fusão'), ('ritual summon', 'Invocar por Ritual'),
                  ('tribute summon', 'Invocar por Tributo'), ('normal summon', 'Invocar por Normal'), ('destroy', 'Destruir'),
                  ('draw', 'Comprar'), ('send', 'Mandar ao Cemitério'), ('add', 'Adicionar à mão'), ('return', 'Devolver'),
                  ('banish', 'Banir'), ('discard', 'Descartar'), ('shuffle', 'Embaralhar no Deck'), ('excavate', 'Escavar'),
                  ('equip', 'Equipar'), ('gain', 'Ganhar'), ('increase', 'Aumentar'), ('reduce', 'Reduzir'), ('decrease', 'Reduzir'),
                  ('make', 'Aplicar'), ('inflict', 'Causar dano'), ('recover', 'Recuperar'), ('change', 'Mudar'), ('negate', 'Negar'),
                  ('activate', 'Ativar'), ('place', 'Colocar'), ('set', 'Baixar'), ('take control', 'Tomar o controle'), ('pay', 'Pagar'),
                  ('attack', 'Atacar'), ('look', 'Olhar'), ('reveal', 'Revelar'), ('declare', 'Declarar')]


def _tipo(en):
    return next((pt for k, pt in TIPOS.items() if k.lower() == en.lower()), None)


def _sintagma(m):
    """'face-up Level 4 LIGHT Machine monster' -> 'monstro Máquina de LUZ de Nível 4 com a face para cima'."""
    mods_txt, nucleo, mods_tipo, tipo_nucleo = m.groups()
    mods = _MOD_UM.findall(mods_txt or mods_tipo or '')
    if nucleo:
        low = nucleo.lower()
        plural = low.endswith('s')
        nome, genero = NUCLEOS[re.sub(r's\b', '', re.sub(r' cards?$', '', low))]
        if plural:
            nome = '/'.join(p + 's' for p in nome.split('/'))
    else:
        nome, genero, plural = _tipo(tipo_nucleo), 'm', m.group(0).rstrip().lower().endswith('s')
    outro, tipo, classe, atr, nivel, face, extra = '', '', [], '', '', '', []
    for mod in mods:
        base = re.sub(r'(?i)[ -](?:Type|Attribute)$', '', mod)
        low = base.lower()
        if low == 'other':
            outro = ('outras' if plural else 'outra') if genero == 'f' else ('outros' if plural else 'outro')
        elif low in ('face-up', 'face-down'):
            face = 'com a face para cima' if low == 'face-up' else 'com a face para baixo'
        elif low in ('attack position', 'defense position'):
            extra.append('em Posição de ' + ('Ataque' if low.startswith('attack') else 'Defesa'))
        elif low.startswith('level'):
            n = re.match(r'(?i)level (\d+)(?:-(\d+))?(?: or (\w+))?', base)
            ou = (n[3] or '').lower()
            nivel = f'de Nível {n[1]}' + (f' a {n[2]}' if n[2] else '') + (f' ou {ou}' if ou.isdigit() else ' ou menor' if ou in ('lower', 'less', 'below') else ' ou maior' if ou else '')
        elif low.startswith('non-'):
            resto = base[4:]
            nao = re.sub(r'(?i)^Level (\d+)$', r'de Nível \1', resto)
            nao = _tipo(resto) or {'effect': 'de Efeito', 'fusion': 'de Fusão', 'maximum': 'Máximo', 'legend': 'Lenda', 'normal': 'Normal'}.get(resto.lower(), nao)
            extra.append(f'que não seja {nao}')
        elif re.fullmatch(rf'{_ATR}(?:(?:/|, or |, | or ){_ATR})*', base) and base.isupper():
            nomes = [ATRIBUTOS[a] for a in re.findall(_ATR, base)]
            atr = 'de ' + (' ou '.join([', '.join(nomes[:-1]), nomes[-1]]) if len(nomes) > 1 else nomes[0])
        elif _tipo(base):
            tipo = _tipo(base)
        else:
            fem = genero == 'f'
            (extra if low in ('excavated', 'sent') else classe).append({'normal': 'Normal', 'effect': 'de Efeito', 'non-effect': 'sem Efeito', 'fusion': 'de Fusão', 'ritual': 'de Ritual',
                           'maximum': 'Máximo', 'legend': 'Lenda', 'excavated': ('escavadas' if plural else 'escavada') if fem else ('escavados' if plural else 'escavado'),
                           'sent': ('mandadas' if plural else 'mandada') if fem else ('mandados' if plural else 'mandado')}.get(low, base))
    if nome in ('Magia', 'Magias') and 'de Ritual' in classe:  # Ritual Spell
        classe.remove('de Ritual'); nome += ' de Ritual'
    partes = [outro, nome, tipo, *classe, atr, nivel, face, *extra]
    return ' '.join(p for p in partes if p)


class Rotulos:
    """Traduz os rótulos de efeito (strings do cdb). nome(en) -> nome em PT de uma carta citada (ou None)."""

    def __init__(self, nome=lambda en: None):
        self.nome = nome
        self.manuais = {k.lower(): v for k, v in ler(STRINGS, {}).items()}
        self.frases = {k.lower().rstrip('.!?'): e['pt'] for k, e in ler(FRASES, {}).items() if e.get('pt')}
        self.contagem = Counter()

    def gramatica(self, texto):
        """PT pela gramática, ou None se sobrar inglês. Cada pedaço traduzido vira um marcador (\x00n\x00) para as regras
        seguintes não o traduzirem de novo; sobrou palavra fora dos marcadores = não deu."""
        feitos = []

        def guarda(pt):
            feitos.append(pt)
            return f'\x00{len(feitos) - 1}\x00'
        t = re.sub(r'(?i)^(?:would you like to|do you want to|please|you can)\s+', '', texto)
        for errado, certo in ERROS:
            t = re.sub(errado, certo, t)
        t = CITACAO.sub(lambda m: guarda(f'"{self.nome(m.group(1)) or m.group(1)}"'), t)
        for regra in TRECHOS:
            if regra is None:
                t = SINTAGMA.sub(lambda m: guarda(_sintagma(m)), t)
            else:
                t = regra[0].sub(lambda m, pt=regra[1]: guarda(pt(m) if callable(pt) else m.expand(pt)), t)
        sobra = [p for p in re.findall(r"[A-Za-z'-]+", t) if p.lower() not in IGUAIS]
        if sobra:
            return None
        while '\x00' in t:
            t = re.sub('\x00(\\d+)\x00', lambda m: feitos[int(m.group(1))], t)
        for errado, certo in CONCORDANCIA:
            t = re.sub(errado, certo, t)
        return re.sub(r'\s+', ' ', t).strip()

    def traduzir(self, texto, carta, indice=0):
        """Rótulo em PT. carta = nome em PT da carta dona do rótulo (para o rótulo genérico)."""
        bruto = (texto or '').strip()
        if not bruto:
            return bruto
        pergunta = bruto.endswith('?')
        nucleo = re.sub(r'\s+', ' ', re.sub(r'[\s?.!]+$', '', bruto))
        chave = nucleo.lower()
        pt, origem = self.manuais.get(chave), 'manual'
        if not pt:
            pt, origem = self.gramatica(nucleo) if re.search(r'[A-Za-z]{2}', nucleo) else None, 'gramatica'
        if not pt and chave in self.frases:
            pt, origem = self.frases[chave].rstrip('.'), 'frases'
        if not pt:
            verbo = next((v for en, v in VERBO_GENERICO if chave.startswith(en)), None)
            pt, origem = f'Efeito de "{carta}"' + (f': {verbo}' if verbo else f' ({indice + 1})'), 'generico'
            pergunta = False
        self.contagem[origem] += 1
        pt = pt[0].upper() + pt[1:]
        return pt + '?' if pergunta and not pt.endswith('?') else pt


# ---- verificações ----
def termos_glossario(glossario):
    """(regex do termo em inglês, formas aceitas em PT, entrada) dos termos que a tradução tem de respeitar.
    O termo casa como palavra, com plural e flexões ("Summon" pega "Summoned", "Spell" não pega "Spellcaster");
    só os em maiúsculas (LIGHT, ATK) e os com caixa: true
    (Tipos, "Set") olham a caixa.
    A frase em PT tem de conter (sem olhar a caixa) o pt ou uma das formas de "aceita"; verificar: false = só referência."""
    out = []
    for g in glossario:
        if g.get('tipo') != 'termo' or g.get('verificar') is False:
            continue
        aceitas = [g['pt'], *g.get('aceita', [])]
        flags = 0 if g['en'].isupper() or g.get('caixa') else re.IGNORECASE
        out.append((re.compile(r'(?<![\w-])' + re.escape(g['en']) + r'(?:s|es|ed|d|ing)?(?![\w-])', flags), [a.lower() for a in aceitas], g))
    return out


def verificar_frase(en, pt, memoria, termos):
    """Lista de problemas da tradução de uma frase (vazia = passou)."""
    problemas = []
    if not pt or not pt.strip():
        return ['tradução vazia']
    if Counter(NUMERO.findall(fora_das_aspas(en))) != Counter(NUMERO.findall(fora_das_aspas(pt))):
        problemas.append(f'números diferentes: {NUMERO.findall(fora_das_aspas(en))} -> {NUMERO.findall(fora_das_aspas(pt))}')
    # Marcadores em maiúsculas saem do glossário; os outros colchetes são contas ("[the number of ...] x 300") e só contam.
    colchetes = lambda t: re.findall(r'\[[^\]]+\]', fora_das_aspas(t))
    marcas = lambda lista: [m for m in lista if MARCADOR.match(m)]
    if [memoria.marcadores.get(m, m) for m in marcas(colchetes(en))] != marcas(colchetes(pt)) or len(colchetes(en)) != len(colchetes(pt)):
        problemas.append(f'colchetes diferentes: {colchetes(en)} -> {colchetes(pt)}')
    citados_pt = CITACAO.findall(pt)
    if len(CITACAO.findall(en)) != len(citados_pt):
        problemas.append('quantidade de nomes entre aspas diferente')
    for citado in CITACAO.findall(en):
        nome = memoria.nome(citado)
        if not nome:
            problemas.append(f'carta citada sem nome em PT: "{citado}"')
        elif nome not in citados_pt:
            problemas.append(f'carta citada com outro nome: esperado "{nome}"')
    texto_pt = fora_das_aspas(pt).lower()
    for regex, aceitas, g in termos:
        if regex.search(fora_das_aspas(en)) and not any(a in texto_pt for a in aceitas):
            problemas.append(f'glossário: "{g["en"]}" pede "{g["pt"]}"')
    for g in memoria.glossario:
        for proibido in g.get('proibe', []):
            if re.search(r'(?<![\w-])' + re.escape(proibido) + r'(?![\w-])', fora_das_aspas(pt)):
                problemas.append(f'glossário: "{proibido}" não pode aparecer (use "{g["pt"]}")')
    sobra = sorted({p for p in re.findall(r"[A-Za-z'-]+", fora_das_aspas(pt)) if p.lower() in INGLES})
    if sobra:
        problemas.append(f'inglês sobrando: {", ".join(sobra)}')
    if len(en) >= 25 and not 0.6 <= len(pt) / len(en) <= 2.0:
        problemas.append(f'tamanho fora da faixa ({len(en)} -> {len(pt)} caracteres)')
    return problemas


def verificar_nome(en, pt):
    problemas = []
    if not pt or not pt.strip():
        return ['tradução vazia']
    for sufixo in ('[L]', '[R]'):
        if en.endswith(sufixo) != pt.endswith(sufixo):
            problemas.append(f'peça de Máximo: {sufixo} tem de continuar no fim')
    if Counter(NUMERO.findall(en)) != Counter(NUMERO.findall(pt)):
        problemas.append('números diferentes')
    if '"' in pt:
        problemas.append('nome com aspas')
    return problemas


# ---- comandos ----
def cmd_medir():
    memoria = Memoria()
    cards = pool()
    sem_pt = [c for c in cards if not c['manual']]
    todas = Counter(f for c in sem_pt for f in frases(c['desc']))
    moldes = Counter(molde(f) for f in todas.elements())
    total = sum(todas.values())
    comuns = sum(n for _, n in todas.most_common(300))
    traduzidas = sum(n for f, n in todas.items() if memoria.frase(f))
    nomes = {c['nameEn'] for c in sem_pt}
    prontas = sum(1 for c in sem_pt if memoria.carta(c['nameEn'], c['desc']))
    print(f'cartas no pool: {len(cards)} | com texto manual: {len(cards) - len(sem_pt)} | sem: {len(sem_pt)}')
    print(f'frases: {total} | únicas: {len(todas)} ({len(moldes)} trocando nomes e números por marcadores)')
    print(f'as 300 mais comuns cobrem {100 * comuns / max(total, 1):.0f}% | palavras: {sum(len(f.split()) for f in todas.elements())}')
    print(f'nomes: {len(nomes)} ({sum(1 for n in nomes if memoria.nome(n))} traduzidos)')
    print(f'frases traduzidas: {sum(1 for f in todas if memoria.frase(f))} únicas, {100 * traduzidas / max(total, 1):.1f}% do texto')
    print(f'cartas inteiras em PT pela memória: {prontas}')


def pendencias(cards, memoria):
    nomes, frases_ = Counter(), Counter()
    for c in cards:
        if c['manual']:
            continue
        if not memoria.nome(c['nameEn']):
            nomes[c['nameEn']] += 1
        for f in frases(c['desc']):
            if not memoria.frase(f):
                frases_[f] += 1
        # Cartas citadas (efeitos e matérias de Fusão) precisam de nome antes da frase.
        for citado in CITACAO.findall(c['desc']):
            if not memoria.nome(citado):
                nomes[citado] += 1
    return nomes, frases_


def cmd_pendentes(args):
    memoria = Memoria()
    cards = pool()
    if '--cartas' in args:
        ids = {int(i) for i in args[args.index('--cartas') + 1].split(',') if i}
        cards = [c for c in cards if c['id'] in ids]
    top = int(args[args.index('--top') + 1]) if '--top' in args else None
    nomes, frases_ = pendencias(cards, memoria)
    if '--json' in args:
        lote = {'nomes': {n: '' for n, _ in nomes.most_common(top)}, 'frases': {f: '' for f, _ in frases_.most_common(top)}}
        print(json.dumps(lote, ensure_ascii=False, indent=1))
        return
    print(f'nomes sem tradução: {len(nomes)} | frases sem tradução: {len(frases_)} ({sum(frases_.values())} ocorrências)')
    for f, n in frases_.most_common(top or 30):
        print(f'{n:5}  {f}')


def cmd_verificar():
    memoria = Memoria()
    termos = termos_glossario(memoria.glossario)
    falhas = 0
    for en, e in memoria.nomes.items():
        for p in verificar_nome(en, e.get('pt')):
            falhas += 1
            print(f'NOME  {en}: {p}')
    for en, e in memoria.frases.items():
        for p in verificar_frase(en, e.get('pt'), memoria, termos):
            falhas += 1
            print(f'FRASE {en}\n      {e.get("pt")}\n      -> {p}')
    for i, g in enumerate(memoria.glossario):
        if not g.get('en') or not g.get('pt') or g.get('tipo') not in ('termo', 'arquetipo', 'marcador'):
            falhas += 1
            print(f'GLOSSÁRIO #{i}: precisa de en, pt e tipo (termo|arquetipo|marcador)')
    print(f'{len(memoria.nomes)} nomes, {len(memoria.frases)} frases, {len(memoria.glossario)} termos | problemas: {falhas}')
    return 1 if falhas else 0


def cmd_aplicar(args):
    if not args:
        sys.exit('uso: traducao.py aplicar <lote.json> [--origem automatica|revisada|manual|oficial]')
    origem = args[args.index('--origem') + 1] if '--origem' in args else 'automatica'
    if origem not in ORIGENS:
        sys.exit(f'origem inválida: {origem}')
    lote = json.loads(Path(args[0]).read_text())
    memoria = Memoria()
    usos = Counter(f for c in pool() if not c['manual'] for f in frases(c['desc']))
    recusados = 0

    # Nomes primeiro: as frases do mesmo lote podem citar esses nomes.
    for en, pt in lote.get('nomes', {}).items():
        atual = memoria.nomes.get(en, {})
        if atual.get('origem') in FIXAS and origem not in FIXAS:
            continue
        if problemas := verificar_nome(en, pt):
            recusados += 1
            print(f'NOME recusado {en}: {"; ".join(problemas)}')
            continue
        memoria.nomes[en] = {'pt': pt.strip(), 'origem': origem}
    termos = termos_glossario(memoria.glossario)
    for en, pt in lote.get('frases', {}).items():
        atual = memoria.frases.get(en, {})
        if atual.get('origem') in FIXAS and origem not in FIXAS:
            continue
        if problemas := verificar_frase(en, pt, memoria, termos):
            recusados += 1
            print(f'FRASE recusada {en}\n      {pt}\n      -> {"; ".join(problemas)}')
            continue
        memoria.frases[en] = {'pt': pt.strip(), 'origem': origem, 'usos': usos.get(en, 0)}
    gravar(NOMES, memoria.nomes)
    gravar(FRASES, memoria.frases)
    print(f'aplicado: {len(lote.get("nomes", {}))} nomes e {len(lote.get("frases", {}))} frases no lote | recusados: {recusados}')
    return 1 if recusados else 0


def cmd_corpus():
    """Pares de frases EN->PT oficiais das cartas clássicas (mesmo número de frases nos dois textos), num cache fora do git."""
    en_path, pt_path = YGOPRO / 'ygopro-en.json', YGOPRO / 'ygopro-pt.json'
    if not en_path.exists() or not pt_path.exists():
        sys.exit(f'falta o cache do YGOPRODeck ({en_path.name}, {pt_path.name}): rode o import_cards.py fetch numa máquina '
                 'com acesso ao YGOPRODeck (bloqueado na nuvem)')
    pt = {c['id']: c for c in json.loads(pt_path.read_text())['data']}
    pares, nomes = {}, {}
    for card in json.loads(en_path.read_text())['data']:
        local = pt.get(card['id'])
        if not local:
            continue
        if local.get('name') and local['name'] != card['name']:
            nomes[card['name']] = local['name']
        en_f, pt_f = frases(card.get('desc') or ''), frases(local.get('desc') or '')
        if len(en_f) == len(pt_f):
            pares.update(zip(en_f, pt_f))
    CORPUS.parent.mkdir(exist_ok=True)
    CORPUS.write_text(json.dumps({'nomes': nomes, 'frases': pares}, ensure_ascii=False))
    print(f'{len(nomes)} nomes e {len(pares)} frases alinhadas -> {CORPUS}')


def main():
    cmd, *args = sys.argv[1:] or ['']
    comandos = {'medir': lambda: cmd_medir(), 'pendentes': lambda: cmd_pendentes(args), 'verificar': cmd_verificar,
                'aplicar': lambda: cmd_aplicar(args), 'corpus': cmd_corpus}
    if cmd not in comandos:
        sys.exit(__doc__)
    sys.exit(comandos[cmd]() or 0)


if __name__ == '__main__':
    main()
