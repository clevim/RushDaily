import test from 'node:test';
import assert from 'node:assert/strict';
import { OcgLocation as L, OcgMessageType as M, OcgPosition as P, OcgResponseType as R } from '../src/vendor/ocgcore/index.js';
import { decideRush } from '../src/engine/rush-ai.mjs';

// Prompts sintéticos para a IA do Rush: letal, erro intencional (slip) e plano de Tributo a partir da mão.
const TRAP = 0x4, MONSTER = 0x1;
const cards = new Map([
  [1, { atk: 1000, def: 1000, level: 4, type: MONSTER }], // fraco (tributo)
  [2, { atk: 2400, def: 1000, level: 7, type: MONSTER }], // exige 2 tributos
  [3, { atk: 1700, def: 1000, level: 4, type: MONSTER }],
  [9, { atk: 0, def: 0, level: 0, type: TRAP }],
]);
const mon = (code, seq, attack) => ({ code, sequence: seq, position: P.FACEUP_ATTACK, attack, defense: 1000, level: 4 });
const side = (over = {}) => ({ hand: [], monsters: [], spells: [], ...over });

test('slip nunca cancela golpe letal nem encerra a Batalha', () => {
  for (let n = 0; n < 200; n += 1) {
    const memory = { rng: n * 7919 + 1 };
    const view = [side({ monsters: [null, mon(3, 1, 1700)] }), side()];
    const prompt = { type: M.SELECT_BATTLECMD, chains: [], attacks: [{ code: 3, sequence: 1, can_direct: true }], to_m2: true, to_ep: true };
    const r = decideRush(prompt, { view, me: 0, cards, state: { turn: 3, phase: 0, active: 0, lp: [8000, 1500] }, memory, level: 'duelista' });
    assert.deepEqual(r, { type: R.SELECT_BATTLECMD, action: 1, index: 0 });
  }
});

test('slip com um só candidato não encerra a Batalha', () => {
  for (let n = 0; n < 200; n += 1) {
    const view = [side({ monsters: [null, mon(3, 1, 1700)] }), side({ monsters: [null, null, mon(1, 2, 1000)] })];
    const prompt = { type: M.SELECT_BATTLECMD, chains: [], attacks: [{ code: 3, sequence: 1, can_direct: false }], to_m2: true, to_ep: true };
    const r = decideRush(prompt, { view, me: 0, cards, state: { turn: 3, phase: 0, active: 0, lp: [8000, 8000] }, memory: { rng: n * 31 + 5 }, level: 'duelista' });
    assert.equal(r.action, 1);
  }
});

test('Tributo na mão com campo vazio: sobe o fraco de propósito', () => {
  const loc = (code) => ({ code, location: L.HAND, sequence: 0, controller: 0 });
  const view = [side({ hand: [{ code: 2 }, { code: 1 }, { code: 1 }] }), side({ monsters: [null, mon(3, 1, 1700)] })];
  const prompt = { type: M.SELECT_IDLECMD, summons: [loc(1), loc(1)], monster_sets: [], special_summons: [], activates: [], spell_sets: [], pos_changes: [], to_bp: false, to_ep: true };
  const r = decideRush(prompt, { view, me: 0, cards, state: { turn: 1, phase: 0, active: 0, lp: [8000, 8000] }, memory: {}, level: 'elite' });
  assert.equal(r.type, R.SELECT_IDLECMD);
  assert.equal(r.action, 0); // Invocação-Normal
});

test('elite guarda a Armadilha contra ataque fraco e a usa contra ameaça', () => {
  const chain = { type: M.SELECT_CHAIN, forced: false, selects: [{ code: 9, location: L.SZONE }] };
  const run = (atk) => decideRush(chain, { view: [side(), side({ monsters: [null, mon(1, 1, atk)] })], me: 0, cards, state: { turn: 2, phase: 0, active: 1, lp: [8000, 8000] }, memory: { rng: 1, turn: 2, tried: new Set(), swings: new Map() }, level: 'elite' });
  assert.equal(run(800).index, null);
  assert.equal(run(2000).index, 0);
});
