const DIFFICULTIES = {
  apprentice: {
    id: 'apprentice',
    label: 'Aprendiz',
    rating: 1,
    enemyPower: 0.68,
    enemyLp: 4000,
    ai: 'basic',
    handQuality: 0.45,
    modifier: 'O inimigo começa com 4.000 PV.',
  },
  duelist: {
    id: 'duelist',
    label: 'Duelista',
    rating: 2,
    enemyPower: 0.86,
    enemyLp: 5000,
    ai: 'tactical',
    handQuality: 0.6,
    modifier: 'Regras padrão. O inimigo prioriza jogadas eficientes.',
  },
  elite: {
    id: 'elite',
    label: 'Elite',
    rating: 3,
    enemyPower: 1,
    enemyLp: 6000,
    ai: 'tactical',
    handQuality: 0.78,
    modifier: 'O inimigo começa com 6.000 PV e uma mão mais consistente.',
  },
  chaos: {
    id: 'chaos',
    label: 'Caos',
    rating: 4,
    enemyPower: 1.12,
    enemyLp: 7000,
    ai: 'threat-aware',
    handQuality: 0.9,
    modifier: 'O inimigo começa com 7.000 PV e usa modificadores do desafio.',
  },
};

const DEFAULT_DIFFICULTY = 'duelist';
// 30 cartas: com 20, compra-até-5 esvaziava o deck por volta do turno 7 e ~1/3 dos duelos acabava em deck-out.
export const DECK_SIZE = 30;
const DECK_SHAPE = { monster: 21, spell: 6, trap: 3 };

function hashSeed(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nextRandom(state) {
  state.value ^= state.value << 13;
  state.value ^= state.value >>> 17;
  state.value ^= state.value << 5;
  return (state.value >>> 0) / 4294967296;
}

function pickRandom(items, random) {
  return items[Math.floor(random() * items.length)];
}

function weightedPick(items, random, score) {
  const total = items.reduce((sum, item) => sum + Math.max(0.01, score(item)), 0);
  let cursor = random() * total;
  for (const item of items) {
    cursor -= Math.max(0.01, score(item));
    if (cursor <= 0) return item;
  }
  return items.at(-1);
}

function copyCard(card, index) {
  return { ...card, copyIndex: index };
}

function legalCopies(card, selected) {
  if (card.legend) return selected.some((item) => item.legend && item.type === card.type) ? 0 : 1;
  return Math.min(3, 3 - selected.filter((item) => item.id === card.id).length);
}

function fillPool({ archetype, pool, count, random, power, role, selected = [] }) {
  const added = [];
  const candidates = pool.filter((card) => card.role === role || card.archetype === archetype || role === 'staple');
  const source = candidates.length ? candidates : pool;
  while (added.length < count && source.length) {
    const available = source.filter((card) => legalCopies(card, selected) > 0);
    if (!available.length) break;
    const card = weightedPick(available, random, (item) => {
      const fitsRole = item.role === role ? 3 : 1;
      // Do arquétipo pesa muito; neutras (sem Tipo) servem a qualquer deck; de outro Tipo quase nunca.
      const fitsArchetype = item.archetype === archetype ? 4 : item.archetype ? 0.35 : 1.5;
      const fitsPower = 1 + Math.max(0, 1 - Math.abs((item.power || 0.5) - power));
      return fitsRole * fitsArchetype * fitsPower;
    });
    const copy = copyCard(card, selected.length);
    selected.push(copy);
    added.push(copy);
  }
  return added;
}

function scoreDeck(deck, archetype) {
  const monsters = deck.filter((card) => card.type === 'monster').length;
  const spells = deck.filter((card) => card.type === 'spell').length;
  const traps = deck.filter((card) => card.type === 'trap').length;
  const archetypeCards = deck.filter((card) => card.archetype === archetype).length;
  const averagePower = deck.reduce((sum, card) => sum + (card.power || 0), 0) / Math.max(1, deck.length);
  const curve = deck.filter((card) => card.type === 'monster' && (card.level || 0) <= 4).length;
  const consistency = (archetypeCards / Math.max(1, deck.length)) * 0.4 + Math.min(monsters / 14, 1) * 0.3 + Math.min(curve / 8, 1) * 0.2 + Math.min((spells + traps) / 6, 1) * 0.1;
  return { monsters, spells, traps, archetypeCards, averagePower, consistency };
}

export function getDifficulty(id = DEFAULT_DIFFICULTY) {
  return DIFFICULTIES[id] || DIFFICULTIES[DEFAULT_DIFFICULTY];
}

export function listDifficulties() {
  return Object.values(DIFFICULTIES).map((difficulty) => ({ ...difficulty }));
}

export function generateDeck({ seed, archetype, pool, difficulty = DEFAULT_DIFFICULTY, role = 'player' }) {
  const settings = getDifficulty(difficulty);
  const randomState = { value: hashSeed(`${seed}:deck:${role}:${archetype}:${settings.id}`) };
  const random = () => nextRandom(randomState);
  const targetPower = role === 'enemy' ? settings.enemyPower : 0.82;
  const selected = [];
  const monsters = fillPool({ archetype, pool, count: DECK_SHAPE.monster, random, power: targetPower, role: 'monster', selected });
  const spells = fillPool({ archetype, pool, count: DECK_SHAPE.spell, random, power: targetPower, role: 'spell', selected });
  const traps = fillPool({ archetype, pool, count: DECK_SHAPE.trap, random, power: targetPower, role: 'trap', selected });
  const deck = [...selected];
  return { deck, stats: scoreDeck(deck, archetype), difficulty: settings.id, archetype, seed: `${seed}:deck:${role}`, valid: deck.length === DECK_SIZE && monsters.length >= DECK_SHAPE.monster - 4 };
}

function evaluateMatch(player, enemy, difficulty) {
  const powerGap = Math.abs(player.stats.averagePower - enemy.stats.averagePower);
  const consistencyGap = Math.abs(player.stats.consistency - enemy.stats.consistency);
  const archetypeOverlap = player.deck.filter((card) => card.archetype === enemy.archetype).length / player.deck.length;
  const interaction = player.stats.spells + player.stats.traps + enemy.stats.spells + enemy.stats.traps;
  const tension = Math.max(0, 1 - powerGap * 1.5) * 0.45 + Math.max(0, 1 - consistencyGap * 2) * 0.25 + Math.min(interaction / 12, 1) * 0.2 + (1 - archetypeOverlap) * 0.1;
  const target = difficulty === 'chaos' ? 0.62 : difficulty === 'elite' ? 0.68 : 0.74;
  return { score: Number(tension.toFixed(4)), target, interesting: tension >= target, reasons: { powerGap: Number(powerGap.toFixed(4)), consistencyGap: Number(consistencyGap.toFixed(4)), interaction } };
}

export function generateDailyMatch({ date, playerKey, difficulty = DEFAULT_DIFFICULTY, archetypes, pool }) {
  const settings = getDifficulty(difficulty);
  // Mesmo desafio para todo mundo no dia: a chave do jogador não entra na seed.
  // Seu deck depende só da data (igual em toda dificuldade); a dificuldade escolhe e calibra o rival.
  const seed = `${date}:${settings.id}`;
  const playerRandom = { value: hashSeed(`${date}:player`) };
  const playerArchetype = pickRandom(archetypes, () => nextRandom(playerRandom));
  const randomState = { value: hashSeed(`${seed}:match`) };
  const random = () => nextRandom(randomState);
  const enemyCandidates = archetypes.filter((archetype) => archetype !== playerArchetype);
  const enemyArchetype = pickRandom(enemyCandidates.length ? enemyCandidates : archetypes, random);
  const player = generateDeck({ seed: date, archetype: playerArchetype, pool, difficulty: DEFAULT_DIFFICULTY, role: 'player' });
  const enemy = generateDeck({ seed, archetype: enemyArchetype, pool, difficulty, role: 'enemy' });
  const match = evaluateMatch(player, enemy, difficulty);
  return {
    version: 1,
    date,
    playerKey,
    difficulty: settings,
    seed,
    player,
    enemy: { ...enemy, lp: settings.enemyLp },
    match,
  };
}

export const DIFFICULTY_IDS = Object.keys(DIFFICULTIES);
