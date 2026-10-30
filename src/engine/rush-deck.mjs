// Decks do Rush Duel (motor do EDOPro) gerados por seed a partir de src/data/rush/cards.json.
// Coerência sem decks reais: um tema (Tipo de monstro, com um Atributo de apoio e às vezes um arquétipo pelo setcode),
// curva de níveis com cotas, Magias/Armadilhas que citam o tema, pacote de Máximo e Fusões cujas matérias estão no deck.
// Regras oficiais: deck de 40 a 60, adicional até 15 (Fusão e Ritual), até 3 cópias por nome e no máximo 1 carta Lenda
// de cada categoria (1 monstro Lenda, 1 Magia Lenda, 1 Armadilha Lenda), contando deck e adicional.
import { FORMATS, TYPE, isExtra } from './ocg.mjs';
import { seeded } from './classic-deck.mjs';
import { ATTRIBUTES as ATTRIBUTES_PT, RACES as RACES_PT } from '../data/classic/strings-pt.mjs';

export { seeded };

/** Tipos de monstro do EDOPro (bit -> nome em inglês, como aparece no texto das cartas). */
export const RACE_NAMES = {
  0x1: 'Warrior', 0x2: 'Spellcaster', 0x4: 'Fairy', 0x8: 'Fiend', 0x10: 'Zombie', 0x20: 'Machine', 0x40: 'Aqua', 0x80: 'Pyro',
  0x100: 'Rock', 0x200: 'Winged Beast', 0x400: 'Plant', 0x800: 'Insect', 0x1000: 'Thunder', 0x2000: 'Dragon', 0x4000: 'Beast',
  0x8000: 'Beast-Warrior', 0x10000: 'Dinosaur', 0x20000: 'Fish', 0x40000: 'Sea Serpent', 0x80000: 'Reptile', 0x100000: 'Psychic',
  0x200000: 'Divine-Beast', 0x400000: 'Creator God', 0x800000: 'Wyrm', 0x1000000: 'Cyberse', 0x2000000: 'Illusion', 0x4000000: 'Cyborg',
  0x8000000: 'Magical Knight', 0x10000000: 'High Dragon', 0x20000000: 'Omega Psychic', 0x40000000: 'Celestial Warrior', 0x80000000: 'Galaxy',
};
export const ATTRIBUTE_NAMES = { 0x1: 'EARTH', 0x2: 'WATER', 0x4: 'FIRE', 0x8: 'WIND', 0x10: 'LIGHT', 0x20: 'DARK', 0x40: 'DIVINE' };
export const RUSH_LIMITS = { mainMin: 40, mainMax: 60, extraMax: 15, copies: 3 };

const isMonster = (card) => Boolean(card.type & TYPE.MONSTER);
const level = (card) => card.level & 0xff;
const category = (card) => (isMonster(card) ? 'monster' : card.type & TYPE.SPELL ? 'spell' : 'trap');
// Rituais precisam da Magia certa e peças de Máximo só entram como pacote (as três juntas).
const playable = (card) => card && !isExtra(card) && !(card.type & TYPE.RITUAL) && !(card.type & TYPE.TOKEN) && !card.maximum;
const nameKey = (card) => card.nameEn || card.name;
// O texto das cartas está em PT ("monstro do Tipo Besta-Guerreira de Atributo VENTO"): Tipo/Atributo pelos nomes em PT.
const racePt = (race) => RACES_PT[Math.log2(race)];
const textOf = (card) => card.desc || '';
const unquoted = (card) => textOf(card).replace(/"[^"]*"/g, ''); // nomes de carta citados não contam como Tipo/Atributo
// Mais longo primeiro: "Besta-Guerreira" antes de "Besta", "Dragão Supremo" antes de "Dragão".
const RACE_RE = new RegExp(`(?<![\\wÀ-ú-])(${[...RACES_PT].sort((a, b) => b.length - a.length).join('|')})(?![\\wÀ-ú-])`, 'g');
const ATTR_RE = new RegExp(`(?<![\\wÀ-ú-])(${Object.values(ATTRIBUTES_PT).join('|')})(?![\\wÀ-ú-])`, 'g');
const citedRaces = (card) => [...new Set([...unquoted(card).matchAll(RACE_RE)].map((m) => m[1]))];
const citedAttributes = (card) => [...new Set([...unquoted(card).matchAll(ATTR_RE)].map((m) => m[1]))];
const citedNames = (card) => [...textOf(card).matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((name) => name !== card.name && name !== card.nameEn);
// Requisitos de uma carta (Magia, Armadilha ou monstro de Efeito), tirados do texto em PT: o [REQUISITO] inteiro e a primeira
// frase do efeito (o resto costuma ser "Depois, você pode..."). Cada frase vira uma lista de alternativas ("ou" frouxo):
// nome citado, monstro descrito ("Monstro Normal do Tipo Aqua de Atributo ÁGUA de Nível 8 ou mais", tudo no mesmo monstro)
// ou Magia de Equipamento/Campo. O que é do oponente ("do seu oponente", "no campo dele") não conta.
const LIST_END = new RegExp(`,(?! (?:${RACES_PT.join('|')})\\b)`); // "dos Tipos Peixe, Trovão e Aqua" é uma lista só
const OPPONENT = /oponente|\bdel[ea]s?\b|\bel[ea]s?\b/g;
const OWN = /você|\b(?:seus?|suas?)\b(?! oponente)|\b[Ee]nvie|\b[Ee]mbaralhe|\b[Cc]oloque/g;
const lastAt = (re, text) => Math.max(-1, ...[...text.matchAll(re)].map((m) => m.index));
const opponents = (before, phrase = '') => (/oponente|\bdel[ea]s?\b/.test(phrase) ? true
  : /\b(?:seus?|suas?)\b(?! oponente)/.test(phrase) ? false : lastAt(OPPONENT, before) > lastAt(OWN, before));
const SPELL_KIND = { Equipamento: 0x40000, Campo: 0x80000 };
const requirementCache = new Map();
export function requirementsOf(card) {
  if (requirementCache.has(card)) return requirementCache.get(card);
  const clauses = [];
  if (isMonster(card) && !(card.type & TYPE.EFFECT)) return clauses; // Normal: o texto é só história
  const text = textOf(card).replace(/\[[a-zà-ú][^\]]*\]/g, ''); // "[o número de ...]" é valor, não requisito
  const [req, ...rest] = (text.split('[REQUISITO]')[1] ?? '').split('[EFEITO');
  const effect = rest.join('');
  const first = effect.startsWith(' DE ESCOLHA') ? '' : effect.replace(/^[^\]]*\]/, '').trim().split(/\.(?:\s|$)/)[0];
  for (const clause of `${req}\n${first}`.split(/\.(?:\s|$)|[;\n]/)) {
    if (/não pode|Nenhum jogador/.test(clause)) continue; // restrição ("só pode atacar com..."), não requisito
    const options = [];
    for (const m of clause.matchAll(/"([^"]+)"/g)) {
      const before = clause.slice(0, m.index);
      if (!opponents(before) && !/(se torna|como) $/.test(before)) options.push({ name: m[1] });
    }
    const clean = clause.replace(/"[^"]*"/g, '""');
    for (const m of clean.matchAll(/Mágicas? de (Equipamento|Campo)/g)) if (!opponents(clean.slice(0, m.index), clean.slice(m.index).split(',')[0])) options.push({ spell: SPELL_KIND[m[1]] });
    for (const m of clean.matchAll(/[Mm]onstros?\b/g)) {
      const phrase = clean.slice(m.index).split(/(?<=.)[Mm]onstros?\b/)[0].split(LIST_END)[0];
      if (opponents(clean.slice(0, m.index), phrase)) continue;
      const own = phrase.split(/\bnão\b|\bexceto\b|\bdiferente/)[0];
      const spec = {
        races: [...new Set([...own.matchAll(RACE_RE)].map((x) => x[1]))],
        attrs: [...new Set([...own.matchAll(ATTR_RE)].map((x) => x[1]))],
        levels: [...own.matchAll(/Nível (\d+)(?:(?: ou | a |-)(mais|maior|menos|menor|\d+))?/g)].map(([, n, rel]) => [+n, rel]),
        type: /^[Mm]onstros? Norma/.test(own) ? 'normal' : /^[Mm]onstros? de Efeito/.test(own) ? 'effect' : /^[Mm]onstros? de Fusão/.test(own) ? 'fusion'
          : /^[Mm]onstros? Máxim/.test(own) ? 'maximum' : /^[Mm]onstros? Lenda/.test(own) ? 'legend' : null,
      };
      if (spec.races.length || spec.attrs.length || spec.levels.length || spec.type) options.push(spec);
    }
    if (options.length) clauses.push(options);
  }
  requirementCache.set(card, clauses);
  return clauses;
}
const KIND_TEST = { normal: (c) => !(c.type & TYPE.EFFECT), effect: (c) => c.type & TYPE.EFFECT, fusion: (c) => c.type & TYPE.FUSION, maximum: (c) => c.maximum, legend: (c) => c.legend };
const levelOk = (lv, [n, rel]) => (rel === 'mais' || rel === 'maior' ? lv >= n : rel === 'menos' || rel === 'menor' ? lv <= n : lv === n || (lv >= n && lv <= +rel));
const fits = (option, card) => (option.name ? card.name.includes(option.name) || card.nameEn.includes(option.name)
  : option.spell ? Boolean(card.type & option.spell)
    : isMonster(card) && (!option.races.length || option.races.includes(racePt(card.race)))
      && (!option.attrs.length || option.attrs.includes(ATTRIBUTES_PT[card.attribute]))
      && option.levels.every((test) => levelOk(level(card), test)) && (!option.type || Boolean(KIND_TEST[option.type](card))));

/** A carta só serve se cada requisito tem alguma carta do deck (ou do adicional, para Monstro de Fusão) que o atende.
 * deckCards: cartas do deck (a própria conta: outra cópia ou ela mesma no Cemitério); extraCards: Fusões do adicional. */
export function meetsRequirements(card, deckCards, extraCards = []) {
  const all = extraCards.length ? [...deckCards, ...extraCards] : deckCards;
  return requirementsOf(card).every((options) => options.some((option) => all.some((c) => fits(option, c))));
}

/** Quantas cartas do deck têm requisito sem nada que o atenda. */
export const useless = (deckCards, extraCards = []) => deckCards.filter((card) => !meetsRequirements(card, deckCards, extraCards)).length;

/** Cotas do deck de 40 (escalam para outros tamanhos): curva baixa, poucos de 1 e 2 Sacrifícios e 14 Magias/Armadilhas
 * (com 17 a mão enchia de Magias/Armadilhas sem uso). Magias de Fusão ficam fora da cota: só entram pela lógica de Fusão. */
function quotas(format) {
  const scale = format.main / 40;
  return [
    { key: 'low', monster: true, test: (c) => isMonster(c) && level(c) <= 4, n: Math.round(19 * scale) },
    { key: 'mid', monster: true, test: (c) => isMonster(c) && level(c) >= 5 && level(c) <= 6, n: Math.round(4 * scale) },
    { key: 'high', monster: true, test: (c) => isMonster(c) && level(c) >= 7, n: Math.round(3 * scale) },
    { key: 'spell', monster: false, test: (c) => Boolean(c.type & TYPE.SPELL) && !/Fusion/i.test(c.nameEn ?? ''), n: Math.round(8 * scale) },
    { key: 'trap', monster: false, test: (c) => Boolean(c.type & TYPE.TRAP), n: Math.round(6 * scale) },
  ];
}

function weightedPick(random, entries) {
  let roll = random() * entries.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [value, weight] of entries) { roll -= weight; if (roll <= 0) return value; }
  return entries.at(-1)?.[0];
}

/** Temas possíveis: Tipos com 30+ monstros jogáveis no deck principal. */
export function rushThemes(pool) {
  const counts = new Map();
  for (const card of pool) if (playable(card) && isMonster(card)) counts.set(card.race, (counts.get(card.race) || 0) + 1);
  return [...counts].filter(([race, n]) => n >= 30 && RACE_NAMES[race]).map(([race, n]) => ({ race, name: RACE_NAMES[race], size: n }));
}

/** Magia de Ritual: Monstros de Ritual que ela invoca, a soma de Níveis e o filtro da matéria ("monstros do Tipo Trovão"). */
function ritualOf(spell, byName) {
  const text = textOf(spell);
  const sum = Number(/soma dos Níveis (?:seja|for) (\d+)/.exec(text)?.[1]);
  const phrase = /enviando monstros (.*?) cuja/s.exec(text)?.[1];
  const targets = citedNames(spell).map((name) => byName.get(name)).filter((card) => card && card.type & TYPE.MONSTER && card.type & TYPE.RITUAL && !card.legend);
  if (!sum || phrase === undefined || !targets.length) return null;
  return { spell, targets, sum, spec: { races: [...phrase.matchAll(RACE_RE)].map((m) => m[1]), attrs: [...phrase.matchAll(ATTR_RE)].map((m) => m[1]), levels: [], type: null } };
}

/** Matérias citadas pelo nome no texto da Fusão: "A" + "B". */
const materialsOf = (card) => [...(card.desc.split('\n')[0].matchAll(/"([^"]+)"/g))].map((m) => m[1]);

/**
 * Confere um deck Rush: devolve a lista de problemas (vazia = legal).
 * deck: { main: [ids], extra: [ids] }; byId: Map id -> carta do pool.
 */
export function validateRushDeck(deck, byId, limits = RUSH_LIMITS) {
  const problems = [];
  const main = deck.main || [];
  const extra = deck.extra || [];
  if (main.length < limits.mainMin || main.length > limits.mainMax) problems.push(`deck com ${main.length} cartas (precisa de ${limits.mainMin} a ${limits.mainMax})`);
  if (extra.length > limits.extraMax) problems.push(`adicional com ${extra.length} cartas (máximo ${limits.extraMax})`);
  const copies = new Map();
  const legends = new Map();
  for (const [ids, zone] of [[main, 'main'], [extra, 'extra']]) {
    for (const id of ids) {
      const card = byId.get(id);
      if (!card) { problems.push(`carta ${id} fora do pool`); continue; }
      if (zone === 'extra' && !isExtra(card, FORMATS.rush)) problems.push(`${nameKey(card)} não é Fusão nem Ritual e está no adicional`);
      if (zone === 'main' && isExtra(card, FORMATS.rush)) problems.push(`${nameKey(card)} é do adicional e está no deck`);
      copies.set(nameKey(card), (copies.get(nameKey(card)) || 0) + 1);
      if (card.legend) legends.set(category(card), [...(legends.get(category(card)) || []), nameKey(card)]);
    }
  }
  for (const [name, n] of copies) if (n > limits.copies) problems.push(`${n} cópias de ${name} (máximo ${limits.copies})`);
  for (const [kind, names] of legends) if (names.length > 1) problems.push(`mais de uma carta Lenda (${kind}): ${names.join(', ')}`);
  return problems;
}

/**
 * Deck Rush de 40 (+ adicional de até 15 Fusões). Mesma seed e mesmo pool: mesmo deck.
 * race: força o Tipo do tema (ex.: confronto do desafio diário); sem ele, sorteia entre rushThemes.
 * Devolve { main, extra, theme: { race, name, attribute, setcode } }.
 */
export function buildRushDeck({ seed, pool, format = FORMATS.rush, race = null }) {
  const random = seeded(`rush:${seed}`);
  const byId = new Map(pool.map((card) => [card.id, card]));
  const themes = rushThemes(pool);
  const picked = weightedPick(random, themes.map((t) => [t, Math.sqrt(t.size)]));
  const theme = (race && themes.find((t) => t.race === race)) || picked;
  const ofRace = pool.filter((card) => playable(card) && isMonster(card) && card.race === theme.race);
  // Atributo de apoio: sorteado entre os mais comuns do Tipo.
  const attrCount = new Map();
  for (const card of ofRace) attrCount.set(card.attribute, (attrCount.get(card.attribute) || 0) + 1);
  const attribute = weightedPick(random, [...attrCount].map(([attr, n]) => [attr, n * n]));
  // Arquétipo (setcode) do Tipo com 4+ cartas: metade das vezes vira um segundo eixo.
  const setCount = new Map();
  for (const card of pool) if (card.setcode !== '0' && playable(card) && (card.race === theme.race || !isMonster(card))) setCount.set(card.setcode, (setCount.get(card.setcode) || 0) + 1);
  const sets = [...setCount].filter(([, n]) => n >= 4);
  const setcode = sets.length && random() < 0.5 ? weightedPick(random, sets.map(([code, n]) => [code, n])) : null;
  const raceName = theme.name;
  const racePtName = racePt(theme.race);
  const attrName = ATTRIBUTES_PT[attribute];

  const main = [];
  const deckCards = [];
  const planned = []; // Fusões do pacote: entram no adicional e já contam para "Monstro de Fusão" nos requisitos
  const counts = new Map();
  const legendUsed = new Set();
  const plan = quotas(format).map((quota) => ({ ...quota, have: 0 }));
  const room = (card) => plan.find((quota) => quota.test(card) && quota.have < quota.n);
  const add = (card, n) => {
    for (let i = 0; i < n; i += 1) {
      main.push(card.id);
      deckCards.push(card);
      counts.set(nameKey(card), (counts.get(nameKey(card)) || 0) + 1);
      let quota = room(card);
      if (!quota) {
        // Pacote (Máximo, matérias de Fusão) estourou a cota: a vaga sai de outra cota, de monstro se possível.
        quota = plan.find((q) => q.test(card));
        const donor = plan.find((q) => q !== quota && q.have < q.n && q.monster === quota.monster) || plan.find((q) => q !== quota && q.have < q.n);
        if (donor) { donor.n -= 1; quota.n += 1; }
      }
      quota.have += 1;
    }
    if (card.legend) legendUsed.add(category(card));
  };
  const free = (card) => RUSH_LIMITS.copies - (counts.get(nameKey(card)) || 0);
  // Só cartas com os requisitos atendidos pelo deck montado até aqui (ela mesma conta: outra cópia, ou ela no Cemitério).
  const allowed = (card) => playable(card) && free(card) > 0 && !(card.legend && legendUsed.has(category(card)))
    && meetsRequirements(card, [...deckCards, card], planned);

  // Peso de cada carta para o tema.
  const weight = (card) => {
    let w = 1;
    if (isMonster(card)) {
      w = card.race === theme.race ? 6 : 0.4;
      if (card.attribute === attribute) w *= 2;
      if (!(card.type & TYPE.EFFECT)) w *= 0.6; // Normais entram, mas menos
    } else {
      const races = citedRaces(card);
      const attrs = citedAttributes(card);
      if (races.includes(racePtName)) w += 6;
      if (attrs.includes(attrName)) w += 3;
      // Cita outro Tipo/Atributo e não o nosso: provavelmente não funciona neste deck.
      if ((races.length && !races.includes(racePtName)) || (attrs.length && !attrs.includes(attrName) && !races.includes(racePtName))) w *= 0.05;
      if (/Invoque por Fusão|Fusion Summon/.test(textOf(card))) w *= 0.3; // Magias de Fusão entram pelo adicional
    }
    if (citedNames(card).some((name) => starNames.has(name))) w *= 5; // busca/apoia uma estrela
    if (setcode && card.setcode === setcode) w *= 4;
    if (card.legend) w *= 0.6;
    return w;
  };

  // Pacote de Máximo do tema (as três peças, 2 cópias cada) em parte dos decks.
  const centers = pool.filter((card) => card.maximum === 'C' && byId.get(card.id - 1)?.maximum === 'L' && byId.get(card.id + 1)?.maximum === 'R'
    && (card.race === theme.race || card.attribute === attribute));
  if (centers.length && random() < 0.35) {
    const center = centers[Math.floor(random() * centers.length)];
    for (const piece of [byId.get(center.id - 1), center, byId.get(center.id + 1)]) add(piece, 2);
  }
  // Pacote de Fusão do tema: uma Fusão do Tipo cujas matérias citadas existem no pool entra com 2 cópias de cada matéria.
  const byName = new Map(pool.filter(playable).flatMap((card) => [[card.nameEn, card], [card.name, card]]));
  const fusionCandidates = pool.filter((card) => card.type & TYPE.FUSION && card.race === theme.race && !card.legend)
    .map((card) => ({ card, mats: materialsOf(card).map((name) => byName.get(name)) }))
    .filter(({ mats }) => mats.length >= 2 && mats.every((mat) => mat && !mat.legend && level(mat) <= 6));
  // Estrelas: as Fusões escolhidas e um Tributo forte do Tipo (1 cópia); o resto do deck favorece cartas que as citam.
  const starNames = new Set();
  const tributes = ofRace.filter((card) => level(card) >= 7 && !card.legend && card.type & TYPE.EFFECT);
  if (tributes.length) {
    const star = tributes[Math.floor(random() * tributes.length)];
    starNames.add(star.name).add(star.nameEn);
    add(star, 1);
  }
  if (fusionCandidates.length) {
    const first = fusionCandidates[Math.floor(random() * fusionCandidates.length)];
    // A segunda Fusão (se houver) divide ao menos uma matéria com a primeira.
    const sharing = fusionCandidates.filter((c) => c !== first && c.mats.some((mat) => first.mats.includes(mat)));
    const chosen = sharing.length ? [first, sharing[Math.floor(random() * sharing.length)]] : [first];
    for (const { card } of chosen) { starNames.add(card.name).add(card.nameEn); planned.push(card); }
    for (const { mats } of chosen) for (const mat of mats) if (!counts.get(nameKey(mat))) add(mat, Math.min(2, free(mat)));
  }

  // Peso calculado uma vez por carta (o tema não muda durante a montagem).
  const weights = new Map(pool.filter(playable).map((card) => [card.id, weight(card)]));
  // Carta do tema: monstro do Tipo, ou Magia/Armadilha que cita o Tipo/Atributo/arquétipo.
  const themed = (card) => (isMonster(card) ? card.race === theme.race : weights.get(card.id) >= 3);
  const pickFrom = (options) => {
    const inTheme = options.filter(themed);
    // ~80% dos monstros e ~60% das Magias/Armadilhas vêm do tema, quando há opção.
    const share = isMonster(options[0]) ? 0.8 : 0.6;
    const list = inTheme.length && (random() < share || inTheme.length === options.length) ? inTheme : options.filter((card) => !themed(card));
    return byId.get(weightedPick(random, (list.length ? list : options).map((c) => [c.id, weights.get(c.id)])));
  };
  for (const quota of plan) {
    while (quota.have < quota.n) {
      const options = pool.filter((card) => allowed(card) && quota.test(card));
      if (!options.length) break;
      const card = pickFrom(options);
      // Cópias: Lenda 1; nível baixo costuma ir em 2 ou 3; nível 7+ em 1 ou 2.
      // Suporte e técnicas: 1 cópia (2 se do tema); motor (monstros de nível baixo): 2 ou 3.
      const want = card.legend ? 1 : isMonster(card) && level(card) >= 7 ? 1 + Math.floor(random() * 2)
        : isMonster(card) ? 2 + Math.floor(random() * 2) : 1 + (themed(card) ? 1 : 0);
      add(card, Math.min(want, free(card), quota.n - quota.have));
    }
  }
  // Pool pequeno (testes, coleção do jogador): completa com o que der, ainda pelo peso do tema.
  while (main.length < format.main) {
    const options = pool.filter(allowed);
    if (!options.length) break;
    add(pickFrom(options), 1);
  }

  // Adicional: só Fusões cujas matérias citadas estão todas no deck.
  const names = new Set(main.map((id) => byId.get(id)).flatMap((card) => [card.nameEn, card.name]));
  const scored = pool.filter((card) => card.type & TYPE.FUSION).map((card) => {
    const mats = materialsOf(card);
    const have = mats.filter((name) => names.has(name)).length;
    return [card, mats.length && have === mats.length ? 4 : 0];
  }).filter(([, score]) => score > 0);
  // As Fusões do pacote primeiro (há cartas no deck que contam com elas).
  const extra = planned.map((card) => card.id);
  for (const card of planned) scored.splice(scored.findIndex(([c]) => c === card), 1);
  while (extra.length < format.extra && scored.length) {
    const pick = weightedPick(random, scored.map(([card, score], i) => [i, score + random()]));
    const [card] = scored.splice(pick, 1)[0];
    if (card.legend && legendUsed.has('monster')) continue;
    if (card.legend) legendUsed.add('monster');
    extra.push(card.id);
  }
  // Com Fusão no adicional, troca as Magias mais fracas por Magias de Fusão: "Fusion" (matérias no campo, sem limite)
  // e uma Polimerização (mão ou campo) quando a vaga de Magia Lenda está livre.
  const fusions = [pool.find((card) => card.nameEn === 'Fusion'), pool.find((card) => card.nameEn === 'Polymerization')].filter(Boolean);
  const extraCards = extra.map((id) => byId.get(id));
  // Troca Magias do deck pelas de wanted (uma por cópia) e devolve quantas trocou.
  const swapSpells = (wanted) => {
    let swapped = 0;
    for (let i = main.length - 1; i >= 0 && wanted.length; i -= 1) {
      const card = byId.get(main[i]);
      // A primeira troca (vaga fixa da Magia de Fusão/Ritual) vale para qualquer Magia; as demais só para as fracas.
      if (!(card.type & TYPE.SPELL) || card.legend || fusions.includes(card) || card.type & TYPE.RITUAL || (swapped && weights.get(card.id) > 1)) continue;
      // Não troca uma Magia da qual outra carta do deck depende (requisito).
      const after = main.map((id, j) => byId.get(j === i ? wanted[0].id : id));
      if (useless(after, extraCards) > useless(main.map((id) => byId.get(id)), extraCards)) continue;
      swapped += 1;
      const swap = wanted.shift();
      counts.set(nameKey(card), counts.get(nameKey(card)) - 1);
      counts.set(nameKey(swap), (counts.get(nameKey(swap)) || 0) + 1);
      if (swap.legend) legendUsed.add('spell');
      main[i] = swap.id;
    }
    return swapped;
  };
  // Só as que ainda não estão no deck (a cópia sorteada antes já conta).
  if (extra.length) swapSpells(fusions.filter((card) => !counts.get(nameKey(card)) && !(card.legend && legendUsed.has('spell'))).flatMap((card) => (card.legend ? [card] : [card, card])));
  // Pacote de Ritual: a Magia de Ritual (2 cópias, no lugar das Magias mais fracas) e o Monstro de Ritual que ela invoca no
  // adicional, só quando o deck tem matéria que fecha a soma de Níveis (8+ monstros que servem; os dois maiores bastam).
  const allNames = new Map(pool.flatMap((card) => [[card.nameEn, card], [card.name, card]]));
  const deckNow = main.map((id) => byId.get(id));
  const rituals = pool.filter((card) => card.type & TYPE.SPELL && card.type & TYPE.RITUAL && !card.legend).map((spell) => ritualOf(spell, allNames)).filter((r) => {
    if (!r || !r.targets.every((card) => isExtra(card, format))) return false;
    if (!r.targets.some((card) => card.race === theme.race) && !r.spec.races.includes(racePtName)) return false; // do tema
    const levels = deckNow.filter((card) => fits(r.spec, card)).map(level).sort((x, y) => y - x);
    return levels.length >= 8 && levels[0] + levels[1] >= r.sum;
  });
  if (rituals.length) {
    const { spell, targets } = rituals[Math.floor(random() * rituals.length)];
    const added = targets.slice(0, 2).filter((card) => !extra.includes(card.id));
    for (const card of added) {
      // Adicional cheio: sai a última Fusão sorteada (as do pacote de Fusão ficam).
      const at = extra.length < format.extra ? extra.length : extra.findLastIndex((id) => !planned.some((c) => c.id === id) && !(byId.get(id).type & TYPE.RITUAL));
      if (at < 0) break;
      extra[at] = card.id;
      extraCards[at] = card;
    }
    if (!swapSpells([spell, spell])) for (const card of added) { const at = extra.indexOf(card.id); if (at >= 0) { extra.splice(at, 1); extraCards.splice(at, 1); } }
  }
  // Conserto: peça que entrou em pacote (Máximo, estrela, matéria de Fusão) ou ficou sem apoio depois das trocas ganha a carta
  // que falta no lugar da carta mais fraca da qual ninguém depende; sem essa carta, sai ela mesma (todas as cópias).
  const materials = new Set(extraCards.flatMap(materialsOf));
  const kept = (card) => card.maximum || materials.has(card.name) || materials.has(card.nameEn) || fusions.includes(card) || card.type & TYPE.RITUAL;
  for (let pass = 0; pass < 30; pass += 1) {
    const cards = main.map((id) => byId.get(id));
    const needy = cards.find((card) => !meetsRequirements(card, cards, extraCards));
    if (!needy) break;
    const before = useless(cards, extraCards);
    const swap = (from, to, check = true) => {
      const at = main.indexOf(from.id);
      const after = check && main.map((id, j) => byId.get(j === at ? to.id : id));
      if (check && useless(after, extraCards) >= before) return false;
      counts.set(nameKey(from), counts.get(nameKey(from)) - 1);
      counts.set(nameKey(to), (counts.get(nameKey(to)) || 0) + 1);
      if (to.legend) legendUsed.add(category(to));
      main[at] = to.id;
      return true;
    };
    const missing = requirementsOf(needy).find((options) => !options.some((option) => [...cards, ...extraCards].some((c) => fits(option, c))));
    const pieces = pool.filter((card) => allowed(card) && missing.some((option) => fits(option, card)));
    const piece = pieces.length && pickFrom(pieces);
    const weakest = [...new Set(cards)].filter((card) => card !== needy && !kept(card)).sort((a, b) => (weights.get(a.id) ?? 9) - (weights.get(b.id) ?? 9));
    if (piece && weakest.some((card) => swap(card, piece))) continue;
    // Sem a peça: troca a carta por outra do mesmo grupo (monstro por monstro de Nível parecido, Magia por Magia...); se outra
    // carta dependia dela, essa vira a próxima a consertar (a que saiu não volta: o requisito dela continua sem nada).
    // Peça de Máximo só sai com o pacote inteiro (as três, todas as cópias): o trio nunca fica incompleto.
    // Uma troca por vez: allowed vê as cópias já usadas pelas trocas anteriores.
    const out = needy.maximum ? cards.filter((card) => card.maximum) : [needy];
    const candidates = () => pool.filter((card) => allowed(card) && meetsRequirements(card, cards, extraCards));
    if (!candidates().length) break;
    for (const card of out) {
      const quota = plan.find((q) => q.test(card)) || plan[0];
      const options = candidates();
      const grouped = options.filter(quota.test);
      swap(card, pickFrom(grouped.length ? grouped : options), false); // ponytail: pool do Rush tem milhares de cartas, options nunca esvazia no meio
    }
  }
  return { main, extra, theme: { race: theme.race, name: raceName, attribute, setcode } };
}
