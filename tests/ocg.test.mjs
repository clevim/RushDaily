import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import createCore, { OcgMessageType as M, OcgResponseType as R } from '../src/vendor/ocgcore/index.js';
import { FORMATS, createDuel } from '../src/engine/ocg.mjs';

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

test('o pool da temporada 1 tem script para toda carta com efeito', () => {
  const missing = pool.filter((card) => !(card.type & 0x10) && !readScript(`official/c${card.id}.lua`));
  assert.deepEqual(missing.map((card) => card.nameEn), []);
});
