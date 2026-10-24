// Estresse do pool clássico: duelos com decks sorteados da temporada e escolhas aleatórias.
//   node tools/classic/simulate.mjs [duelos=100] [temporada=1]
// Conta erros de script, perguntas que o bot não soube responder e a duração dos duelos.
import { readFileSync } from 'node:fs';
import createCore, { OcgLocation as L, OcgMessageType as M, OcgResponseType as R } from '../../src/vendor/ocgcore/index.js';
import { FORMATS, createDuel, isExtra } from '../../src/engine/ocg.mjs';

const ROOT = new URL('../../', import.meta.url);
const duels = Number(process.argv[2] || 100);
const season = Number(process.argv[3] || 1);
const FORMAT = FORMATS.classico; // o formato do PvP (o rápido não é mais usado no jogo)
const pool = Array.from({ length: season }, (_, i) => JSON.parse(readFileSync(new URL(`src/data/classic/s${i + 1}.json`, ROOT)))).flat();
const cards = new Map([...JSON.parse(readFileSync(new URL('src/data/classic/tokens.json', ROOT))), ...pool].map((card) => [card.id, card]));
const scriptCache = new Map();
const readScript = (name) => {
  if (!scriptCache.has(name)) { try { scriptCache.set(name, readFileSync(new URL(`src/vendor/card-scripts/${name}`, ROOT), 'utf-8')); } catch { scriptCache.set(name, null); } }
  return scriptCache.get(name);
};

let state = 12345;
const rand = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
const pick = (n) => Math.floor(rand() * n);
const sample = (list, n) => Array.from({ length: n }, () => list[pick(list.length)].id);
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

function respond(m) {
  switch (m.type) {
    case M.SELECT_IDLECMD:
      if (m.special_summons.length && rand() < 0.5) return { type: R.SELECT_IDLECMD, action: 1, index: pick(m.special_summons.length) };
      if (m.summons.length && rand() < 0.7) return { type: R.SELECT_IDLECMD, action: 0, index: pick(m.summons.length) };
      if (m.activates.length && rand() < 0.6) return { type: R.SELECT_IDLECMD, action: 5, index: pick(m.activates.length) };
      if (m.monster_sets.length && rand() < 0.4) return { type: R.SELECT_IDLECMD, action: 3, index: pick(m.monster_sets.length) };
      if (m.spell_sets.length && rand() < 0.4) return { type: R.SELECT_IDLECMD, action: 4, index: pick(m.spell_sets.length) };
      return { type: R.SELECT_IDLECMD, action: m.to_bp ? 6 : 7, index: null };
    case M.SELECT_BATTLECMD:
      if (m.attacks.length) return { type: R.SELECT_BATTLECMD, action: 1, index: pick(m.attacks.length) };
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
    case M.SELECT_SUM: {
      const level = (card) => card.amount & 0xffff;
      const need = m.amount - m.selects_must.reduce((sum, card) => sum + level(card), 0);
      for (let mask = 1; mask < 1 << Math.min(m.selects.length, 14); mask += 1) {
        const idx = []; let sum = 0;
        for (let i = 0; i < m.selects.length; i += 1) if (mask & (1 << i)) { idx.push(i); sum += level(m.selects[i]); }
        if (m.select_max ? sum >= need : sum === need) return { type: R.SELECT_SUM, indicies: idx };
      }
      return { type: R.SELECT_SUM, indicies: [0] };
    }
    case M.SELECT_COUNTER: { let left = m.count; return { type: R.SELECT_COUNTER, counters: m.cards.map((card) => { const take = Math.min(left, card.count ?? left); left -= take; return take; }) }; }
    case M.SORT_CARD: case M.SORT_CHAIN: return { type: R.SORT_CARD, order: null };
    case M.ANNOUNCE_NUMBER: return { type: R.ANNOUNCE_NUMBER, value: 0 };
    case M.ANNOUNCE_RACE: return { type: R.ANNOUNCE_RACE, races: [1n] };
    case M.ANNOUNCE_ATTRIB: return { type: R.ANNOUNCE_ATTRIB, attributes: [1] };
    case M.ANNOUNCE_CARD: return { type: R.ANNOUNCE_CARD, card: mainPool[0].id };
    case M.ROCK_PAPER_SCISSORS: return { type: R.ROCK_PAPER_SCISSORS, value: 1 + pick(3) };
    default:
  }
  return null;
}

const lib = await createCore({ sync: true });
const errors = new Map();
const unanswered = new Map();
const turns = [];
let stuck = 0, retries = 0;
const started = Date.now();
for (let n = 0; n < duels; n += 1) {
  const decks = [0, 1].map(() => ({ main: sample(mainPool, FORMAT.main), extra: sample(extraPool, FORMAT.extra) }));
  const duel = createDuel(lib, { seed: `sim:${n}`, decks, format: FORMAT, cards, readScript, onError: (text) => errors.set(text.split('\n')[0], (errors.get(text.split('\n')[0]) || 0) + 1) });
  let steps = 0, last = null, repeat = 0;
  for (;;) {
    const { prompt, winner, events } = duel.next();
    if (winner !== null) { turns.push(duel.state.turn); break; }
    if (events.some((e) => e.type === M.RETRY)) { retries += 1; repeat += 1; } else repeat = 0;
    const response = repeat > 3 ? null : respond(repeat ? last : prompt);
    if (!response || steps++ > 5000) {
      if (!response && repeat <= 3) unanswered.set(prompt.type, (unanswered.get(prompt.type) || 0) + 1);
      stuck += 1; break;
    }
    last = prompt;
    duel.respond(response);
  }
  duel.destroy();
}
turns.sort((a, b) => a - b);
console.log(`${duels} duelos em ${((Date.now() - started) / 1000).toFixed(1)}s | turnos: mediana ${turns[turns.length >> 1]}, p90 ${turns[Math.floor(turns.length * 0.9)]} | travados ${stuck} | respostas recusadas ${retries}`);
console.log('erros de script:', errors.size ? [...errors].sort((a, b) => b[1] - a[1]).slice(0, 15) : 'nenhum');
if (unanswered.size) console.log('perguntas sem resposta:', [...unanswered]);
