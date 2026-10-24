import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cardData, descriptionZoom } from '../src/ui/classic-card-data.js';

const root = new URL('../', import.meta.url);
const pool = JSON.parse(readFileSync(new URL('src/data/classic/s1.json', root)));
const tokens = JSON.parse(readFileSync(new URL('src/data/classic/tokens.json', root)));
const byId = (id) => pool.find((card) => card.id === id);

test('texto longo encolhe a fonte; texto curto fica em 1', () => {
  for (const id of [69831560, 5861892, 44330098, 86346643, 34487429, 72989439]) assert.ok(descriptionZoom(byId(id)) < 1, `carta ${id}`);
  assert.equal(descriptionZoom({ type: 0x11, desc: 'Um monstro comum.' }), 1);
  // Quanto maior o texto, nunca maior a fonte.
  const zoom = (length) => descriptionZoom({ type: 0x21, desc: 'x'.repeat(length) });
  for (let length = 100; length < 1200; length += 50) assert.ok(zoom(length + 50) <= zoom(length), `${length}`);
  assert.equal(cardData(byId(72989439), '').descriptionZoom, descriptionZoom(byId(72989439)));
});

test('monstro Normal mostra /Normal na linha de tipo, ficha não', () => {
  const normal = pool.find((card) => card.type & 1 && card.type & 0x10 && !(card.type & 0x20));
  assert.match(cardData(normal, '').monsterType, /\/Normal$/);
  assert.doesNotMatch(cardData(tokens[0], '').monsterType, /Normal/);
});

test('fichas têm nome e texto em PT; erros de texto conhecidos foram corrigidos', () => {
  assert.ok(tokens.every((token) => token.name && token.desc), 'ficha sem nome/texto');
  assert.ok(tokens.every((token) => !/ Token$/.test(token.name)));
  assert.equal(byId(72446038).name, 'Magia de Síntese');
  assert.doesNotMatch(byId(20858318).name, /õão/);
});
