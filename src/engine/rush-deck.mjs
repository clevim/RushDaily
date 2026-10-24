// Decks do Rush Duel (motor do EDOPro) gerados por seed a partir de src/data/rush/cards.json.
// Coerência sem decks reais: um tema (Tipo de monstro, com um Atributo de apoio e às vezes um arquétipo pelo setcode),
// curva de níveis com cotas, Magias/Armadilhas que citam o tema, pacote de Máximo e Fusões cujas matérias estão no deck.
// Regras oficiais: deck de 40 a 60, adicional até 15 (só Fusão), até 3 cópias por nome e no máximo 1 carta Lenda
// de cada categoria (1 monstro Lenda, 1 Magia Lenda, 1 Armadilha Lenda), contando deck e adicional.
import { FORMATS, TYPE, isExtra } from './ocg.mjs';
import { seeded } from './classic-deck.mjs';

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
// Texto em inglês para achar o tema citado (as traduções em PT não citam Tipo/Atributo pelo nome em inglês).
const textOf = (card) => (card.pt ? '' : card.desc || '');
const mentions = (card, word) => new RegExp(`\\b${word.replace(/[-\s]/g, '[-\\s]')}\\b`).test(textOf(card));
const citedRaces = (card) => Object.values(RACE_NAMES).filter((name) => mentions(card, name));
const citedAttributes = (card) => Object.values(ATTRIBUTE_NAMES).filter((name) => new RegExp(`\\b${name}\\b`).test(textOf(card)));

/** Cotas do deck de 40 (escalam para outros tamanhos): curva baixa, poucos de 1 e 2 Sacrifícios e 17 Magias/Armadilhas. */
function quotas(format) {
  const scale = format.main / 40;
  return [
    { key: 'low', monster: true, test: (c) => isMonster(c) && level(c) <= 4, n: Math.round(16 * scale) },
    { key: 'mid', monster: true, test: (c) => isMonster(c) && level(c) >= 5 && level(c) <= 6, n: Math.round(4 * scale) },
    { key: 'high', monster: true, test: (c) => isMonster(c) && level(c) >= 7, n: Math.round(3 * scale) },
    { key: 'spell', monster: false, test: (c) => Boolean(c.type & TYPE.SPELL), n: Math.round(9 * scale) },
    { key: 'trap', monster: false, test: (c) => Boolean(c.type & TYPE.TRAP), n: Math.round(8 * scale) },
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
      if (zone === 'extra' && !(card.type & TYPE.FUSION)) problems.push(`${nameKey(card)} não é Fusão e está no adicional`);
      if (zone === 'main' && isExtra(card)) problems.push(`${nameKey(card)} é do adicional e está no deck`);
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
 * Devolve { main, extra, theme: { race, name, attribute, setcode } }.
 */
export function buildRushDeck({ seed, pool, format = FORMATS.rush }) {
  const random = seeded(`rush:${seed}`);
  const byId = new Map(pool.map((card) => [card.id, card]));
  const themes = rushThemes(pool);
  const theme = weightedPick(random, themes.map((t) => [t, Math.sqrt(t.size)]));
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
  const attrName = ATTRIBUTE_NAMES[attribute];

  const main = [];
  const counts = new Map();
  const legendUsed = new Set();
  const plan = quotas(format).map((quota) => ({ ...quota, have: 0 }));
  const room = (card) => plan.find((quota) => quota.test(card) && quota.have < quota.n);
  const add = (card, n) => {
    for (let i = 0; i < n; i += 1) {
      main.push(card.id);
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
  const allowed = (card) => playable(card) && free(card) > 0 && !(card.legend && legendUsed.has(category(card)));

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
      if (races.includes(raceName)) w += 6;
      if (attrs.includes(attrName)) w += 3;
      // Cita outro Tipo/Atributo e não o nosso: provavelmente não funciona neste deck.
      if ((races.length && !races.includes(raceName)) || (attrs.length && !attrs.includes(attrName) && !races.includes(raceName))) w *= 0.05;
      if (/Fusion Summon/.test(textOf(card))) w *= 0.3; // Magias de Fusão entram pelo adicional
    }
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
  const byName = new Map(pool.filter(playable).map((card) => [card.nameEn, card]));
  const fusionCandidates = pool.filter((card) => card.type & TYPE.FUSION && card.race === theme.race && !card.legend)
    .map((card) => ({ card, mats: materialsOf(card).map((name) => byName.get(name)) }))
    .filter(({ mats }) => mats.length >= 2 && mats.every((mat) => mat && !mat.legend && level(mat) <= 6));
  if (fusionCandidates.length && random() < 0.6) {
    const { mats } = fusionCandidates[Math.floor(random() * fusionCandidates.length)];
    for (const mat of mats) if (room(mat)) add(mat, Math.min(2, free(mat)));
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
      const want = card.legend ? 1 : isMonster(card) && level(card) >= 7 ? 1 + Math.floor(random() * 2) : 2 + Math.floor(random() * 2);
      add(card, Math.min(want, free(card), quota.n - quota.have));
    }
  }
  // Pool pequeno (testes, coleção do jogador): completa com o que der, ainda pelo peso do tema.
  while (main.length < format.main) {
    const options = pool.filter(allowed);
    if (!options.length) break;
    add(pickFrom(options), 1);
  }

  // Adicional: Fusões cujas matérias citadas estão todas no deck (ou ao menos uma, com peso menor).
  const names = new Set(main.map((id) => byId.get(id)).flatMap((card) => [card.nameEn, card.name]));
  const scored = pool.filter((card) => card.type & TYPE.FUSION).map((card) => {
    const mats = materialsOf(card);
    const have = mats.filter((name) => names.has(name)).length;
    return [card, mats.length && have === mats.length ? 4 : have ? 1 : 0];
  }).filter(([, score]) => score > 0);
  const extra = [];
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
  if (extra.length) {
    // Só as que ainda não estão no deck (a cópia sorteada antes já conta).
    const wanted = fusions.filter((card) => !counts.get(nameKey(card)) && !(card.legend && legendUsed.has('spell'))).flatMap((card) => (card.legend ? [card] : [card, card]));
    for (let i = main.length - 1; i >= 0 && wanted.length; i -= 1) {
      const card = byId.get(main[i]);
      if (!(card.type & TYPE.SPELL) || card.legend || fusions.includes(card) || weights.get(card.id) > 1) continue;
      const swap = wanted.shift();
      counts.set(nameKey(card), counts.get(nameKey(card)) - 1);
      counts.set(nameKey(swap), (counts.get(nameKey(swap)) || 0) + 1);
      if (swap.legend) legendUsed.add('spell');
      main[i] = swap.id;
    }
  }
  return { main, extra, theme: { race: theme.race, name: raceName, attribute, setcode } };
}
