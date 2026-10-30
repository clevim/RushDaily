// Estresse do pool clássico: duelos com decks sorteados da temporada e escolhas aleatórias.
//   node tools/classic/simulate.mjs [duelos=100] [temporada=1]
// Conta erros de script, perguntas que o bot não soube responder e a duração dos duelos.
// Fora Principal/Batalha/Corrente, responde pelo answerCommon da arena (ocg-ask.js) com escolhas aleatórias válidas no diálogo.
import { readFileSync } from 'node:fs';
import createCore, { OcgMessageType as M, OcgResponseType as R } from '../../src/vendor/ocgcore/index.js';
import { FORMATS, createDuel, isExtra } from '../../src/engine/ocg.mjs';
import { ATTRIBUTES, RACES } from '../../src/data/classic/strings-pt.mjs';
import { answerCommon } from '../../src/ui/ocg-ask.js';

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

// O diálogo da arena (createAsk) com escolhas aleatórias: só devolve o que o botão Confirmar deixaria.
async function ask({ items, min = 1, max = 1, cancel = false, valid = (chosen) => chosen.length >= min && chosen.length <= max, instant = max === 1 && min === 1, chosen: initial = [] }) {
  // Um toque responde; prefere o que não está marcado (o sorteio marcava e desmarcava o mesmo tributo para sempre).
  if (instant) { const fresh = [...items.keys()].filter((i) => !initial.includes(i)); return [fresh.length ? fresh[pick(fresh.length)] : pick(items.length)]; }
  for (let tries = 0; tries < 400; tries += 1) {
    const n = min + pick(Math.max(1, Math.min(max, items.length) - min + 1));
    const chosen = [...initial, ...[...items.keys()].filter((i) => !initial.includes(i)).sort(() => rand() - 0.5)].slice(0, Math.max(n, initial.length));
    if (valid(chosen)) return chosen;
  }
  return cancel ? null : [0];
}
const commonContext = (me) => ({
  ask, me, cards, cardOf: (code) => cards.get(code) || { name: String(code) }, cardItem: () => ({ label: '' }), face: () => '', back: () => '',
  describe: () => '', hint: (text) => text, plan: { target: null, tributes: null, zone: null }, races: RACES, attributes: ATTRIBUTES, inDuel: new Set(),
});

async function respond(m) {
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
    default: return (await answerCommon(m, commonContext(m.player))) ?? null;
  }
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
    const response = repeat > 3 ? null : await respond(repeat ? last : prompt);
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
