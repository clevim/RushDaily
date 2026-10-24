import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import createCore from '../src/vendor/ocgcore/index.js';
import { runPuzzle } from '../tools/classic/puzzle-check.mjs';

// Todo puzzle que vai para o jogo carrega com os scripts publicados, chega à vez do jogador e tem uma vitória conhecida.
const root = new URL('../', import.meta.url);
const puzzles = JSON.parse(readFileSync(new URL('src/data/classic/puzzles.json', root)));
const solutions = JSON.parse(readFileSync(new URL('tools/classic/puzzle-solutions.json', root)), (key, value) => (typeof value === 'string' && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value));
const tokens = JSON.parse(readFileSync(new URL('src/data/classic/tokens.json', root)));
const scripts = new Map();
const readScript = (name) => {
  if (!scripts.has(name)) { try { scripts.set(name, readFileSync(new URL(`src/vendor/card-scripts/${name}`, root), 'utf-8')); } catch { scripts.set(name, null); } }
  return scripts.get(name);
};
const lib = await createCore({ sync: true });

test('puzzles: ids únicos, objetivo e cartas com dados', () => {
  assert.ok(puzzles.length >= 20, `só ${puzzles.length} puzzles`);
  assert.equal(new Set(puzzles.map((p) => p.id)).size, puzzles.length);
  for (const puzzle of puzzles) {
    assert.match(puzzle.id, /^[a-z0-9-]{1,64}$/);
    assert.ok(puzzle.title && puzzle.goal && /BeginPuzzle|PuzzleOp/.test(puzzle.script), puzzle.id);
    assert.ok(puzzle.cards.every((card) => card.name && Number.isInteger(card.type)), puzzle.id);
  }
});

for (const puzzle of puzzles) {
  test(`puzzle ${puzzle.id}: carrega e a solução vence no turno`, () => {
    const env = { cards: new Map([...tokens, ...puzzle.cards].map((card) => [card.id, card])), readScript };
    const errors = [];
    const first = runPuzzle(lib, puzzle, env, [], errors);
    assert.ok(first.prompt, 'não chegou à vez do jogador');
    assert.equal(first.state.turn, 1);
    assert.equal(runPuzzle(lib, puzzle, env, solutions[puzzle.id], errors).winner, 0);
    assert.deepEqual(errors, []);
  });
}
