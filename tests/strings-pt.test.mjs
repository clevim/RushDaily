import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { SYSTEM, describe, placeName } from '../src/data/classic/strings-pt.mjs';
import { DIFFICULTY_IDS, generateDailyMatch } from '../src/engine/daily-generator.mjs';

// Perguntas do motor em PT: rótulos das cartas (traduzidos no build por tools/rush/traducao.py) e mensagens de sistema.
// Exige os dados do setup (rush-ocg e classico).
const root = new URL('../', import.meta.url);
const rushPath = new URL('src/data/rush/cards.json', root);
const classicPath = new URL('src/data/classic/s1.json', root);
if (!existsSync(rushPath) || !existsSync(classicPath)) throw new Error('faltam os dados: rode npm run setup -- --so rush-ocg classico');
const rush = JSON.parse(readFileSync(rushPath));
const classic = JSON.parse(readFileSync(classicPath));

// Inglês detectável fora das aspas (nomes citados podem ficar no original).
const ENGLISH = /\b(?:your|the|Add|Destroy|Send|Special Summon|Draw|Graveyard|opponent|monsters?|cards?|from|Gain)\b/;
const english = (text) => ENGLISH.test(text.replace(/"[^"]*"/g, ''));

function englishStrings(cards) {
  return cards.flatMap((card) => (card.strings || []).filter((text) => text && english(text)).map((text) => `${card.id} ${card.nameEn}: ${text}`));
}

test('rótulos das cartas dos decks do diário (7 dias, todas as dificuldades; o pool inteiro vem no teste seguinte) sem inglês', () => {
  const byId = new Map(rush.map((card) => [card.id, card]));
  const ids = new Set();
  const day = new Date('2026-11-01T12:00:00Z');
  for (let i = 0; i < 7; i += 1) {
    const date = new Date(day.getTime() + i * 86400000).toISOString().slice(0, 10);
    for (const difficulty of DIFFICULTY_IDS) {
      const match = generateDailyMatch({ date, difficulty, pool: rush });
      for (const side of [match.player, match.enemy]) for (const id of [...side.deck.main, ...side.deck.extra]) ids.add(id);
    }
  }
  const cards = [...ids].map((id) => byId.get(id));
  assert.ok(cards.some((card) => card.strings?.length), 'algum deck com perguntas');
  assert.deepEqual(englishStrings(cards), []);
});

test('rótulos de todo o pool Rush e da temporada clássica 1 sem inglês', () => {
  assert.deepEqual(englishStrings(rush), []);
  assert.deepEqual(englishStrings(classic), []);
});

test('describe nunca deixa placeholder vazio ("[]", "()", aspas vazias, %ls)', () => {
  const cards = new Map([[42, { name: 'Carta', strings: ['Destruir 1 monstro'] }]]);
  for (const key of Object.keys(SYSTEM)) {
    for (const args of [undefined, [], ['Flying Kamakiri #1'], ['Flying Kamakiri #1', placeName(0x10)], [3]]) {
      const text = describe(Number(key), cards, args);
      assert.doesNotMatch(text, /\[\s*\]|\(\s*\)|""|%ls|%d|\s{2}/, `${key} ${JSON.stringify(args)}: ${text}`);
    }
  }
  assert.equal(describe(221, cards, ['Flying Kamakiri #1', placeName(0x04)]), 'Ativar o efeito de gatilho de "Flying Kamakiri #1" (Zona de Monstros)?');
  assert.equal(describe(221, cards, []), 'Ativar o efeito de gatilho desta carta?');
  assert.equal(describe((42n << 20n) | 0n, cards, ['Carta']), 'Destruir 1 monstro');
  assert.equal(describe((42n << 20n) | 5n, cards), 'Efeito de "Carta"');
});

test('placeName: locais do motor em PT', () => {
  assert.deepEqual([placeName(0x01), placeName(0x02), placeName(0x10), placeName(0x40), placeName(0x08, 2), placeName(0x08, 5), placeName(0)],
    ['Deck', 'Mão', 'Cemitério', 'Deck Adicional', 'Zona de Magias e Armadilhas', 'Zona de Campo', '']);
});
