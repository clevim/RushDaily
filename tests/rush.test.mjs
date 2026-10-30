import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import createCore, { OcgDuelMode, OcgMessageType as M, OcgResponseType as R } from '../src/vendor/ocgcore/index.js';
import { FORMATS, RUSH_ZONES, createDuel, isExtra } from '../src/engine/ocg.mjs';
import { decide } from '../src/engine/ocg-ai.mjs';
import { buildRushDeck, meetsRequirements, validateRushDeck } from '../src/engine/rush-deck.mjs';
import { chainSkipper } from '../src/ui/ocg-ask.js';

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
  assert.equal(format.flags, OcgDuelMode.MODE_RUSH | 0x800000000n, 'DUEL_MODE_RUSH do constant.lua: Rituais no Adicional');
  const ritual = pool.find((card) => card.type & 0x1 && card.type & 0x80);
  assert.ok(isExtra(ritual, format) && !isExtra(ritual, FORMATS.classico) && !isExtra(ritual), 'Ritual no Adicional só no Rush');
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
  const main = pool.filter((card) => !isExtra(card, FORMATS.rush)).map((card) => card.id);
  const extra = pool.filter((card) => isExtra(card, FORMATS.rush)).map((card) => card.id);
  const errors = [];
  for (let i = 0, j = 0; i < main.length || j < extra.length; i += 40, j += 15) {
    const deck = { main: main.slice(i, i + 40), extra: extra.slice(j, j + 15) };
    const duel = createDuel(lib, { seed: `carga:${i}`, format: FORMATS.rush, decks: [deck, deck], cards, readScript, onError: (text) => errors.push(text) });
    duel.next();
    duel.destroy();
  }
  assert.deepEqual(errors, []);
});

// Pacote de Máximo: cada trio no deck tem as três peças (L, C e R). Devolve os centros com peça faltando.
const brokenTrios = (main) => {
  const pieces = new Map(); // centro -> peças presentes
  for (const card of main.map((id) => cards.get(id)).filter((c) => c.maximum)) {
    const center = card.id + { L: 1, C: 0, R: -1 }[card.maximum];
    pieces.set(center, (pieces.get(center) || new Set()).add(card.maximum));
  }
  return [...pieces].filter(([, set]) => set.size < 3).map(([center]) => center);
};

test('deck gerado é legal, coerente e determinístico', () => {
  // seed 57: o conserto trocava o centro do trio "Max Mutton" (requisito sem apoio) e deixava L e R sozinhos.
  assert.deepEqual(brokenTrios(buildRushDeck({ seed: 't:57', pool }).main), []);
  for (let i = 0; i < 25; i += 1) {
    const deck = buildRushDeck({ seed: `teste:${i}`, pool });
    assert.deepEqual(validateRushDeck(deck, cards), [], `seed ${i}`);
    assert.equal(deck.main.length, 40);
    // Tema: boa parte dos monstros é do Tipo sorteado.
    const monsters = deck.main.map((id) => cards.get(id)).filter((card) => card.type & 0x1);
    assert.ok(monsters.filter((card) => card.race === deck.theme.race).length >= monsters.length / 3, `seed ${i}: tema fraco`);
    assert.ok(deck.main.filter((id) => !(cards.get(id).type & 0x1)).length >= 12, `seed ${i}: poucas Magias/Armadilhas`);
    // Toda carta só com requisitos (Tipo/Atributo/Nível/nome/Fusão/Máximo) atendidos pelo deck; Fusão só com as matérias no deck.
    const mainCards = deck.main.map((id) => cards.get(id));
    const extraCards = deck.extra.map((id) => cards.get(id));
    for (const card of mainCards) assert.ok(meetsRequirements(card, mainCards, extraCards), `seed ${i}: ${card.name} sem requisito no deck`);
    const names = new Set(mainCards.flatMap((card) => [card.name, card.nameEn]));
    for (const id of deck.extra) {
      if (cards.get(id).type & 0x80) continue; // Ritual: conferido no teste do pacote de Ritual
      const mats = [...cards.get(id).desc.split('\n')[0].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      assert.ok(mats.length && mats.every((name) => names.has(name)), `seed ${i}: ${cards.get(id).name} sem matérias no deck`);
    }
    assert.deepEqual(brokenTrios(deck.main), [], `seed ${i}: trio de Máximo incompleto`);
  }
  assert.deepEqual(buildRushDeck({ seed: 'igual', pool }), buildRushDeck({ seed: 'igual', pool }));
  assert.notDeepEqual(buildRushDeck({ seed: 'a', pool }).main, buildRushDeck({ seed: 'b', pool }).main);
});

test('pacote de Ritual: Magia no deck e o Monstro de Ritual que ela invoca no adicional, sem carta inútil', () => {
  let packs = 0;
  for (let i = 0; i < 60; i += 1) {
    const deck = buildRushDeck({ seed: `ritual:${i}`, pool });
    const mainCards = deck.main.map((id) => cards.get(id));
    const extraCards = deck.extra.map((id) => cards.get(id));
    const spells = mainCards.filter((card) => card.type & 0x2 && card.type & 0x80);
    const monsters = extraCards.filter((card) => card.type & 0x80);
    assert.equal(Boolean(spells.length), Boolean(monsters.length), `seed ${i}: Ritual sem a Magia (ou o contrário)`);
    for (const monster of monsters) assert.ok(spells.some((spell) => spell.desc.includes(`"${monster.name}"`)), `seed ${i}: ${monster.name} sem Magia que o invoque`);
    assert.ok(mainCards.every((card) => meetsRequirements(card, mainCards, extraCards)), `seed ${i}: carta inútil`);
    assert.deepEqual(brokenTrios(deck.main), [], `seed ${i}: trio de Máximo incompleto`);
    assert.deepEqual(validateRushDeck(deck, cards), [], `seed ${i}`);
    if (spells.length) packs += 1;
  }
  assert.ok(packs >= 10, `só ${packs} de 60 decks com Ritual`);
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

test('"Não responder mais" dispensa só as cartas já oferecidas na fase: a Armadilha de ataque ainda é perguntada', () => {
  // Turno 1: baixa "Siesta Hold" (Invocação Normal do rival) e "Counter Cannonball" (declaração de ataque).
  // Turno 2: o rival invoca (oferece Siesta Hold; o jogador dispensa) e ataca (Counter Cannonball tem de ser perguntada).
  // Antes o dispensar valia para o turno inteiro e a Armadilha de ataque passava sem pergunta.
  const [siesta, cannonball] = [160002047, 160001046];
  const normals = pool.filter((card) => card.type === 0x11 && (card.level & 0xff) <= 4 && !card.legend).map((card) => card.id);
  const decks = [{ main: [...normals.slice(0, 37), siesta, cannonball, normals[37]] }, { main: normals.slice(40, 80) }];
  const duel = createDuel(lib, { seed: 'corrente', format: FORMATS.rush, decks, shuffle: false, cards, readScript });
  const skip = chainSkipper();
  const offered = []; // [código, perguntado?]
  for (let step = 0; step < 400 && duel.state.turn <= 2; step += 1) {
    const { prompt, winner } = duel.next();
    if (winner !== null) break;
    const player = prompt.player ?? duel.state.active;
    let response;
    if (prompt.type === M.SELECT_IDLECMD && player === 0) {
      const set = prompt.spell_sets.findIndex((loc) => loc.code === siesta || loc.code === cannonball);
      response = set >= 0 ? { type: R.SELECT_IDLECMD, action: 4, index: set } : { type: R.SELECT_IDLECMD, action: 7, index: null };
    } else if (prompt.type === M.SELECT_CHAIN && player === 0 && prompt.selects.length) {
      for (const loc of prompt.selects) offered.push([loc.code, !skip.skips(prompt, duel.state)]);
      skip.remember(prompt, duel.state); // o jogador escolhe "Não responder mais"
      response = { type: R.SELECT_CHAIN, index: null };
    } else response = decide(prompt, { view: duel.snapshot(), me: player, cards, state: duel.state, memory: {} });
    duel.respond(response);
  }
  duel.destroy();
  assert.deepEqual(offered[0], [siesta, true]);
  assert.ok(offered.some(([code, asked]) => code === cannonball && asked), JSON.stringify(offered));
  // A mesma carta de novo na mesma fase (outro ataque) passa sem pergunta.
  const again = offered.filter(([code]) => code === cannonball);
  assert.ok(again.length < 2 || again.slice(1).every(([, asked]) => !asked), JSON.stringify(offered));
});

/** Joga o turno 1 do jogador 0 com o deck na ordem (shuffle: false; a mão são as 5 últimas cartas da lista).
 * pick(prompt) escolhe a resposta do SELECT_IDLECMD (null = encerra o turno); o resto fica com a IA. Devolve o campo do jogador 0. */
function playFirstTurn(seed, deck, pick) {
  const normals = pool.filter((card) => card.type === 0x11 && (card.level & 0xff) <= 4 && !card.legend).map((card) => card.id);
  const duel = createDuel(lib, { seed, format: FORMATS.rush, decks: [deck, { main: normals.slice(40, 80) }], shuffle: false, cards, readScript });
  let start = null;
  for (let step = 0; step < 100 && duel.state.turn <= 1; step += 1) {
    const { prompt, winner } = duel.next();
    if (winner !== null) break;
    const player = prompt.player ?? duel.state.active;
    start ??= duel.snapshot()[0];
    const response = prompt.type === M.SELECT_IDLECMD && player === 0 ? pick(prompt) || { type: R.SELECT_IDLECMD, action: 7, index: null }
      : decide(prompt, { view: duel.snapshot(), me: player, cards, state: duel.state, memory: {} });
    duel.respond(response);
  }
  const end = duel.snapshot()[0];
  duel.destroy();
  return { start, end };
}

test('Invocação-Máximo: com o trio na mão, o centro vai ao campo pelo motor', () => {
  const normals = pool.filter((card) => card.type === 0x11 && (card.level & 0xff) <= 4 && !card.legend).map((card) => card.id);
  const centers = pool.filter((card) => card.maximum === 'C' && cards.get(card.id - 1)?.maximum === 'L' && cards.get(card.id + 1)?.maximum === 'R');
  for (const center of [centers[0], centers.at(-1)]) {
    const trio = [center.id - 1, center.id, center.id + 1];
    // Só a Invocação-Máximo (special_summons, action 1): o efeito do centro manda ele ao Cemitério como custo.
    const { end } = playFirstTurn('maximo', { main: [...normals.slice(0, 37), ...trio] }, (prompt) => {
      const index = prompt.special_summons.findIndex((loc) => loc.code === center.id);
      return index >= 0 ? { type: R.SELECT_IDLECMD, action: 1, index } : null;
    });
    assert.ok(end.monsters.some((card) => card?.code === center.id), `${center.nameEn} não foi Invocado por Máximo`);
  }
});

test('Ritual no Deck Adicional (regra do Rush): a Magia de Ritual invoca de lá com matérias da mão', () => {
  // "Black Magic Ritual" (matérias da mão ou do campo, Nível 8 ou mais) invoca "Magician of Black Chaos" (Nível 8).
  const [magician, rite] = [160323001, 160323030];
  const fours = pool.filter((card) => card.type === 0x11 && (card.level & 0xff) === 4 && !card.legend).map((card) => card.id);
  let activated = false;
  const { start, end } = playFirstTurn('ritual', { main: [...fours.slice(0, 37), fours[37], rite, fours[38]], extra: [magician] }, (prompt) => {
    const index = prompt.activates.findIndex((loc) => loc.code === rite);
    if (index < 0 || activated) return null;
    activated = true;
    return { type: R.SELECT_IDLECMD, action: 5, index };
  });
  assert.ok(start.extra.some((card) => card?.code === magician) && !start.hand.some((card) => card?.code === magician), 'o Ritual começa no Adicional');
  assert.ok(end.monsters.some((card) => card?.code === magician), 'Invocação-Ritual falhou');
  assert.ok(end.grave.some((card) => card?.code === rite));
});

test('maximumTrios: detecta o trio face para cima e ignora peças soltas', async () => {
  const { maximumTrios } = await import('../src/ui/maximum.js');
  const center = pool.find((card) => card.maximum === 'C' && cards.get(card.id - 1)?.maximum === 'L' && cards.get(card.id + 1)?.maximum === 'R');
  const piece = (code, position = 1) => ({ code, position });
  const trio = [null, piece(center.id - 1), piece(center.id), piece(center.id + 1), null];
  assert.deepEqual([...maximumTrios(trio, (code) => cards.get(code))], [[1, 'L'], [2, 'C'], [3, 'R']]);
  assert.equal(maximumTrios([null, piece(center.id - 1), piece(center.id), null], (code) => cards.get(code)).size, 0, 'sem a peça R');
  assert.equal(maximumTrios([null, piece(center.id - 1), piece(center.id, 10), piece(center.id + 1)], (code) => cards.get(code)).size, 0, 'centro virado');
});
