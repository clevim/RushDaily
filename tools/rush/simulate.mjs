// Estresse do Rush Duel no motor do EDOPro: duelos com decks gerados (rush-deck.mjs) jogados pela IA do rival
// e duelos com decks sorteados do pool inteiro jogados por um bot de escolhas aleatórias.
//   node tools/rush/simulate.mjs [duelos=200] [modo=todos|ia|aleatorio]
// Conta erros de script, perguntas sem resposta, respostas recusadas, travamentos e a duração dos duelos.
//   node tools/rush/simulate.mjs [dias=60] diario [cartas=30]
// Desafio diário (daily-generator.mjs) em cada dificuldade: jogador pilotado pela IA "elite" contra o rival do nível.
//   node tools/rush/simulate.mjs [duelos=100] niveis
// IA do Rush contra a IA gulosa do clássico com os mesmos decks (trocando de lado): mede o ganho de cada nível.
import { readFileSync } from 'node:fs';
import createCore, { OcgLocation as L, OcgMessageType as M, OcgResponseType as R } from '../../src/vendor/ocgcore/index.js';
import { FORMATS, RUSH_ZONES, createDuel, isExtra } from '../../src/engine/ocg.mjs';
import { decide } from '../../src/engine/ocg-ai.mjs';
import { AI_LEVELS, decideRush } from '../../src/engine/rush-ai.mjs';
import { buildRushDeck, validateRushDeck } from '../../src/engine/rush-deck.mjs';
import { DAILY_FORMAT, generateDailyMatch, listDifficulties } from '../../src/engine/daily-generator.mjs';
import { HEART_CARD, HEART_CODE, withHeart } from '../../src/engine/heart.mjs';

const ROOT = new URL('../../', import.meta.url);
const duels = Number(process.argv[2] || 200);
const mode = process.argv[3] || 'todos';
if (!Number.isInteger(duels) || duels < 1 || !['todos', 'ia', 'aleatorio', 'diario', 'niveis'].includes(mode)) { console.error('uso: simulate.mjs [duelos] [todos|ia|aleatorio|diario|niveis] [cartas]'); process.exit(1); }
const FORMAT = FORMATS.rush;
const pool = JSON.parse(readFileSync(new URL('src/data/rush/cards.json', ROOT)));
const cards = new Map(pool.map((card) => [card.id, card]));
const scriptCache = new Map();
const readScript = (name) => {
  if (!scriptCache.has(name)) { try { scriptCache.set(name, readFileSync(new URL(`src/vendor/card-scripts/${name}`, ROOT), 'utf-8')); } catch { scriptCache.set(name, null); } }
  return scriptCache.get(name);
};

let seed = 12345;
const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const pick = (n) => Math.floor(rand() * n);
const sample = (list, n) => Array.from({ length: n }, () => list[pick(list.length)].id);
// Sorteio sem cuidar de regra de deck (cópias, Lenda): o objetivo é passar por todos os scripts.
const mainPool = pool.filter((card) => !isExtra(card));
const extraPool = pool.filter(isExtra);

function freePlaces(mask, player, count) {
  const out = [];
  for (const [side, owner] of [[0, player], [1, 1 - player]]) {
    for (const [location, offset, size] of [[L.MZONE, 0, 7], [L.SZONE, 8, 8]]) {
      for (let seq = 0; seq < size && out.length < count; seq += 1) if (!(mask & (1 << (offset + seq + side * 16)))) out.push({ player: owner, location, sequence: seq });
    }
  }
  return out;
}

function randomBot(m) {
  switch (m.type) {
    case M.SELECT_IDLECMD:
      if (m.special_summons.length && rand() < 0.5) return { type: R.SELECT_IDLECMD, action: 1, index: pick(m.special_summons.length) };
      if (m.summons.length && rand() < 0.7) return { type: R.SELECT_IDLECMD, action: 0, index: pick(m.summons.length) };
      if (m.activates.length && rand() < 0.6) return { type: R.SELECT_IDLECMD, action: 5, index: pick(m.activates.length) };
      if (m.monster_sets.length && rand() < 0.4) return { type: R.SELECT_IDLECMD, action: 3, index: pick(m.monster_sets.length) };
      if (m.spell_sets.length && rand() < 0.4) return { type: R.SELECT_IDLECMD, action: 4, index: pick(m.spell_sets.length) };
      return { type: R.SELECT_IDLECMD, action: m.to_bp ? 6 : 7, index: null };
    case M.SELECT_BATTLECMD:
      if (m.attacks.length && rand() < 0.9) return { type: R.SELECT_BATTLECMD, action: 1, index: pick(m.attacks.length) };
      return { type: R.SELECT_BATTLECMD, action: m.to_m2 ? 2 : 3, index: null };
    case M.SELECT_CHAIN: return { type: R.SELECT_CHAIN, index: m.selects.length && (m.forced || rand() < 0.5) ? pick(m.selects.length) : null };
    case M.SELECT_EFFECTYN: return { type: R.SELECT_EFFECTYN, yes: rand() < 0.8 };
    case M.SELECT_YESNO: return { type: R.SELECT_YESNO, yes: rand() < 0.8 };
    case M.SELECT_OPTION: return { type: R.SELECT_OPTION, index: pick(m.options.length) };
    case M.SELECT_CARD: return { type: R.SELECT_CARD, indicies: Array.from({ length: m.min }, (_, i) => i) };
    case M.SELECT_TRIBUTE: return { type: R.SELECT_TRIBUTE, indicies: Array.from({ length: m.min }, (_, i) => i) };
    case M.SELECT_UNSELECT_CARD: return { type: R.SELECT_UNSELECT_CARD, index: m.can_finish || !m.select_cards.length ? null : 0 };
    case M.SELECT_PLACE: case M.SELECT_DISFIELD: return { type: m.type === M.SELECT_PLACE ? R.SELECT_PLACE : R.SELECT_DISFIELD, places: freePlaces(m.field_mask, m.player, m.count || 1) };
    case M.SELECT_POSITION: for (const p of [1, 4, 8, 2]) if (m.positions & p) return { type: R.SELECT_POSITION, position: p }; break;
    case M.SORT_CARD: case M.SORT_CHAIN: return { type: R.SORT_CARD, order: null };
    default: return null; // o resto (somas, anúncios, contadores) fica com a IA
  }
  return null;
}

const lib = await createCore({ sync: true });
const errors = new Map();
const onError = (text) => errors.set(text.split('\n')[0], (errors.get(text.split('\n')[0]) || 0) + 1);
const median = (list) => [...list].sort((a, b) => a - b)[list.length >> 1];
const p90 = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length * 0.9)];

/** Um duelo com a IA do Rush nos dois lados (levels[time]); 'gulosa' usa a IA do clássico. */
function runDuel({ seed, decks, format, lp = null, hands = null, levels, skills = [] }) {
  const table = skills.length ? new Map([...cards, [HEART_CODE, HEART_CARD]]) : cards;
  const duel = createDuel(lib, { seed, decks, format, lp, hands, skills, cards: table, readScript: withHeart(readScript), onError });
  const memory = [{}, {}];
  let steps = 0, retries = 0, out = null;
  for (;;) {
    const { prompt, winner, retry } = duel.next();
    if (winner !== null) { out = { winner, turns: duel.state.turn, reason: duel.state.reason, retries }; break; }
    if (retry) retries += 1;
    const player = prompt.player ?? duel.state.active;
    const context = { view: duel.snapshot(), me: player, cards: table, state: duel.state, memory: memory[player], level: levels[player] };
    const response = levels[player] === 'gulosa' ? decide(prompt, context) : decideRush(prompt, context);
    if (!response || steps++ > 6000 || retries > 50) { out = { winner: null, turns: duel.state.turn, reason: 'travou', retries }; break; }
    duel.respond(response);
  }
  duel.destroy();
  return out;
}

if (mode === 'diario') {
  const size = Number(process.argv[4] || DAILY_FORMAT.main);
  const format = { ...DAILY_FORMAT, main: size };
  const started = Date.now();
  console.log(`desafio diário: ${duels} dias x 4 dificuldades, deck de ${size}, jogador = IA elite`);
  const all = [];
  for (const difficulty of listDifficulties()) {
    const turns = [], reasons = new Map();
    let wins = 0, stuck = 0;
    for (let n = 0; n < duels; n += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
      const match = generateDailyMatch({ date, difficulty: difficulty.id, pool });
      const decks = [match.player.deck, match.enemy.deck];
      if (size !== DAILY_FORMAT.main) decks.forEach((deck, team) => { deck.main = buildRushDeck({ seed: `${date}:${team}`, pool, format, race: [match.player.theme, match.enemy.theme][team].race }).main; });
      const result = runDuel({ seed: match.seed, decks, format, lp: [match.player.lp, match.enemy.lp], hands: match.enemy.hand ? [format.hand, match.enemy.hand] : null, levels: ['elite', match.enemy.ai] });
      if (result.winner === null) { stuck += 1; continue; }
      turns.push(result.turns); all.push(result.turns);
      if (result.winner === 0) wins += 1;
      reasons.set(result.reason, (reasons.get(result.reason) || 0) + 1);
    }
    console.log(`  ${difficulty.label.padEnd(9)} turnos: mediana ${median(turns)}, p90 ${p90(turns)} | jogador vence ${Math.round((wins / turns.length) * 100)}% | fim: ${JSON.stringify(Object.fromEntries(reasons))} | travados ${stuck}`);
  }
  console.log(`  geral: mediana ${median(all)} turnos, p90 ${p90(all)} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log('erros de script:', errors.size ? [...errors].sort((a, b) => b[1] - a[1]).slice(0, 15) : 'nenhum');
  process.exit(0);
}

if (mode === 'niveis') {
  const started = Date.now();
  console.log(`IA do Rush x IA gulosa do clássico: ${duels} duelos por nível, decks gerados de 40, cada lado começa metade das vezes`);
  for (const level of AI_LEVELS) {
    const turns = [];
    let wins = 0, done = 0, stuck = 0;
    for (let n = 0; n < duels; n += 1) {
      const decks = [0, 1].map((team) => buildRushDeck({ seed: `niveis:${n}:${team}`, pool }));
      const seat = n % 2; // lado da IA testada
      const levels = seat ? ['gulosa', level] : [level, 'gulosa'];
      const result = runDuel({ seed: `niveis:${n}`, decks, format: FORMAT, levels });
      if (result.winner === null) { stuck += 1; continue; }
      done += 1; turns.push(result.turns);
      if (result.winner === seat) wins += 1;
    }
    console.log(`  ${level.padEnd(9)} vence ${Math.round((wins / done) * 100)}% | turnos: mediana ${median(turns)}, p90 ${p90(turns)} | travados ${stuck}`);
  }
  console.log(`  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log('erros de script:', errors.size ? [...errors].sort((a, b) => b[1] - a[1]).slice(0, 15) : 'nenhum');
  process.exit(0);
}

const unanswered = new Map();
const stuckBy = new Map();
const badZones = new Set();
const illegal = [];
const result = { ia: { turns: [], stuck: 0, retries: 0, wins: [0, 0, 0], reasons: new Map() }, aleatorio: { turns: [], stuck: 0, retries: 0, wins: [0, 0, 0], reasons: new Map() } };
const started = Date.now();
for (let n = 0; n < duels; n += 1) {
  const kind = mode === 'todos' ? (n % 2 ? 'aleatorio' : 'ia') : mode;
  let decks;
  if (kind === 'ia') {
    decks = [0, 1].map((team) => buildRushDeck({ seed: `sim:${n}:${team}`, pool }));
    for (const deck of decks) { const problems = validateRushDeck(deck, cards); if (problems.length) illegal.push(problems[0]); }
  } else {
    decks = [0, 1].map(() => ({ main: sample(mainPool, FORMAT.main), extra: sample(extraPool, FORMAT.extra) }));
  }
  const stats = result[kind];
  const duel = createDuel(lib, { seed: `rush:${n}`, decks, format: FORMAT, cards, readScript, onError: (text) => errors.set(text.split('\n')[0], (errors.get(text.split('\n')[0]) || 0) + 1) });
  const memory = [{}, {}];
  let steps = 0, last = null, repeat = 0;
  for (;;) {
    const { prompt, winner, events } = duel.next();
    if (winner !== null) { stats.turns.push(duel.state.turn); stats.wins[winner] += 1; stats.reasons.set(duel.state.reason, (stats.reasons.get(duel.state.reason) || 0) + 1); break; }
    if (events.some((e) => e.type === M.RETRY)) { stats.retries += 1; repeat += 1; } else repeat = 0;
    const asked = repeat ? last : prompt;
    const view = duel.snapshot();
    // Campo de 3 colunas: nada pode aparecer fora das zonas de RUSH_ZONES.
    view.forEach((side) => {
      side.monsters.forEach((card, seq) => card && !RUSH_ZONES.monsters.includes(seq) && badZones.add(`MZONE ${seq}`));
      side.spells.forEach((card, seq) => card && !RUSH_ZONES.spells.includes(seq) && seq !== RUSH_ZONES.field && badZones.add(`SZONE ${seq}`));
    });
    const player = asked.player ?? duel.state.active;
    let response = null;
    if (repeat <= 3) {
      if (kind === 'aleatorio') response = randomBot(asked);
      response ??= decide(asked, { view, me: player, cards, state: duel.state, memory: memory[player] });
    }
    if (!response || steps++ > 5000) {
      if (!response && repeat <= 3) unanswered.set(asked.type, (unanswered.get(asked.type) || 0) + 1);
      stuckBy.set(`${kind}: ${!response ? (repeat > 3 ? `recusada ${asked.type}` : `sem resposta ${asked.type}`) : 'passos'}`, (stuckBy.get(`${kind}: ${!response ? (repeat > 3 ? `recusada ${asked.type}` : `sem resposta ${asked.type}`) : 'passos'}`) || 0) + 1);
      stats.stuck += 1; break;
    }
    last = asked;
    duel.respond(response);
  }
  duel.destroy();
}
console.log(`${duels} duelos Rush em ${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const [kind, s] of Object.entries(result)) {
  if (!s.turns.length && !s.stuck) continue;
  s.turns.sort((a, b) => a - b);
  console.log(`  ${kind === 'ia' ? 'IA x IA (decks gerados)' : 'bot aleatório (decks sorteados)'}: ${s.turns.length + s.stuck} duelos | turnos: mediana ${s.turns[s.turns.length >> 1]}, p90 ${s.turns[Math.floor(s.turns.length * 0.9)]} | vitórias ${s.wins[0]}/${s.wins[1]} (empates ${s.wins[2]}) | fim: ${JSON.stringify(Object.fromEntries(s.reasons))} | travados ${s.stuck} | respostas recusadas ${s.retries}`);
}
console.log('erros de script:', errors.size ? [...errors].sort((a, b) => b[1] - a[1]).slice(0, 15) : 'nenhum');
if (unanswered.size) console.log('perguntas sem resposta:', [...unanswered]);
if (stuckBy.size) console.log('travamentos:', [...stuckBy]);
if (badZones.size) console.log('cartas fora das zonas do campo de 3 colunas:', [...badZones]);
if (illegal.length) console.log('decks gerados ilegais:', illegal.length, illegal.slice(0, 5));
