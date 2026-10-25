# Tradução das cartas Rush para PT-BR: plano

O Rush Duel nunca saiu em português (o card game físico é só Japão e Coreia), então não existe texto oficial em PT para copiar.
Hoje só 406 das 3.232 cartas do pool têm texto em PT (`tools/card-render/pt-br.json`, feitas à mão, quase todas Normais e
Magias/Armadilhas simples); o resto aparece em inglês (`pt: false` em `src/data/rush/cards.json`).

## Números (medidos no `cards.json`, 2.826 cartas sem PT)

| | |
|---|---|
| Frases no total | 14.132 |
| Frases únicas | 5.642 (4.725 trocando nomes e números por marcadores) |
| As 300 frases mais comuns | cobrem 60% do texto |
| Nomes de carta | 2.800 |
| Palavras únicas | ~100 mil |

O texto Rush é muito repetitivo ("Send the top card of your Deck to the Graveyard." aparece 177 vezes, "Draw 1 card." 96).
Por isso a tradução é feita **por frase, uma vez só**, numa memória de tradução, e não carta por carta: sai consistente,
custa ~2,5x menos e as cartas novas do BabelCDB só pedem as frases inéditas.

## Arquivos (no repositório, revisáveis; nenhum é gerado pelo setup)

Em `tools/rush/traducao/`:

- `glossario.json`: termos do jogo e nomes de arquétipos, `{ "en": "Graveyard", "pt": "Cemitério", "tipo": "termo"|"arquetipo"|"marcador", "nota": "..." }`.
  Inclui os marcadores do Rush: `[REQUIREMENT]` → `[REQUISITO]`, `[EFFECT]` → `[EFEITO]`, `[CONTINUOUS EFFECT]` → `[EFEITO CONTÍNUO]`,
  `[MULTI-CHOICE EFFECT]` → `[EFEITO DE ESCOLHA MÚLTIPLA]`, Maximum → Máximo, Legend → Lenda. É onde a revisão humana rende mais.
- `nomes.json`: `{ "<nameEn>": { "pt": "...", "origem": "oficial"|"manual"|"revisada"|"automatica" } }`. Traduzidos ANTES das frases,
  porque os efeitos citam cartas pelo nome entre aspas: o texto em PT tem de citar exatamente o nome de `nomes.json`.
- `frases.json`: a memória de tradução, `{ "<frase em inglês>": { "pt": "...", "origem": "...", "usos": N } }`.
  Chave = frase em inglês exatamente como sai do `desc` (depois da segmentação abaixo).
- `strings.json` (fase 2): os rótulos de efeito das perguntas do motor (`strings` das cartas, ex.: "Activate X's effect?").

As 406 traduções manuais de `pt-br.json` entram como `origem: manual` (nomes e, quando a frase bater, frases) e nunca são sobrescritas.

## Segmentação

Mesma regra para medir, traduzir e montar: quebra por linha e por fim de frase (`. ! ?` seguido de espaço e maiúscula, `[`, `(`,
`●` ou aspas). Os marcadores (`[REQUIREMENT]`, `[EFFECT]`...) são segmentos próprios e saem do glossário, sem tradução.
`None` (requisito vazio) → `Nenhum`. A montagem junta os segmentos traduzidos na mesma ordem e com as mesmas quebras de linha.

## Referência nas cartas clássicas (estilo oficial)

O importador clássico já baixa do YGOPRODeck o texto oficial em inglês e em português de milhares de cartas
(`tools/classic/cache/ygopro-en.json` e `ygopro-pt.json`, casados pelo `id`). Isso é um corpus paralelo oficial:

1. Segmentar os dois textos de cada carta clássica e alinhar frase a frase (mesmo número de frases; descartar o que não alinhar).
2. Para cada frase Rush, buscar as frases clássicas em inglês mais parecidas (similaridade por palavras/trigramas, sem dependências)
   e mandar 3 a 5 pares EN→PT oficiais como exemplo na tradução. Ex.: "Send ... to the GY" → "Envie ... para o Cemitério".
3. Extrair do corpus os termos recorrentes para semear o `glossario.json` (Tribute Summon → Invocação-Tributo etc.).

Medido contra os nomes em inglês do BabelCDB clássico:

- **Nomes: 307 cartas Rush sem PT têm exatamente o nome de uma carta clássica** (Seal of the Ancients, Sparks, Mountain,
  Thousand Knives, Dark Magic Attack, Umi, Forest...). Essas pegam o nome oficial em PT do `ygopro-pt.json` direto, como
  `origem: oficial` (não passa pela tradução). Os pedaços recorrentes de nomes clássicos (Blue-Eyes, Dark Magician, Dragon,
  nomes de arquétipos) com tradução oficial semeiam o glossário, para os outros ~2.500 nomes seguirem o mesmo padrão.
- **Textos: só 46 frases Rush são idênticas a frases clássicas (2% das ocorrências).** Mesmo as versões Rush de cartas clássicas
  reescrevem o efeito no formato próprio ([REQUIREMENT]/[EFFECT], "Graveyard" por extenso). Para o texto, o clássico é
  referência de estilo (exemplos parecidos), não fonte de cópia; as 46 idênticas entram como `origem: oficial`.

Importante: o Rush escreve "Graveyard" por extenso e o clássico atual usa "GY"; trate os dois como o mesmo termo.
O YGOPRODeck é bloqueado no ambiente de nuvem: essa etapa roda na máquina do dono ou no homelab (onde o setup clássico já
baixou o cache). Sem o corpus, a tradução funciona só com o glossário e os exemplos manuais, com estilo menos oficial.

## Verificações automáticas (toda tradução passa por elas; falhou → volta para tradução ou para a fila manual)

- Mesmos números (ATK, DEF, níveis, quantidades) e mesma quantidade de cada um.
- Mesmos marcadores entre colchetes, na mesma ordem.
- Toda carta citada entre aspas no inglês aparece entre aspas no PT com o nome de `nomes.json`.
- Termos do glossário respeitados (ex.: nunca "Cemitério" e "Graveyard" misturados).
- Sem texto em inglês sobrando (heurística por palavras comuns) e tamanho dentro de uma faixa razoável do original.

## Montagem

`python3 -I tools/rush/import_rush.py build` passa a ler `nomes.json` e `frases.json`: uma carta fica `pt: true` quando o nome
e TODAS as frases têm tradução; senão mantém o inglês inteiro (nunca meio a meio). Acrescentar os arquivos de `tools/rush/traducao/`
às `fontes` da etapa `rush-ocg` no `setup.mjs` (detecção de mudança): traduzir ou corrigir uma frase refaz o `cards.json`
e, em cascata, as cartas montadas (`rush-cartas`). Subir o `CACHE_VERSION` de `src/ui/rush-card-data.js` quando o texto mudar.

## Execução em lotes (cada lote é um commit; se parar no meio, nada se perde)

1. **Ferramenta:** `tools/rush/traducao.py` com os comandos `medir` (os números acima), `pendentes [--top N] [--json]`
   (frases e nomes sem tradução, por frequência), `verificar` (roda as verificações em tudo), `corpus` (monta os pares
   clássicos alinhados num cache ignorado pelo git) e `aplicar <arquivo>` (junta um lote traduzido nos JSON, só se passar
   nas verificações).
2. **Piloto:** glossário inicial (dos termos do corpus clássico + `pt-br.json`) e 50 cartas variadas (Normal, Efeito, Máximo,
   Fusão, Magia, Armadilha, Lenda). O dono avalia, ajusta o glossário, e medimos o custo real por frase.
3. **Lote 1:** todos os nomes (2.800) e as 300 frases mais frequentes (60% do texto).
4. **Lotes seguintes:** o resto das frases, das mais para as menos frequentes.
5. **Fase 2:** `strings.json` (rótulos das perguntas do motor).

Quem traduz: um agente nesta conta (sem chave de API, gasta o crédito do plano; começar numa sessão NOVA, com este arquivo como
pedido, para não carregar histórico longo) ou um script com chave de API do dono (`traducao.py traduzir --lote N`, paga por uso,
repetível para as cartas novas). Decidir depois do piloto, com o custo medido.

## Aba "Tradução" no painel admin

Para revisar e traduzir na mão quando quiser:

- Fila por frequência: frase em inglês, tradução atual, origem, quantas cartas usam e quais (com a imagem da carta);
  filtros por origem (automática, revisada, manual, sem tradução) e busca.
- Editar e salvar, ou só aprovar (`automatica` → `revisada`); as verificações rodam ao salvar e mostram o que falhou.
- Abas para Nomes e Glossário com o mesmo fluxo; mudar um termo do glossário lista as frases que o usam para revisar.
- Prévia da carta montada com o texto novo (desenho do `rush-render.js`).
- Progresso: % do texto coberto, % revisado, e botão "Aplicar no jogo" (roda o `build` do rush-ocg).
- Rotas do servidor: leitura e escrita SÓ desses JSON de `tools/rush/traducao/`, com os mesmos cuidados do painel
  (token, lista fechada, validação, escrita atômica).
- No contêiner o código é copiado da imagem para o volume a cada subida, então edições feitas lá se perderiam:
  no modo contêiner a aba é só leitura e oferece "Baixar alterações" (JSON para aplicar no repositório com `traducao.py aplicar`);
  a edição de verdade é no painel local (`npm run admin`), seguida de commit.

## Fora do escopo

- Textos clássicos: já vêm oficiais em PT do YGOPRODeck.
- Tradução no navegador em tempo real: tudo é feito antes e vai pronto no `cards.json`.
