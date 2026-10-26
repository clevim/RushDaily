import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import createCore, { OcgMessageType as M, OcgResponseType as R } from '../src/vendor/ocgcore/index.js';
import { RUSH_ZONES, createDuel } from '../src/engine/ocg.mjs';
import { DAILY_FORMAT, DIFFICULTY_IDS, PLAYER_LP, generateDailyMatch, getDifficulty, listDifficulties, validateDailyDeck } from '../src/engine/daily-generator.mjs';
import { AI_LEVELS, decideRush } from '../src/engine/rush-ai.mjs';
import { HEART_CARD, HEART_CODE, withHeart } from '../src/engine/heart.mjs';

// Desafio diário no Rush do EDOPro. Exige os dados do Rush (npm run setup -- --so rush-ocg).
const root = new URL('../', import.meta.url);
const source = new URL('src/data/rush/cards.json', root);
if (!existsSync(source)) throw new Error('faltam os dados do Rush: rode npm run setup -- --so rush-ocg');
const pool = JSON.parse(readFileSync(source));
const cards = new Map(pool.map((card) => [card.id, card]));
const readScript = (name) => { try { return readFileSync(new URL(`src/vendor/card-scripts/${name}`, root), 'utf-8'); } catch { return null; } };
const lib = await createCore({ sync: true });

test('dificuldades: ids, PV do rival crescente e níveis de IA conhecidos', () => {
  assert.deepEqual(DIFFICULTY_IDS, ['apprentice', 'duelist', 'elite', 'chaos']);
  const list = listDifficulties();
  assert.deepEqual(list.map((item) => item.rating), [1, 2, 3, 4]);
  for (let i = 1; i < list.length; i += 1) assert.ok(list[i].enemyLp >= list[i - 1].enemyLp);
  for (const item of list) assert.ok(AI_LEVELS.includes(item.ai), item.ai);
  assert.equal(getDifficulty('lixo').id, 'duelist');
});

test('o desafio é o mesmo para todos no dia, legal e com confronto de Tipos diferentes', () => {
  const dates = ['2026-10-22', '2026-10-23', '2026-11-01', '2027-02-14'];
  for (const date of dates) {
    const byDifficulty = listDifficulties().map((difficulty) => generateDailyMatch({ date, difficulty: difficulty.id, pool }));
    const [first] = byDifficulty;
    assert.notEqual(first.player.theme.race, first.enemy.theme.race, `${date}: confronto com o mesmo Tipo`);
    assert.ok(first.player.label && first.enemy.label);
    for (const match of byDifficulty) {
      // Seu deck e o Tipo do rival não mudam com a dificuldade; o deck do rival sim (do mais fraco ao mais forte).
      assert.deepEqual(match.player.deck, first.player.deck);
      assert.equal(match.enemy.theme.race, first.enemy.theme.race);
      assert.equal(match.player.lp, PLAYER_LP);
      assert.equal(match.enemy.lp, match.difficulty.enemyLp);
      for (const deck of [match.player.deck, match.enemy.deck]) {
        assert.equal(deck.main.length, DAILY_FORMAT.main);
        assert.deepEqual(validateDailyDeck(deck, cards), []);
      }
      assert.deepEqual(generateDailyMatch({ date, difficulty: match.difficulty.id, pool }), match, 'determinístico');
    }
    const powers = byDifficulty.map((match) => match.enemy.power);
    assert.deepEqual([...powers].sort((a, b) => a - b), powers, `${date}: rival não fica mais forte com a dificuldade`);
  }
  const days = new Set(Array.from({ length: 20 }, (_, d) => generateDailyMatch({ date: `2026-03-${String(d + 1).padStart(2, '0')}`, pool }).player.label));
  assert.ok(days.size >= 6, `só ${days.size} Tipos em 20 dias`);
});

/** Joga um desafio inteiro com a IA do Rush nos dois lados. heart: põe o Coração das Cartas no deck do jogador. */
function playDaily(date, difficulty, { heart = false } = {}) {
  const match = generateDailyMatch({ date, difficulty, pool });
  const table = heart ? new Map([...cards, [HEART_CODE, HEART_CARD]]) : cards;
  const errors = [];
  const duel = createDuel(lib, { seed: match.seed, format: match.format, decks: [match.player.deck, match.enemy.deck], lp: [match.player.lp, match.enemy.lp], hands: match.enemy.hand ? [match.format.hand, match.enemy.hand] : null,
    skills: heart ? [{ team: 0, code: HEART_CODE }] : [], cards: table, readScript: withHeart(readScript), onError: (text) => errors.push(text) });
  assert.deepEqual(duel.state.lp, [match.player.lp, match.enemy.lp]);
  const memory = [{}, {}];
  const levels = ['elite', match.enemy.ai];
  let result;
  let heartUsed = false;
  let handBefore = 0;
  for (let step = 0; step < 6000; step += 1) {
    result = duel.next();
    if (result.winner !== null) break;
    assert.ok(!result.retry, `resposta recusada (pergunta ${result.prompt.type})`);
    const view = duel.snapshot();
    for (const side of view) side.monsters.forEach((card, seq) => card && assert.ok(RUSH_ZONES.monsters.includes(seq), `monstro na zona ${seq}`));
    const { prompt } = result;
    const player = prompt.player ?? duel.state.active;
    // Coração: ativa no primeiro turno em que aparecer e confere que a carta escolhida foi para a mão.
    const skill = prompt.type === M.SELECT_IDLECMD && player === 0 ? prompt.activates.findIndex((loc) => loc.code === HEART_CODE) : -1;
    if (skill >= 0) {
      assert.ok(heart, 'Coração apareceu sem ser pedido');
      assert.ok(!heartUsed, 'Coração ativado duas vezes');
      heartUsed = true;
      handBefore = view[0].hand.filter(Boolean).length;
      duel.respond({ type: R.SELECT_IDLECMD, action: 5, index: skill });
      const pick = duel.next();
      assert.equal(pick.prompt.type, M.SELECT_CARD, 'o Coração pede a carta do Deck');
      assert.ok(pick.prompt.selects.every((loc) => loc.location === 0x01 && loc.controller === 0), 'só cartas do seu Deck');
      duel.respond({ type: R.SELECT_CARD, indicies: [0] });
      const after = duel.next();
      assert.equal(duel.snapshot()[0].hand.filter(Boolean).length, handBefore + 1);
      result = after;
      if (result.winner !== null) break;
      const again = result.prompt;
      duel.respond(decideRush(again, { view: duel.snapshot(), me: again.player ?? duel.state.active, cards: table, state: duel.state, memory: memory[again.player ?? duel.state.active], level: levels[again.player ?? duel.state.active] }));
      continue;
    }
    const response = decideRush(prompt, { view, me: player, cards: table, state: duel.state, memory: memory[player], level: levels[player] });
    assert.ok(response, `sem resposta para ${prompt.type}`);
    duel.respond(response);
  }
  duel.destroy();
  assert.notEqual(result.winner, null, `${date}/${difficulty}: o duelo não terminou`);
  assert.ok(duel.state.turn <= DAILY_FORMAT.turnLimit + 1);
  assert.deepEqual(errors, []);
  return { turns: duel.state.turn, winner: result.winner, heartUsed };
}

test('um desafio diário inteiro (IA x IA) termina sem erro em cada dificuldade', () => {
  const turns = [];
  for (const difficulty of DIFFICULTY_IDS) turns.push(playDaily('2026-10-24', difficulty).turns);
  assert.ok(turns.every((n) => n >= 2), JSON.stringify(turns));
  assert.equal(generateDailyMatch({ date: "2026-10-24", difficulty: "chaos", pool }).enemy.hand, DAILY_FORMAT.hand + 1);
});

test('Coração das Cartas: Skill nativa, uma vez por duelo, busca 1 carta do Deck', () => {
  const { heartUsed } = playDaily('2026-10-25', 'duelist', { heart: true });
  assert.ok(heartUsed, 'o Coração não apareceu na Fase Principal');
});

test('a IA do Rush ganha da IA gulosa do clássico com os mesmos decks', () => {
  let wins = 0;
  const total = 12;
  for (let n = 0; n < total; n += 1) {
    const match = generateDailyMatch({ date: `2026-05-${String(n + 1).padStart(2, '0')}`, pool });
    const seat = n % 2;
    const duel = createDuel(lib, { seed: `ia:${n}`, format: DAILY_FORMAT, decks: [match.player.deck, match.enemy.deck], cards, readScript });
    const memory = [{}, {}];
    let result;
    for (let step = 0; step < 6000; step += 1) {
      result = duel.next();
      if (result.winner !== null) break;
      const player = result.prompt.player ?? duel.state.active;
      duel.respond(decideRush(result.prompt, { view: duel.snapshot(), me: player, cards, state: duel.state, memory: memory[player], level: player === seat ? 'elite' : 'aprendiz' }));
    }
    duel.destroy();
    if (result.winner === seat) wins += 1;
  }
  assert.ok(wins > total / 2, `IA do Rush venceu só ${wins} de ${total}`);
});
