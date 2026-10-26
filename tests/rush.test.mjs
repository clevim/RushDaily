import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import createCore, { OcgDuelMode, OcgMessageType as M } from '../src/vendor/ocgcore/index.js';
import { FORMATS, RUSH_ZONES, createDuel, isExtra } from '../src/engine/ocg.mjs';
import { decide } from '../src/engine/ocg-ai.mjs';
import { buildRushDeck, meetsRequirements, validateRushDeck } from '../src/engine/rush-deck.mjs';

// Exige os dados do Rush (npm run setup -- --so rush-ocg); não depende dos dados do clássico.
const root = new URL('../', import.meta.url);
const source = new URL('src/data/rush/cards.json', root);
if (!existsSync(source)) throw new Error('faltam os dados do Rush: rode npm run setup -- --so rush-ocg');
const pool = JSON.parse(readFileSync(source));
const cards = new Map(pool.map((card) => [card.id, card]));
const readScript = (name) => { try { return readFileSync(new URL(`src/vendor/card-scripts/${name}`, root), 'utf-8'); } catch { return null; } };
const lib = await createCore({ sync: true });
const isNormal = (card) => card.type & 0x1 && card.type & 0x10;

test('formato Rush: regras oficiais e scripts da pasta rush/', () => {
  const format = FORMATS.rush;
  assert.equal(format.flags, OcgDuelMode.MODE_RUSH);
  assert.deepEqual([format.lp, format.hand, format.main, format.extra, format.scripts], [8000, 4, 40, 15, 'rush']);
  assert.equal(FORMATS.classico.scripts, undefined, 'o clássico continua lendo official/');
  assert.deepEqual(RUSH_ZONES, { monsters: [1, 2, 3], spells: [1, 2, 3], field: 5 });
});

test('cartas têm os campos do pool e os extras do Rush', () => {
  assert.ok(pool.length > 3000, `só ${pool.length} cartas`);
  for (const card of pool) {
    for (const key of ['id', 'alias', 'type', 'atk', 'def', 'level', 'race', 'attribute']) assert.equal(typeof card[key], 'number', `${card.id}.${key}`);
    for (const key of ['setcode', 'name', 'nameEn', 'desc']) assert.equal(typeof card[key], 'string', `${card.id}.${key}`);
    assert.equal(typeof card.pt, 'boolean');
    assert.ok(card.name && card.nameEn, `${card.id} sem nome`);
    assert.doesNotMatch(card.nameEn, /\(Rush\)$/);
    assert.ok(!(card.type & 0x4000), 'ficha no pool');
  }
  assert.ok(pool.filter((card) => card.legend).length >= 100, 'cartas Lenda');
  assert.ok(pool.find((card) => card.nameEn === 'Blue-Eyes White Dragon').legend);
  assert.deepEqual(new Set(pool.filter((card) => card.maximum).map((card) => card.maximum)), new Set(['L', 'C', 'R']));
  assert.ok(pool.filter((card) => card.pt).length >= 400, 'traduções do desafio diário');
  assert.ok(pool.some((card) => card.type & 0x40), 'Fusões');
});

test('toda carta com efeito tem script e todos carregam sem erro no motor', () => {
  const missing = pool.filter((card) => !isNormal(card) && !readScript(`rush/c${card.id}.lua`));
  assert.deepEqual(missing.map((card) => card.nameEn), []);
  for (const name of JSON.parse(readScript('rush/index.json'))) assert.ok(readScript(name), name);
  // Cria duelos com todas as cartas (40 no deck e 15 no adicional por duelo): o motor roda o initial_effect de cada uma.
  const main = pool.filter((card) => !isExtra(card)).map((card) => card.id);
  const extra = pool.filter(isExtra).map((card) => card.id);
  const errors = [];
  for (let i = 0, j = 0; i < main.length || j < extra.length; i += 40, j += 15) {
    const deck = { main: main.slice(i, i + 40), extra: extra.slice(j, j + 15) };
    const duel = createDuel(lib, { seed: `carga:${i}`, format: FORMATS.rush, decks: [deck, deck], cards, readScript, onError: (text) => errors.push(text) });
    duel.next();
    duel.destroy();
  }
  assert.deepEqual(errors, []);
});

test('deck gerado é legal, coerente e determinístico', () => {
  for (let i = 0; i < 25; i += 1) {
    const deck = buildRushDeck({ seed: `teste:${i}`, pool });
    assert.deepEqual(validateRushDeck(deck, cards), [], `seed ${i}`);
    assert.equal(deck.main.length, 40);
    // Tema: boa parte dos monstros é do Tipo sorteado.
    const monsters = deck.main.map((id) => cards.get(id)).filter((card) => card.type & 0x1);
    assert.ok(monsters.filter((card) => card.race === deck.theme.race).length >= monsters.length / 3, `seed ${i}: tema fraco`);
    assert.ok(deck.main.filter((id) => !(cards.get(id).type & 0x1)).length >= 12, `seed ${i}: poucas Magias/Armadilhas`);
    // Magia/Armadilha só com requisitos (Tipo/Atributo/nome/Nível) atendidos pelo deck; Fusão só com as matérias no deck.
    const mainCards = deck.main.map((id) => cards.get(id));
    for (const card of mainCards) assert.ok(meetsRequirements(card, mainCards), `seed ${i}: ${card.name} sem requisito no deck`);
    const names = new Set(mainCards.flatMap((card) => [card.name, card.nameEn]));
    for (const id of deck.extra) {
      const mats = [...cards.get(id).desc.split('\n')[0].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      assert.ok(mats.length && mats.every((name) => names.has(name)), `seed ${i}: ${cards.get(id).name} sem matérias no deck`);
    }
  }
  assert.deepEqual(buildRushDeck({ seed: 'igual', pool }), buildRushDeck({ seed: 'igual', pool }));
  assert.notDeepEqual(buildRushDeck({ seed: 'a', pool }).main, buildRushDeck({ seed: 'b', pool }).main);
});

test('validação aponta cópias demais, Lenda repetida e não Fusão no adicional', () => {
  const normal = pool.find((card) => isNormal(card) && !card.legend);
  const legends = pool.filter((card) => card.legend && card.type & 0x1 && !isExtra(card));
  const deck = { main: [...Array(4).fill(normal.id), legends[0].id, legends[1].id, ...Array(34).fill(pool.find((c) => c.type & 0x2 && !c.legend).id)], extra: [normal.id] };
  const problems = validateRushDeck(deck, cards).join(' | ');
  assert.match(problems, /4 cópias/);
  assert.match(problems, /Lenda/);
  assert.match(problems, /não é Fusão/);
});

test('o deck é embaralhado pela seed no Rush', () => {
  const main = pool.filter((card) => isNormal(card) && !card.legend).slice(0, 40).map((card) => card.id);
  const duel = createDuel(lib, { seed: 'embaralha', format: FORMATS.rush, decks: [{ main }, { main }], cards, readScript });
  duel.next();
  const hand = duel.snapshot()[0].hand.map((card) => card.code);
  assert.equal(hand.length, 5, 'mão inicial de 4 + compra do primeiro turno');
  assert.notDeepEqual(hand, main.slice(-5).reverse(), 'mão saiu na ordem da lista');
  duel.destroy();
});

test('a IA joga um duelo Rush inteiro até o fim, só nas zonas do campo de 3 colunas', () => {
  for (const seed of ['ia:1', 'ia:2']) {
    const decks = [0, 1].map((team) => buildRushDeck({ seed: `${seed}:${team}`, pool }));
    const errors = [];
    const duel = createDuel(lib, { seed, format: FORMATS.rush, decks, cards, readScript, onError: (text) => errors.push(text) });
    const memory = [{}, {}];
    let result;
    for (let step = 0; step < 5000; step += 1) {
      result = duel.next();
      if (result.winner !== null) break;
      assert.ok(!result.retry, `resposta recusada (pergunta ${result.prompt.type})`);
      const view = duel.snapshot();
      for (const side of view) {
        side.monsters.forEach((card, seq) => card && assert.ok(RUSH_ZONES.monsters.includes(seq), `monstro na zona ${seq}`));
        side.spells.forEach((card, seq) => card && assert.ok([...RUSH_ZONES.spells, RUSH_ZONES.field].includes(seq), `magia na zona ${seq}`));
      }
      const player = result.prompt.player ?? duel.state.active;
      const response = decide(result.prompt, { view, me: player, cards, state: duel.state, memory: memory[player] });
      assert.ok(response, `sem resposta para ${result.prompt.type}`);
      duel.respond(response);
    }
    assert.notEqual(result.winner, null, 'o duelo não terminou');
    assert.ok(duel.state.turn <= FORMATS.rush.turnLimit + 1);
    assert.deepEqual(errors, []);
    duel.destroy();
  }
  assert.equal(M.SELECT_IDLECMD, 11); // sanidade da enumeração usada pela IA
});
