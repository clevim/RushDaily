import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isExtra } from '../src/engine/ocg.mjs';
import { decodeDeck, encodeDeck, validDeck } from '../src/ui/classic-store.js';

// Contrato do PvP: link do desafio e regras do deck (o resto do classic-store depende do navegador).
const pool = JSON.parse(readFileSync(new URL('../src/data/classic/s1.json', import.meta.url)));
const cards = new Map(pool.map((card) => [card.id, card]));
const mains = pool.filter((card) => !isExtra(card)).slice(0, 20).map((card) => card.id);
const extras = pool.filter(isExtra).slice(0, 16).map((card) => card.id);
const main40 = [...mains, ...mains];

test('link do desafio vai e volta; lixo e ids não numéricos viram null', () => {
  const deck = { main: main40, extra: extras.slice(0, 15) };
  assert.deepEqual(decodeDeck(encodeDeck('ABC123', deck)), { key: 'ABC123', ...deck });
  for (const junk of [null, '', 'abc', '!!!', btoa('C1|ABC123|x.y|'), btoa('C1|abc|1.2|')]) assert.equal(decodeDeck(junk), null);
});

test('validDeck: limites do Principal, do Adicional, de cópias e de posse', () => {
  assert.ok(validDeck({ main: main40, extra: extras.slice(0, 15) }, cards).ok);
  assert.ok(!validDeck({ main: main40.slice(1) }, cards).ok); // 39
  assert.ok(!validDeck({ main: main40, extra: extras }, cards).ok); // 16 no Adicional
  assert.ok(validDeck({ main: [...main40, mains[0]] }, cards).ok); // 3 cópias, 41 cartas
  assert.ok(!validDeck({ main: [...main40, mains[0], mains[0]] }, cards).ok); // 4 cópias
  assert.ok(!validDeck({ main: [...main40.slice(1), extras[0]] }, cards).ok); // Extra no Principal
  assert.ok(!validDeck({ main: main40 }, cards, {}).ok); // não tem as cartas
});

test('segurança: fichas fora do deck e teto de tamanho no link', () => {
  const token = { id: 999999999, name: 'Ficha', type: 0x4000 | 0x1 };
  const withToken = new Map([...cards, [token.id, token]]);
  assert.ok(!validDeck({ main: [...main40.slice(1), token.id] }, withToken).ok); // ficha no Principal
  assert.ok(!validDeck({ main: main40, extra: [token.id] }, withToken).ok); // e no Adicional
  const enc = (main, extra = []) => encodeDeck('ABC123', { main, extra });
  assert.equal(decodeDeck(enc(Array(2000).fill(27551))), null); // 2.000 ids
  assert.equal(decodeDeck(enc([...main40, 0])), null); // id 0
  assert.equal(decodeDeck(enc([...main40, 2 ** 40])), null); // id gigante
  assert.equal(decodeDeck('A'.repeat(1_600_000)), null); // código de 1,6 MB
  assert.ok(decodeDeck(enc(main40, extras.slice(0, 15)))); // legítimo continua passando
});
