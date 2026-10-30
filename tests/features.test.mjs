import assert from 'node:assert/strict';
import test from 'node:test';

// localStorage mínimo para o common.js no Node.
const store = new Map();
globalThis.localStorage = { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
const { battleForecast, canRecover, heartCharges, monthPieces, puzzleFor, recoverKey } = await import('../src/ui/common.js');
const { decodeReplay, encodeReplay, resultGrid } = await import('../src/ui/share.js');

test('puzzle do dia: mesma data, mesmo puzzle; datas diferentes espalham', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `p${i}`);
  assert.equal(puzzleFor('2026-10-05', ids), puzzleFor('2026-10-05', [...ids]));
  const month = new Set(Array.from({ length: 31 }, (_, d) => puzzleFor(`2026-10-${String(d + 1).padStart(2, '0')}`, ids)));
  assert.ok(month.size >= 15, `só ${month.size} puzzles diferentes no mês`);
});

test('peças do Enigma contam dias recuperados e fecham o mês', () => {
  store.clear();
  const days = Array.from({ length: 30 }, (_, d) => `2026-09-${String(d + 1).padStart(2, '0')}`);
  const history = Object.fromEntries(days.map((day) => [day, 'win']));
  history['2026-09-14'] = 'loss';
  store.set('rushdaily-history', JSON.stringify({ K: history }));
  assert.equal(monthPieces('K', '2026-09').length, 29);
  assert.deepEqual(heartCharges('K'), []);
  store.set(recoverKey('K'), JSON.stringify({ '2026-09-14': 'x', 'lixo': 'y', '2026-09-99': 'z' }));
  assert.equal(monthPieces('K', '2026-09').length, 30);
  assert.deepEqual(heartCharges('K'), ['2026-09']);
  // Recuperar: só mês atual, antes de hoje, sem vitória.
  assert.equal(canRecover('K', '2026-09-14', '2026-09-20'), true);
  assert.equal(canRecover('K', '2026-09-13', '2026-09-20'), false, 'dia vencido');
  assert.equal(canRecover('K', '2026-09-20', '2026-09-20'), false, 'hoje');
  assert.equal(canRecover('K', '2026-08-14', '2026-09-20'), false, 'outro mês');
  assert.equal(canRecover('K', '2026-09-00', '2026-09-20'), false);
});

test('link de replay vai e volta; lixo e respostas estranhas viram null', async () => {
  const replay = { v: 1, kind: 'duel', seed: '2026-10-23:vs-x:y:0', me: 1, label: 'ABC123', date: '2026-10-23', decks: [{ main: [1, 2, 3], extra: [4] }, { main: [5], extra: [] }],
    responses: Array.from({ length: 3000 }, (_, i) => ({ type: 6, action: i % 8, index: i % 3 ? null : 2 })).concat([{ type: 18, races: [1n << 40n] }, { type: 14, places: [{ player: 0, location: 4, sequence: 2 }] }]) };
  const code = await encodeReplay(replay);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  assert.ok(code.length < 4000, `link longo: ${code.length}`);
  assert.deepEqual(await decodeReplay(code), replay);
  for (const junk of ['', '!!!', 'abc', 'x'.repeat(500000)]) assert.equal(await decodeReplay(junk), null);
  assert.equal(await decodeReplay(await encodeReplay({ ...replay, responses: [{ type: 1, evil: '<img>' }] })), null);
  assert.equal(await decodeReplay(await encodeReplay({ ...replay, decks: [{ main: ['1'] }, { main: [] }] })), null);
  assert.equal(await decodeReplay(await encodeReplay({ ...replay, kind: 'puzzle', puzzle: '../x' })), null);
});

test('resumo do Rush: barras de PV e maior golpe, sem cartas', () => {
  const text = resultGrid({ date: '2026-10-23', difficulty: 'Duelista', rating: 2, outcome: 'win', turns: 6, start: [5000, 4000], vs: 'Dragão 🆚 Guerreiro',
    lpByTurn: [null, [5000, 4000], [4200, 4000], [4200, 2000], undefined, [3000, 1000], [3000, 0]], url: 'http://x/' });
  assert.equal(text, [
    'RushDaily 23/10 · Duelista ★★☆☆', 'Dragão 🆚 Guerreiro', '🏆 Vitória em 6 turnos',
    'Você ❤️❤️❤️🖤🖤 3.000 PV', 'Rival 🖤🖤🖤🖤🖤 0 PV', '💥 Maior golpe: 2.000 de dano', '', 'Consegue melhor? http://x/',
  ].join('\n'));
});

test('previsão do combate no alvo: vence, perde, empate, defesa, virado e direto', () => {
  const atk = (attack) => ({ hidden: false, defense: false, attack, def: 0 });
  const def = (value) => ({ hidden: false, defense: true, attack: 0, def: value });
  assert.deepEqual(battleForecast(1900, atk(1500)), { text: 'Vence\n−400', tone: 'win' });
  assert.deepEqual(battleForecast(200, atk(2100)), { text: 'Perde\n−1.900', tone: 'lose' });
  assert.equal(battleForecast(1500, atk(1500)).text, 'Empate');
  assert.deepEqual(battleForecast(1600, def(1200)), { text: 'Vence', tone: 'win' });
  assert.deepEqual(battleForecast(1000, def(1200)), { text: 'Não passa\n−200', tone: 'lose' });
  assert.equal(battleForecast(1000, { hidden: true }).text, '?');
  assert.deepEqual(battleForecast(1900, null), { text: 'Direto\n−1.900', tone: 'win' });
});
