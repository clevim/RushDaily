import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { openBooster } from '../src/engine/booster.mjs';
import { isExtra } from '../src/engine/ocg.mjs';

const cards = JSON.parse(readFileSync(new URL('../src/data/classic/s1.json', import.meta.url)));
const byId = new Map(cards.map((card) => [card.id, card]));
const N = 200;
const RATING = { apprentice: 1, duelist: 2, elite: 3, chaos: 4 };
const TIERS = ['common', 'silver', 'gold', 'galaxy'];
const FLOOR = { apprentice: 'common', duelist: 'silver', elite: 'gold', chaos: 'gold' };
const open = (i, opts = {}) => openBooster(`seed-${i}`, { cards, ...opts });
const each = (fn, opts) => { for (let i = 0; i < N; i++) fn(open(i, opts), i); };

test('determinismo: mesmos parâmetros, mesmo pacote', () => {
  const owned = { [cards[0].id]: 2, [cards[5].id]: 3 };
  for (let i = 0; i < 50; i++) {
    const opts = { owned, pity: i % 30, difficulty: 'elite' };
    assert.deepEqual(open(i, opts), open(i, opts));
  }
});

test('sempre 5 cartas distintas e existentes no pool', () => {
  for (const difficulty of Object.keys(RATING)) each((pack) => {
    assert.equal(pack.cards.length, 5);
    assert.equal(new Set(pack.cards.map((c) => c.id)).size, 5);
    for (const c of pack.cards) assert.ok(byId.has(c.id));
  }, { difficulty });
});

test('slots comuns nunca são monstros do Deck Adicional', () => {
  each((pack) => { for (const c of pack.cards) if (!c.rare) assert.ok(!isExtra(byId.get(c.id))); });
});

test('tema: no máximo 3 cartas do arquétipo por pacote', () => {
  let packs = 0;
  for (let i = 0; i < 1000 && packs < N; i++) {
    const pack = open(i);
    if (!pack.theme) continue;
    packs++;
    assert.ok(pack.cards.filter((c) => byId.get(c.id).archetype === pack.theme).length <= 3);
  }
  assert.ok(packs > 50);
});

test('piso por dificuldade', () => {
  for (const difficulty of Object.keys(RATING)) each((pack) => {
    assert.ok(TIERS.indexOf(pack.tier) >= TIERS.indexOf(FLOOR[difficulty]), `${difficulty} ${pack.tier}`);
  }, { difficulty });
});

test('luck: 0 acima do piso, rating no piso; pity >= 8*rating sobe um nível', () => {
  for (const [difficulty, rating] of Object.entries(RATING)) {
    const floor = TIERS.indexOf(FLOOR[difficulty]);
    each((pack) => assert.equal(pack.luck, TIERS.indexOf(pack.tier) > floor ? 0 : rating), { difficulty, pity: 3 });
    each((pack) => {
      assert.ok(TIERS.indexOf(pack.tier) > floor);
      assert.equal(pack.luck, 0);
    }, { difficulty, pity: 8 * rating });
  }
  const min = { apprentice: 'silver', duelist: 'gold', elite: 'galaxy', chaos: 'galaxy' };
  for (const d of Object.keys(RATING)) each((pack) => assert.ok(TIERS.indexOf(pack.tier) >= TIERS.indexOf(min[d])), { difficulty: d, pity: 8 * RATING[d] });
});

test('sorte aumenta a chance de galáxia no Caos', () => {
  const count = (pity) => { let n = 0; each((pack) => { if (pack.tier === 'galaxy') n++; }, { difficulty: 'chaos', pity }); return n; };
  assert.ok(count(28) > count(0));
});

test('frequência de raridade por dificuldade bate com a tabela e cresce com a dificuldade', () => {
  const base = [0.7, 0.2, 0.08, 0.02]; // TIER_ODDS: comum, prata, ouro, galáxia (sem sorte acumulada)
  const total = 2000;
  // [galáxia, ouro] extra por rating (espelha GALAXY_EXTRA / GOLD_EXTRA de booster.mjs).
  const EXTRA = { 1: [0, 0], 2: [0.02, 0.09], 3: [0.03, 0], 4: [0.06, 0] };
  const prob = (rating, floor) => {
    const [g, b] = EXTRA[rating];
    const [c, s, o, gal] = base;
    const p = [(1 - g - b) * c, (1 - g - b) * s, (1 - g) * o + b * (c + s), g + (1 - g) * gal];
    for (let i = 0; i < floor; i++) { p[floor] += p[i]; p[i] = 0; }
    return p;
  };
  let prevBetter = -1;
  for (const [difficulty, rating] of Object.entries(RATING)) {
    const freq = [0, 0, 0, 0];
    for (let i = 0; i < total; i++) freq[TIERS.indexOf(openBooster(`booster:2026-10-${1 + (i % 28)}~${difficulty}:p${i}`, { cards, difficulty }).tier)]++;
    const want = prob(rating, TIERS.indexOf(FLOOR[difficulty]));
    assert.ok(Math.abs(want.reduce((a, b) => a + b) - 1) < 1e-9);
    want.forEach((p, i) => assert.ok(Math.abs(freq[i] / total - p) < 0.04, `${difficulty} ${TIERS[i]}: ${freq[i] / total} vs ${p}`));
    const better = (freq[2] + freq[3]) / total; // ouro ou melhor: não pode cair ao subir de dificuldade
    assert.ok(better + 0.04 >= prevBetter, `${difficulty} ouro+ ${better} < ${prevBetter}`);
    prevBetter = better;
  }
});
