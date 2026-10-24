// Desafio do dia no Rush Duel (motor do EDOPro): o mesmo para todo mundo no mesmo dia.
// Confronto de Tipos ("Guerreiros contra Dragões") sorteado pela data a partir de src/data/rush/cards.json;
// seu deck depende só da data, a dificuldade calibra o rival (PV, qualidade do deck e nível da IA).
import { FORMATS } from './ocg.mjs';
import { RUSH_LIMITS, buildRushDeck, rushThemes, seeded, validateRushDeck } from './rush-deck.mjs';

/**
 * Formato do diário: Rush oficial (deck de 40, adicional de 15) com limite de 30 turnos e PV menores (abaixo).
 * Medido no tools/rush/simulate.mjs (modo diario, 120 dias): com 30 cartas a mediana era a mesma (11 turnos),
 * mas ~10% dos duelos acabavam em deck vazio; com 40 isso cai para ~3%. Os PV (6.000 para você, 4.000 a 7.000
 * para o rival) é que deixam o duelo curto: com 8.000 dos dois lados a mediana ia a 14 turnos.
 */
export const DAILY_FORMAT = { ...FORMATS.rush, turnLimit: 30 };
export const DAILY_LIMITS = { ...RUSH_LIMITS, mainMin: DAILY_FORMAT.main };
export const PLAYER_LP = 6000;

const DIFFICULTIES = {
  apprentice: { id: 'apprentice', label: 'Aprendiz', rating: 1, enemyLp: 4000, ai: 'aprendiz', deckRank: 0, modifier: 'O rival começa com 4.000 PV, joga sem plano e recebe o deck mais fraco do dia.' },
  duelist: { id: 'duelist', label: 'Duelista', rating: 2, enemyLp: 5000, ai: 'duelista', deckRank: 1, modifier: 'O rival começa com 6.000 PV e usa as Invocações ilimitadas do Rush.' },
  elite: { id: 'elite', label: 'Elite', rating: 3, enemyLp: 6000, ai: 'elite', deckRank: 2, modifier: 'PV iguais (8.000), deck mais forte e respostas em toda chance.' },
  chaos: { id: 'chaos', label: 'Caos', rating: 4, enemyLp: 7000, ai: 'caos', deckRank: 3, modifier: '8.000 PV, o deck mais forte do dia e um rival que troca monstros sem medo.' },
};
const DEFAULT_DIFFICULTY = 'duelist';
export const DIFFICULTY_IDS = Object.keys(DIFFICULTIES);

export function getDifficulty(id = DEFAULT_DIFFICULTY) {
  return DIFFICULTIES[id] || DIFFICULTIES[DEFAULT_DIFFICULTY];
}
export function listDifficulties() {
  return Object.values(DIFFICULTIES).map((difficulty) => ({ ...difficulty }));
}

/** Tipos no plural, para o confronto ("Guerreiros contra Dragões"). */
export const RACE_PLURAL = {
  0x1: 'Guerreiros', 0x2: 'Magos', 0x4: 'Fadas', 0x8: 'Demônios', 0x10: 'Zumbis', 0x20: 'Máquinas', 0x40: 'Aquas', 0x80: 'Piros',
  0x100: 'Rochas', 0x200: 'Bestas Aladas', 0x400: 'Plantas', 0x800: 'Insetos', 0x1000: 'Trovões', 0x2000: 'Dragões', 0x4000: 'Bestas',
  0x8000: 'Bestas-Guerreiras', 0x10000: 'Dinossauros', 0x20000: 'Peixes', 0x40000: 'Serpentes Marinhas', 0x80000: 'Répteis', 0x100000: 'Psíquicos',
  0x800000: 'Wyrms', 0x1000000: 'Cibersos', 0x4000000: 'Ciborgues', 0x8000000: 'Cavaleiros Mágicos', 0x10000000: 'Dragões Supremos',
  0x40000000: 'Guerreiros Celestiais', 0x80000000: 'Galáxias',
};
export const ATTRIBUTE_OF = { 0x1: 'da Terra', 0x2: 'da Água', 0x4: 'do Fogo', 0x8: 'do Vento', 0x10: 'da Luz', 0x20: 'das Trevas', 0x40: 'Divinos' };

/**
 * Força de um deck (para escolher o rival de cada dificuldade): monstros mais fortes, Lendas, Fusões e Máximo.
 * Não precisa ser exato: só ordena decks do mesmo Tipo entre si.
 */
export function deckPower(deck, byId) {
  const cards = deck.main.map((id) => byId.get(id)).filter(Boolean);
  const monsters = cards.filter((card) => card.type & 1).map((card) => card.atk).sort((a, b) => b - a);
  const top = monsters.slice(0, 10).reduce((sum, atk) => sum + atk, 0) / 10;
  const effects = cards.filter((card) => card.type & 0x20).length;
  const legend = cards.filter((card) => card.legend).length;
  const maximum = cards.filter((card) => card.maximum).length;
  return Math.round(top + effects * 25 + legend * 150 + maximum * 60 + deck.extra.length * 20);
}

function themeLabel(theme) {
  return RACE_PLURAL[theme.race] || theme.name;
}

/**
 * O desafio de `date` (AAAA-MM-DD) na dificuldade pedida. A chave do jogador não entra na seed.
 * Devolve { version, date, seed, format, difficulty, player: { deck, theme, label, lp }, enemy: { deck, theme, label, lp, ai, power } }.
 */
export function generateDailyMatch({ date, difficulty = DEFAULT_DIFFICULTY, pool }) {
  const settings = getDifficulty(difficulty);
  const byId = new Map(pool.map((card) => [card.id, card]));
  // Confronto do dia: dois Tipos diferentes, sorteados pela data (pesos pelo tamanho do Tipo no pool).
  const random = seeded(`diario:${date}`);
  const themes = rushThemes(pool).sort((a, b) => a.race - b.race);
  const pick = (list) => {
    let roll = random() * list.reduce((sum, t) => sum + Math.sqrt(t.size), 0);
    for (const theme of list) { roll -= Math.sqrt(theme.size); if (roll <= 0) return theme; }
    return list.at(-1);
  };
  const mine = pick(themes);
  const rival = pick(themes.filter((theme) => theme.race !== mine.race));
  const player = buildRushDeck({ seed: `diario:${date}:voce`, pool, format: DAILY_FORMAT, race: mine.race });
  // Rival: quatro decks do Tipo dele, do mais fraco ao mais forte; a dificuldade escolhe a posição.
  const candidates = [0, 1, 2, 3].map((n) => buildRushDeck({ seed: `diario:${date}:rival:${n}`, pool, format: DAILY_FORMAT, race: rival.race }))
    .map((deck) => ({ deck, power: deckPower(deck, byId) }))
    .sort((a, b) => a.power - b.power);
  const enemy = candidates[settings.deckRank];
  return {
    version: 2,
    date,
    seed: `${date}:${settings.id}`,
    format: DAILY_FORMAT,
    difficulty: settings,
    player: { deck: { main: player.main, extra: player.extra }, theme: player.theme, label: themeLabel(player.theme), lp: PLAYER_LP },
    enemy: { deck: { main: enemy.deck.main, extra: enemy.deck.extra }, theme: enemy.deck.theme, label: themeLabel(enemy.deck.theme), lp: settings.enemyLp, ai: settings.ai, power: enemy.power },
  };
}

/** Problemas de um deck do diário (vazio = legal), com o limite de cartas do formato diário. */
export const validateDailyDeck = (deck, byId) => validateRushDeck(deck, byId, DAILY_LIMITS);
