// "Por que não dá agora?", resposta automática de pergunta obrigatória com uma opção e as marcas do turno no motor.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import createCore, { OcgLocation as L, OcgMessageType as M, OcgResponseType as R } from '../src/vendor/ocgcore/index.js';
import { createDuel } from '../src/engine/ocg.mjs';
import { BLOCKED, monsterWhyNot, whereLabel } from '../src/ui/card-gestures.js';
import { answerCommon, soleChoice } from '../src/ui/ocg-ask.js';

test('monsterWhyNot: só afirma o que as marcas mostram; o resto é "um efeito impede"', () => {
  const base = { battle: false, canBattle: false, firstTurn: false, summoned: false, set: false, moved: false, attacked: false, attackPos: true };
  assert.equal(monsterWhyNot({ ...base, summoned: true }), 'Monstro Invocado neste turno não pode mudar de posição.');
  assert.equal(monsterWhyNot({ ...base, moved: true, canBattle: true }), 'Este monstro já mudou de posição neste turno. Para atacar, vá para a Batalha.');
  assert.match(monsterWhyNot({ ...base, set: true }), /baixado neste turno/);
  assert.match(monsterWhyNot({ ...base, summoned: true, firstTurn: true, canBattle: true }), /Quem começa não ataca/);
  assert.equal(monsterWhyNot(base), BLOCKED);
  // Batalha: turno 1, já atacou, Defesa; senão é efeito.
  assert.match(monsterWhyNot({ ...base, battle: true, firstTurn: true }), /primeiro turno/);
  assert.equal(monsterWhyNot({ ...base, battle: true, attacked: true }), 'Este monstro já atacou neste turno.');
  assert.equal(monsterWhyNot({ ...base, battle: true, attackPos: false }), 'Só monstros em Posição de Ataque atacam.');
  assert.equal(monsterWhyNot({ ...base, battle: true }), BLOCKED);
});

test('whereLabel: "sua mão" e "mão do rival", igual nas duas arenas', () => {
  assert.equal(whereLabel(L.HAND, true), 'sua mão');
  assert.equal(whereLabel(L.HAND, false), 'mão do rival');
  assert.equal(whereLabel(L.GRAVE, true), 'seu Cemitério');
});

test('soleChoice: só pergunta obrigatória com exatamente uma opção responde sozinha', () => {
  const loc = { controller: 0, location: L.MZONE, sequence: 0, code: 1 };
  assert.equal(soleChoice({ type: M.SELECT_CHAIN, forced: true, selects: [loc] }), 0);
  assert.equal(soleChoice({ type: M.SELECT_CHAIN, forced: false, selects: [loc] }), -1, 'opcional: o jogador decide se ativa');
  assert.equal(soleChoice({ type: M.SELECT_CHAIN, forced: true, selects: [loc, loc] }), -1, 'dois efeitos: escolher a ordem é escolha');
  assert.equal(soleChoice({ type: M.SELECT_CARD, can_cancel: false, min: 1, max: 1, selects: [loc] }), 0);
  assert.equal(soleChoice({ type: M.SELECT_CARD, can_cancel: true, min: 1, max: 1, selects: [loc] }), -1, 'cancelável: dá para desistir');
  assert.equal(soleChoice({ type: M.SELECT_CARD, can_cancel: false, min: 1, max: 1, selects: [loc, loc] }), -1);
  assert.equal(soleChoice({ type: M.SELECT_TRIBUTE, can_cancel: false, min: 1, max: 1, selects: [loc] }), -1);
});

test('answerCommon responde sozinho a seleção obrigatória de uma carta e avisa', async () => {
  const toasts = [];
  const ctx = { ask: () => assert.fail('não devia perguntar'), me: 0, cardOf: () => ({ name: 'X' }), cardItem: () => ({ label: 'Sacerdote Asura · seu campo' }), hint: (text) => text, plan: {}, toast: (text) => toasts.push(text) };
  const response = await answerCommon({ type: M.SELECT_CARD, can_cancel: false, min: 1, max: 1, selects: [{ controller: 0, location: L.MZONE, sequence: 0, code: 1 }] }, ctx);
  assert.deepEqual(response, { type: R.SELECT_CARD, indicies: [0] });
  assert.deepEqual(toasts, ['Escolha: Sacerdote Asura · seu campo.']);
});

test('motor marca no turno quem foi Invocado, mudou de posição e atacou; o turno novo limpa', async () => {
  const root = new URL('../', import.meta.url);
  const pool = JSON.parse(readFileSync(new URL('src/data/classic/s1.json', root)));
  const cards = new Map(pool.map((card) => [card.id, card]));
  const readScript = (name) => { try { return readFileSync(new URL(`src/vendor/card-scripts/${name}`, root), 'utf-8'); } catch { return null; } };
  const lib = await createCore({ sync: true });
  const main = Array(20).fill(pool.find((card) => card.nameEn === 'Celtic Guardian').id);
  const duel = createDuel(lib, { seed: 'marcas', decks: [{ main }, { main }], cards, readScript });
  const seen = { summoned: false, attacked: false, moved: false, cleared: false };
  let lastTurn = 0;
  for (let guard = 0; guard < 300 && !(seen.attacked && seen.moved && seen.cleared); guard += 1) {
    const { prompt, winner } = duel.next();
    if (winner !== null) break;
    const { marks } = duel.state;
    if (duel.state.turn !== lastTurn) { if (lastTurn && !marks.summoned.size && !marks.attacked.size) seen.cleared = true; lastTurn = duel.state.turn; }
    if (marks.summoned.has(`${duel.state.active}:${L.MZONE}:0`)) seen.summoned = true;
    if (marks.attacked.size) seen.attacked = true;
    if (marks.moved.size) seen.moved = true;
    if (prompt.type === M.SELECT_IDLECMD) {
      // O rival só passa. Você invoca no turno 1; no 3 muda a posição dele, invoca outro e ataca com o novo.
      const mine = duel.state.active === 0;
      const action = !mine ? 7 : !seen.moved && duel.state.turn >= 3 && prompt.pos_changes.length ? 2 : prompt.summons.length ? 0 : prompt.to_bp ? 6 : 7;
      duel.respond({ type: R.SELECT_IDLECMD, action, index: action === 6 || action === 7 ? null : 0 });
    } else if (prompt.type === M.SELECT_BATTLECMD) duel.respond(prompt.attacks.length ? { type: R.SELECT_BATTLECMD, action: 1, index: 0 } : { type: R.SELECT_BATTLECMD, action: 3, index: null });
    else if (prompt.type === M.SELECT_CHAIN) duel.respond({ type: R.SELECT_CHAIN, index: null });
    else if (prompt.type === M.SELECT_PLACE) duel.respond({ type: R.SELECT_PLACE, places: [{ player: prompt.player, location: L.MZONE, sequence: [0, 1, 2, 3, 4].find((seq) => !(prompt.field_mask & (1 << seq))) }] });
    else if (prompt.type === M.SELECT_CARD) duel.respond({ type: R.SELECT_CARD, indicies: Array.from({ length: prompt.min }, (_, i) => i) });
    else if (prompt.type === M.SELECT_POSITION) duel.respond({ type: R.SELECT_POSITION, position: 1 });
    else duel.respond({ type: R.SELECT_YESNO, yes: true });
  }
  duel.destroy();
  assert.deepEqual(seen, { summoned: true, attacked: true, moved: true, cleared: true });
});
