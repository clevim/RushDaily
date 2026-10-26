// Booster determinístico do clássico (puro: sem DOM, testável no node).
import { seeded } from './classic-deck.mjs';
import { isExtra } from './ocg.mjs';
import { listDifficulties } from './daily-generator.mjs';

const FOILS = {
  common: [[null, 55], ['star', 18], ['etched', 15], ['prism', 12]],
  silverCommon: [[null, 25], ['star', 30], ['etched', 25], ['prism', 20]],
  allFoil: [['star', 35], ['etched', 30], ['prism', 35]],
  rare: [['prism', 40], ['gold', 35], ['galaxy', 25]],
  legend: [['gold', 60], ['galaxy', 40]],
  cosmic: [['galaxy', 70], ['gold', 30]],
};
// Chance de cada raridade de pacote (em 100): a sorte decide pela seed do jogador.
const TIER_ODDS = [['galaxy', 2], ['gold', 8], ['silver', 20], ['common', 70]];
// Sorte acumulada (vale em todas as dificuldades): cada pacote que não passa do piso soma o rating da dificuldade
// (Aprendiz 1 ... Caos 4) e cada ponto soma estes pesos (até 32 pontos). Pacote acima do piso zera a sorte.
// Com 8 × rating pontos (o 9º pacote sem sorte), vem garantido um nível acima do piso.
const PITY_BONUS = { silver: 5, gold: 1.5, galaxy: 0.3 };
const PITY_CAP = 32;
// Piso do pacote por dificuldade (rating 1 a 4: Aprendiz, Duelista, Elite, Caos) e chance extra de Galáxia por ponto de rating acima de 2.
const TIER_ORDER = ['common', 'silver', 'gold', 'galaxy'];
export const DIFFICULTY_FLOOR = ['common', 'silver', 'gold', 'gold'];
const GALAXY_PER_RATING = 0.03;
// Tema de arquétipo: 35% dos pacotes, peso 20x, e no máximo THEME_MAX cartas dele por pacote (o resto varia).
const THEME_CHANCE = 0.35;
const THEME_WEIGHT = 20;
const THEME_MAX = 3;

function weighted(random, table) {
  let roll = random() * table.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [value, weight] of table) { roll -= weight; if (roll <= 0) return value; }
  return table.at(-1)[0];
}

/** Arquétipos com cartas suficientes para virar tema de pacote. */
const themesOf = (cards) => {
  const counts = new Map();
  for (const card of cards) if (card.archetype) counts.set(card.archetype, (counts.get(card.archetype) || 0) + 1);
  return [...counts].filter(([, n]) => n >= 8).map(([name]) => name).sort();
};

/**
 * Pacote do dia: raridade (comum, prata, ouro, galáxia), se aparece disfarçado de comum,
 * a disposição das cartas, um tema de arquétipo opcional e as 5 cartas (sem repetir) com foil e verso.
 * Slots por raridade impressa: comum nos comuns (sem monstros do Deck Adicional), rare/super nos raros, ultra/secret nos LEGEND.
 * Cartas que o jogador ainda não tem pesam 3x; as que ele já tem 3 cópias pesam 1/4.
 * luck: pontos de sorte que este pacote soma (0 = saiu acima do piso, a sorte zera).
 * Mesma seed, mesma coleção e mesma sorte acumulada: mesmo pacote.
 */
export function openBooster(seed, { owned = {}, pity = 0, cards, difficulty = null } = {}) {
  const random = seeded(seed);
  const themes = themesOf(cards);
  const theme = themes.length && random() < THEME_CHANCE ? themes[Math.floor(random() * themes.length)] : null;
  const rating = listDifficulties().find((item) => item.id === difficulty)?.rating || 1;
  const floor = TIER_ORDER.indexOf(DIFFICULTY_FLOOR[rating - 1]);
  const points = Math.min(pity, PITY_CAP);
  let tier = weighted(random, TIER_ODDS.map(([id, weight]) => [id, weight + (PITY_BONUS[id] || 0) * points]));
  // Dificuldade: a partir da Elite, chance extra de Galáxia; o piso só pode melhorar o pacote.
  const galaxyChance = rating >= 3 ? (rating - 2) * GALAXY_PER_RATING : 0;
  if (random() < galaxyChance) tier = 'galaxy';
  let rank = Math.max(TIER_ORDER.indexOf(tier), floor);
  if (rank === floor && pity >= 8 * rating) rank = Math.min(floor + 1, TIER_ORDER.length - 1);
  tier = TIER_ORDER[rank];
  const taken = new Set();
  let themed = 0;
  const weight = (card) => (owned[card.id] ? (owned[card.id] >= 3 ? 0.25 : 1) : 3) * (theme && card.archetype === theme ? THEME_WEIGHT : 1);
  const pick = (list) => {
    const open = (item) => !taken.has(item.id) && !(themed >= THEME_MAX && item.archetype === theme);
    const card = weighted(random, list.filter(open).map((item) => [item, weight(item)]));
    taken.add(card.id);
    if (theme && card.archetype === theme) themed += 1;
    return card;
  };
  const legends = cards.filter((card) => card.rarity === 'ultra' || card.rarity === 'secret');
  const rares = cards.filter((card) => card.rarity === 'rare' || card.rarity === 'super');
  const commons = cards.filter((card) => (!card.rarity || card.rarity === 'common') && !isExtra(card));
  const slot = (list, foils, rare) => ({ id: pick(list).id, foil: weighted(random, foils), back: rare ? 'safira' : 'rubi', rare });
  const recipe = {
    common: () => [...[0, 1, 2, 3].map(() => slot(commons, FOILS.common, false)), slot(rares, FOILS.rare, true)],
    silver: () => [...[0, 1, 2].map(() => slot(commons, FOILS.silverCommon, false)), slot(rares, FOILS.rare, true), slot(rares, FOILS.rare, true)],
    gold: () => [...[0, 1, 2].map(() => slot(commons, FOILS.allFoil, false)), slot(rares, FOILS.rare, true), slot(legends, FOILS.legend, true)],
    galaxy: () => [slot(rares, FOILS.allFoil, false), slot(rares, FOILS.cosmic, true), slot(rares, FOILS.cosmic, true), slot(legends, FOILS.cosmic, true), slot(legends, FOILS.cosmic, true)],
  }[tier];
  const picked = recipe();
  return { tier, theme, cards: picked, luck: rank > floor ? 0 : rating, disguise: (tier === 'gold' || tier === 'galaxy') && random() < 0.5, layout: random() < 0.5 ? 'arc' : 'row' };
}
