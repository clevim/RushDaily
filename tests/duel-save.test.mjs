import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GEN_VERSION, generateDailyMatch } from '../src/engine/daily-generator.mjs';
import { canContinue, recordAttempt, resumable } from '../src/ui/duel-save.js';
import { resultGrid } from '../src/ui/share.js';
import { mergeProgress } from '../src/ui/sync-merge.js';

const play = { v: 2, gen: GEN_VERSION, seed: 's', heart: false, responses: [{ type: 1 }] };

test('save do duelo: só retoma com a mesma versão do gerador', () => {
  assert.equal(GEN_VERSION, 3);
  assert.deepEqual(resumable(play), { saved: play, stale: false });
  // save antigo sem "gen" ou de outra versão: descarta e avisa (havia partida em andamento)
  for (const raw of [{ ...play, gen: undefined }, { ...play, gen: 2 }, { ...play, v: 1 }]) assert.deepEqual(resumable(raw), { saved: null, stale: true });
  assert.deepEqual(resumable({ ...play, gen: 2, done: true }), { saved: null, stale: false }); // terminada: some sem aviso
  assert.deepEqual(resumable(null), { saved: null, stale: false });
  assert.deepEqual(resumable({ ...play, gen: 2, responses: [] }), { saved: null, stale: false });
});

test('partida terminada não oferece "Continuar"', () => {
  assert.equal(canContinue(play), true);
  assert.equal(canContinue({ ...play, done: true, winner: 0, turns: 5 }), false);
  assert.equal(canContinue({ ...play, responses: [] }), false);
  assert.equal(canContinue({ ...play, gen: undefined }), false);
  assert.equal(canContinue(null), false);
});

test('tentativas do dia e turno da 1ª vitória', () => {
  let attempts = recordAttempt({}, '2026-11-05~duelist', false, 4);
  attempts = recordAttempt(attempts, '2026-11-05~duelist', true, 7);
  attempts = recordAttempt(attempts, '2026-11-05~duelist', true, 3); // vitória depois da 1ª não muda o turno
  assert.deepEqual(attempts['2026-11-05~duelist'], { tries: 3, winTurn: 7 });
  const grid = resultGrid({ date: '2026-11-05', difficulty: 'Duelista', rating: 2, outcome: 'win', turns: 3, start: [5000, 4000], tries: 3, winTurn: 7 });
  assert.match(grid, /🔁 3ª tentativa do dia · 1ª vitória no turno 7/);
  assert.doesNotMatch(resultGrid({ date: '2026-11-05', difficulty: 'Duelista', rating: 2, outcome: 'loss', turns: 3, start: [5000, 4000] }), /tentativa/);
  // o histórico sincronizado segue com strings: a junção antiga não perde nada
  assert.deepEqual(mergeProgress({ history: { '2026-11-05': 'win' } }, { history: { '2026-11-05': 'loss' } }).history, { '2026-11-05': 'win' });
});

test('versão do desafio do dia = GEN_VERSION', () => {
  const pool = JSON.parse(readFileSync(new URL('../src/data/rush/cards.json', import.meta.url)));
  assert.equal(generateDailyMatch({ date: '2026-11-05', pool }).version, GEN_VERSION);
});
