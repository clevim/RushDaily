// Seleção de cartas (ocg-ask.js): a janela coleta tudo de uma vez e a resposta ao motor continua no formato dele.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OcgMessageType as M, OcgResponseType as R } from '../src/vendor/ocgcore/index.js';
import { answerCommon } from '../src/ui/ocg-ask.js';

const card = (code, sequence) => ({ code, controller: 0, location: 4, sequence });
const ctx = (answers) => {
  const asked = [];
  return {
    asked,
    me: 0, plan: { target: null, tributes: null, zone: null }, hint: (text) => text, cardOf: () => ({ name: 'x' }),
    cardItem: (loc) => ({ label: String(loc.code) }),
    ask: async (options) => { asked.push(options); return answers.shift(); },
  };
};

test('SELECT_UNSELECT_CARD: janela coleta 2 cartas e responde uma por passo, depois conclui', async () => {
  const [a, b, c] = [card(1, 0), card(2, 1), card(3, 2)];
  const context = ctx([[0, 2]]);
  const base = { type: M.SELECT_UNSELECT_CARD, can_cancel: true, min: 1, max: 2 };
  assert.deepEqual(await answerCommon({ ...base, can_finish: false, select_cards: [a, b, c], unselect_cards: [] }, context), { type: R.SELECT_UNSELECT_CARD, index: 0 });
  const second = await answerCommon({ ...base, can_finish: true, select_cards: [b, c], unselect_cards: [a] }, context);
  assert.equal(second.index, 1); // c, sem abrir a janela de novo
  const third = await answerCommon({ ...base, can_finish: true, select_cards: [b], unselect_cards: [a, c] }, context);
  assert.equal(third.index, null);
  assert.equal(context.asked.length, 1);
});

test('SELECT_UNSELECT_CARD: carta coletada que o motor não oferece mais volta a perguntar', async () => {
  const [a, b, c] = [card(1, 0), card(2, 1), card(3, 2)];
  const context = ctx([[0, 2], [1, 0]]);
  const base = { type: M.SELECT_UNSELECT_CARD, can_cancel: false, can_finish: false, min: 2, max: 2 };
  await answerCommon({ ...base, select_cards: [a, b, c], unselect_cards: [] }, context);
  // O motor recusou c (não fecha a combinação com a): só oferece b. Pergunta de novo com a já marcada.
  const again = await answerCommon({ ...base, select_cards: [b], unselect_cards: [a] }, context);
  assert.equal(context.asked.length, 2);
  assert.deepEqual(context.asked[1].chosen, [1]);
  assert.equal(again.index, 0); // marcou b: responde b
});

test('SELECT_SUM: obrigatórias entram travadas e ficam fora dos índices', async () => {
  const context = ctx([[0, 2]]);
  const prompt = { type: M.SELECT_SUM, select_max: 0, amount: 6, min: 0, max: 0, selects_must: [{ ...card(9, 0), amount: 3 }], selects: [{ ...card(1, 1), amount: 4 }, { ...card(2, 2), amount: 3 }] };
  const response = await answerCommon(prompt, context);
  assert.deepEqual(response.indicies, [1]);
  const { items, valid, chosen } = context.asked[0];
  assert.ok(items[0].locked);
  assert.deepEqual(chosen, [0]);
  assert.ok(valid([0, 2]) && !valid([0, 1]));
});

test('SORT_CHAIN/SORT_CARD: ordem tocada vira a posição de cada carta; "Ordem padrão" responde null', async () => {
  const cards = [card(1, 0), card(2, 1), card(3, 2)];
  const context = ctx([[2, 0, 1], null]);
  // Tocou 3ª, 1ª, 2ª: a carta 0 fica na posição 1, a 1 na 2 e a 2 na 0.
  assert.deepEqual(await answerCommon({ type: M.SORT_CHAIN, player: 0, cards }, context), { type: R.SORT_CARD, order: [1, 2, 0] });
  assert.equal(context.asked[0].min, 3);
  assert.equal(context.asked[0].cancel, 'Ordem padrão');
  assert.deepEqual(await answerCommon({ type: M.SORT_CARD, player: 0, cards }, context), { type: R.SORT_CARD, order: null });
  assert.deepEqual(await answerCommon({ type: M.SORT_CARD, player: 0, cards: [card(1, 0)] }, context), { type: R.SORT_CARD, order: null }); // 1 carta: nada a ordenar
  assert.equal(context.asked.length, 2);
});
