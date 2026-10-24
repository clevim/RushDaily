import assert from 'node:assert/strict';
import { activateSpell, attack, chooseAiAction, createGame, endTurn, summon } from '../src/engine/game-engine.mjs';

const cards = [
  { id: 1, name: 'Fraco', type: 'monster', atk: 1000, def: 1000, level: 4 },
  { id: 2, name: 'Forte', type: 'monster', atk: 2000, def: 1500, level: 4 },
];
const deck = Array.from({ length: 8 }, (_, index) => cards[index % cards.length]);

const first = createGame({ seed: 'same-seed', playerDeck: deck, enemyDeck: deck });
const second = createGame({ seed: 'same-seed', playerDeck: deck, enemyDeck: deck });
assert.deepEqual(first.player.deck.map((card) => card.id), second.player.deck.map((card) => card.id));
assert.deepEqual(first.player.hand.map((card) => card.id), second.player.hand.map((card) => card.id));
assert.equal(first.player.hand.length, 4);

const playerCard = first.player.hand[0];
summon(first, 'player', playerCard.uid);
assert.equal(first.player.field.length, 1);
assert.throws(() => summon(first, 'enemy', first.enemy.hand[0].uid), /NOT_YOUR_TURN/);
const attacker = first.player.field[0];
assert.throws(() => attack(first, 'player', attacker.uid), /FIRST_TURN/);
endTurn(first, 'player');
assert.equal(first.active, 'enemy');
assert.equal(first.turn, 1);
chooseAiAction(first);
assert.ok(first.active === 'player' || first.gameOver);
if (!first.gameOver) assert.equal(first.turn, 2);
assert.ok(first.events.some((event) => event.type === 'ai_decision'));
const SPELLS = {
  'wipe-all': { steps: [{ do: 'destroy', count: 'all', side: 'any', filter: {} }] },
  'destroy-strongest': { steps: [{ do: 'destroy-strongest' }] },
  'wipe-opponent': { cost: 'discard', costValue: 1, steps: [{ do: 'destroy', count: 'all', side: 'opponent', filter: { faceUp: true } }] },
};
for (const [name, mine, theirs, handLoss] of [['wipe-all', 0, 0, 1], ['destroy-strongest', 1, 0, 1], ['wipe-opponent', 1, 0, 2]]) {
  const weak = { id: 3, name: 'Fraco', type: 'monster', atk: 1000, def: 0, level: 4 };
  const strong = { ...weak, id: 4, atk: 2000 };
  const game = createGame({ seed: 'spells', playerDeck: Array(6).fill(weak), enemyDeck: Array(6).fill(strong) });
  summon(game, 'player', game.player.hand[0].uid);
  endTurn(game, 'player');
  summon(game, 'enemy', game.enemy.hand[0].uid);
  endTurn(game, 'enemy');
  game.player.hand.push({ id: 9, uid: 'spell', name: 'Magia', type: 'spell', ...SPELLS[name] });
  const handBefore = game.player.hand.length;
  activateSpell(game, 'player', 'spell');
  assert.equal(game.player.field.length, mine, name);
  assert.equal(game.enemy.field.length, theirs, name);
  assert.equal(handBefore - game.player.hand.length, handLoss, name);
}

const tiny = createGame({ seed: 'deck-out', playerDeck: deck.slice(0, 4), enemyDeck: deck, enemyLp: 7000 });
assert.equal(tiny.enemy.lp, 7000);
endTurn(tiny, 'player');
endTurn(tiny, 'enemy');
assert.equal(tiny.gameOver, true);
assert.equal(tiny.winner, 'enemy');
assert.ok(tiny.events.some((event) => event.type === 'deck_out'));

// Zona e tributos escolhidos pelo jogador.
{
  const big = { id: 9, name: 'Grande', type: 'monster', atk: 2400, def: 1000, level: 6 };
  const huge = { id: 8, name: 'Enorme', type: 'monster', atk: 3000, def: 2000, level: 8 };
  const game = createGame({ seed: 'zonas', playerDeck: deck, enemyDeck: deck });
  const [a, b, c] = game.player.hand;
  summon(game, 'player', a.uid, { zone: 2 });
  assert.equal(game.player.field[0].zone, 2);
  assert.throws(() => summon(game, 'player', b.uid, { zone: 2 }), /ZONE_TAKEN/);
  summon(game, 'player', b.uid, { zone: 0 });
  summon(game, 'player', c.uid);
  assert.deepEqual(game.player.field.map((card) => card.zone).sort(), [0, 1, 2]);
  // Tributo escolhido (não o mais fraco) e o monstro novo entra na zona liberada.
  game.player.hand.push({ ...big, uid: 'player-big' });
  const strong = game.player.field.reduce((x, y) => (x.atk >= y.atk ? x : y));
  const weak = game.player.field.find((card) => card.atk < strong.atk);
  const event = summon(game, 'player', 'player-big', { tributes: [strong.uid], zone: strong.zone });
  assert.deepEqual(event.tributes, [strong.uid]);
  assert.equal(game.player.field.find((card) => card.uid === 'player-big').zone, strong.zone);
  assert.ok(game.player.field.some((card) => card.uid === weak.uid));
  assert.equal(game.player.field.length, 3);
  // Dois tributos: os escolhidos valem, e escolher demais é erro.
  game.player.hand.push({ ...huge, uid: 'player-huge' });
  const keep = game.player.field.find((card) => card.uid !== 'player-big');
  const give = game.player.field.filter((card) => card !== keep).map((card) => card.uid);
  assert.throws(() => summon(game, 'player', 'player-huge', { tributes: game.player.field.map((card) => card.uid) }), /TOO_MANY_TRIBUTES/);
  summon(game, 'player', 'player-huge', { tributes: give });
  assert.ok(game.player.field.some((card) => card.uid === keep.uid));
  assert.equal(game.player.field.length, 2);
}

console.log('game-engine: deterministic setup, turn guards, summon, attack and turn transition passed');
