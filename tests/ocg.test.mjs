import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import createCore, { OcgMessageType as M, OcgResponseType as R } from '../src/vendor/ocgcore/index.js';
import { FORMATS, createDuel, isExtra, shuffled } from '../src/engine/ocg.mjs';
import { decide } from '../src/engine/ocg-ai.mjs';
import { answerCommon } from '../src/ui/ocg-ask.js';

const root = new URL('../', import.meta.url);
const pool = JSON.parse(readFileSync(new URL('src/data/classic/s1.json', root)));
const cards = new Map(pool.map((card) => [card.id, card]));
const readScript = (name) => { try { return readFileSync(new URL(`src/vendor/card-scripts/${name}`, root), 'utf-8'); } catch { return null; } };
const lib = await createCore({ sync: true });
const byName = (name) => pool.find((card) => card.nameEn === name).id;

test('duelo rápido termina pelo limite de turnos quando ninguém ataca', () => {
  const main = Array.from({ length: 20 }, () => byName('Celtic Guardian'));
  const errors = [];
  const duel = createDuel(lib, { seed: 'teste', decks: [{ main }, { main }], cards, readScript, onError: (text) => errors.push(text) });
  let result;
  for (let guard = 0; guard < 500; guard += 1) {
    result = duel.next();
    if (result.winner !== null) break;
    const { prompt } = result;
    if (prompt.type === M.SELECT_IDLECMD) duel.respond({ type: R.SELECT_IDLECMD, action: 7, index: null });
    else if (prompt.type === M.SELECT_CHAIN) duel.respond({ type: R.SELECT_CHAIN, index: null });
    else if (prompt.type === M.SELECT_CARD) duel.respond({ type: R.SELECT_CARD, indicies: Array.from({ length: prompt.min }, (_, i) => i) }); // descarte no fim do turno
    else assert.fail(`pergunta inesperada ${prompt.type}`);
  }
  assert.equal(result.winner, 2, 'PV iguais no limite = empate');
  assert.equal(duel.state.reason, 'turnos');
  assert.equal(duel.state.turn, FORMATS.rapido.turnLimit + 1);
  assert.deepEqual(errors, []);
  duel.destroy();
});

test('toda carta com efeito das temporadas ativas tem script e todos carregam sem erro no motor', () => {
  const seasons = JSON.parse(readFileSync(new URL('src/data/classic/seasons.json', root))).filter((season) => season.enabled);
  assert.ok(seasons.length);
  const active = seasons.flatMap(({ season }) => JSON.parse(readFileSync(new URL(`src/data/classic/s${season}.json`, root))));
  const all = new Map([...JSON.parse(readFileSync(new URL('src/data/classic/tokens.json', root))), ...active].map((card) => [card.id, card]));
  const missing = active.filter((card) => !(card.type & 0x10) && !readScript(`official/c${card.id}.lua`));
  assert.deepEqual(missing.map((card) => card.nameEn), []);
  // Duelos com todas as cartas (40 no deck e 15 no adicional por duelo): duelNewCard roda o initial_effect de cada uma.
  const main = active.filter((card) => !isExtra(card)).map((card) => card.id);
  const extra = active.filter(isExtra).map((card) => card.id);
  const errors = [];
  for (let i = 0, j = 0; i < main.length || j < extra.length; i += 40, j += 15) {
    const deck = { main: main.slice(i, i + 40), extra: extra.slice(j, j + 15) };
    const duel = createDuel(lib, { seed: `carga:${i}`, format: FORMATS.classico, decks: [deck, deck], cards: all, readScript, onError: (text) => errors.push(text) });
    duel.next();
    duel.destroy();
  }
  assert.deepEqual(errors, []);
});

test('seeds diferentes embaralham o mesmo deck em ordens diferentes; a mesma seed repete', () => {
  const deck = Array.from({ length: 40 }, (_, i) => 1000 + i);
  assert.deepEqual(shuffled(deck, 'dia:1'), shuffled(deck, 'dia:1'));
  assert.notDeepEqual(shuffled(deck, 'dia:1'), shuffled(deck, 'dia:2'));
  assert.deepEqual([...shuffled(deck, 'dia:2')].sort(), [...deck].sort());
});

test('soma de Níveis só deixa confirmar o que o motor aceita', async () => {
  // Medido emulando a arena: "pelo menos N" aceitava carta sobrando e o motor respondia RETRY.
  const loc = (amount) => ({ code: 0, controller: 0, location: 2, sequence: 0, position: 10, amount });
  let valid;
  const ctx = { ask: async (options) => { valid = options.valid; return options.chosen || []; }, me: 0, cards, cardOf: () => ({ name: 'x' }), cardItem: () => ({ label: 'x' }), face: () => '', back: () => '', describe: () => '', hint: (text) => text, plan: {} };
  await answerCommon({ type: M.SELECT_SUM, select_max: 1, amount: 8, min: 0, max: 0, selects_must: [], selects: [loc(4), loc(4), loc(1), loc(8)] }, ctx);
  assert.ok(valid([0, 1]) && valid([3]));
  assert.ok(!valid([0, 1, 2]) && !valid([3, 2]) && !valid([0]), 'Ritual: nenhuma carta pode sobrar');
  // Exata: cada carta vale o Nível ou o alternativo (amount = nível | alt << 16), misturando.
  await answerCommon({ type: M.SELECT_SUM, select_max: 0, amount: 4, min: 1, max: 99, selects_must: [], selects: [loc(1 | (3 << 16)), loc(1 | (3 << 16)), loc(4)] }, ctx);
  assert.ok(valid([0, 1]) && valid([2]));
  assert.ok(!valid([0]) && !valid([0, 2]));
  // Obrigatória vem marcada na frente (índice 0) e conta na soma.
  await answerCommon({ type: M.SELECT_SUM, select_max: 1, amount: 8, min: 0, max: 0, selects_must: [loc(4)], selects: [loc(4), loc(2)] }, ctx);
  assert.ok(valid([0, 1]) && !valid([0, 1, 2]) && !valid([0, 2]));
});

test('IA do rival ataca quando um efeito proíbe encerrar a Batalha', () => {
  // Sem to_m2 nem to_ep, "encerrar" dá RETRY e a IA repetia a mesma resposta para sempre (duelo travado).
  const side = () => ({ monsters: Array(7).fill(null), spells: Array(8).fill(null), hand: [], grave: [], banished: [], extra: [] });
  const view = [side(), side()];
  view[0].monsters[0] = { code: 1, position: 1, attack: 3000, defense: 0 };
  view[1].monsters[1] = { code: 2, position: 1, attack: 500, defense: 0 };
  const prompt = { type: M.SELECT_BATTLECMD, player: 1, chains: [], attacks: [{ code: 2, controller: 1, location: 4, sequence: 1, can_direct: false }], to_m2: false, to_ep: false };
  assert.deepEqual(decide(prompt, { view, me: 1, cards, state: { turn: 3 }, memory: {} }), { type: R.SELECT_BATTLECMD, action: 1, index: 0 });
});

test('SORT_CARD: a resposta é, para cada carta da mensagem, a posição dela na nova ordem (0 = topo do Deck)', () => {
  const fruits = 96677818; // Spellbook Organization: Duel.SortDecktop(tp, tp, 3)
  const others = pool.filter((card) => card.id !== fruits && (card.type & 1) && !isExtra(card, FORMATS.classico)).slice(0, 19).map((card) => card.id);
  const main = [...others, fruits]; // sem embaralhar: a última carta é a do topo, comprada primeiro
  const errors = [];
  const duel = createDuel(lib, { seed: 'sort', format: { ...FORMATS.classico, shuffle: false }, decks: [{ main }, { main: others }], hands: [5, 5], cards, readScript, onError: (text) => errors.push(text) });
  const top3 = () => lib.duelQueryLocation(duel.handle, { flags: 1, controller: 0, location: 1 }).map((card) => card.code).slice(-3).reverse(); // topo primeiro
  let before; let sorted = false;
  for (let guard = 0; guard < 50 && !sorted; guard += 1) {
    const { prompt } = duel.next();
    if (prompt.type === M.SELECT_IDLECMD) {
      const act = prompt.activates?.find((entry) => entry.code === fruits);
      if (act) { before = top3(); duel.respond({ type: R.SELECT_IDLECMD, action: 5, index: prompt.activates.indexOf(act) }); } else duel.respond({ type: R.SELECT_IDLECMD, action: 7, index: null });
    } else if (prompt.type === M.SELECT_CHAIN) duel.respond({ type: R.SELECT_CHAIN, index: prompt.selects.length && before ? 0 : null });
    else if (prompt.type === M.SORT_CARD) {
      assert.deepEqual(prompt.cards.map((card) => card.code), before, 'a mensagem lista o topo primeiro');
      duel.respond({ type: R.SORT_CARD, order: [2, 0, 1] }); // carta 0 -> posição 2, carta 1 -> 0, carta 2 -> 1
      sorted = true;
    } else if (prompt.type === M.SELECT_PLACE) duel.respond({ type: R.SELECT_PLACE, places: [{ player: 0, location: 8, sequence: 0 }] });
    else assert.fail(`pergunta inesperada ${prompt.type}`);
  }
  assert.ok(sorted, 'o motor pediu a ordem');
  duel.next();
  assert.deepEqual(top3(), [before[1], before[2], before[0]], 'posição 0 = topo');
  assert.deepEqual(errors, []);
  duel.destroy();
});
