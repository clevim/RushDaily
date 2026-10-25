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
