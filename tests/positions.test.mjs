import assert from 'node:assert/strict';
import { activateTrap, attack, changePosition, createGame, endTurn, heartOfTheCards, heartRanking, setCard, summon, trapsFor } from '../src/engine/game-engine.mjs';

const knight = { id: 1, name: 'Cavaleiro', type: 'monster', atk: 1800, def: 1000, level: 4 };
const wall = { id: 2, name: 'Muralha', type: 'monster', atk: 500, def: 2000, level: 4 };
const mirror = { id: 3, name: 'Espelho', type: 'trap', trigger: 'attack', steps: [{ do: 'destroy', count: 'all', side: 'opponent', filter: { attackPosition: true } }] };
const deck = (card) => Array(10).fill(card);

// Defesa virada: o atacante revela, perde para a DEF e toma a diferença; ninguém é destruído.
let game = createGame({ seed: 'pos', playerDeck: deck(knight), enemyDeck: deck(wall) });
summon(game, 'player', game.player.hand[0].uid);
endTurn(game, 'player');
summon(game, 'enemy', game.enemy.hand[0].uid, { position: 'set' });
const hidden = game.enemy.field[0];
assert.equal(hidden.faceUp, false);
assert.equal(hidden.position, 'defense');
assert.throws(() => attack(game, 'enemy', hidden.uid, game.player.field[0].uid), /NOT_IN_ATTACK/);
endTurn(game, 'enemy');
assert.throws(() => attack(game, 'player', game.player.field[0].uid, null), /MUST_TARGET/);
const events = attack(game, 'player', game.player.field[0].uid, hidden.uid);
assert.ok(events.some((event) => event.type === 'flip'));
assert.equal(hidden.faceUp, true);
assert.equal(game.player.lp, 5000 - 200);
assert.equal(game.enemy.lp, 5000);
assert.equal(game.enemy.field.length, 1);
assert.equal(game.player.field.length, 1);

// Mudança de posição: uma vez por turno.
const mine = game.player.field[1] || (summon(game, 'player', game.player.hand[0].uid), game.player.field[1]);
changePosition(game, 'player', mine.uid);
assert.equal(mine.position, 'defense');
assert.throws(() => changePosition(game, 'player', mine.uid), /CANNOT_CHANGE/);

// Armadilha: baixada não ativa no mesmo meio-turno; no turno do rival dispara no ataque.
game = createGame({ seed: 'trap', playerDeck: deck(knight), enemyDeck: deck(knight) });
const trap = { ...mirror, uid: 'player-trap' };
game.player.hand.push(trap);
setCard(game, 'player', trap.uid);
endTurn(game, 'player');
summon(game, 'enemy', game.enemy.hand[0].uid);
const declared = { kind: 'attack', attacker: game.enemy.field[0], direct: true };
assert.equal(trapsFor(game, 'player', { kind: 'summon', summoned: game.enemy.field[0] }).length, 0, 'gatilho errado não dispara');
assert.equal(trapsFor(game, 'player', declared).length, 1);
const result = activateTrap(game, 'player', trap.uid, declared);
assert.equal(result.removed.length, 1);
assert.equal(game.enemy.field.length, 0);
assert.equal(game.player.backrow.length, 0);
console.log('positions: defense battle, face-down flip, position change and trap timing passed');

// Coração das Cartas: com o rival forte no campo, puxa o monstro que o supera; só uma vez.
{
  const weak = { id: 10, name: 'Fraco', type: 'monster', atk: 500, def: 500, level: 4 };
  const ace = { id: 11, name: 'Ás', type: 'monster', atk: 2100, def: 900, level: 4 };
  const brute = { id: 12, name: 'Bruto', type: 'monster', atk: 1800, def: 900, level: 4 };
  const heart = createGame({ seed: 'heart', playerDeck: [...Array(9).fill(weak), ace], enemyDeck: Array(10).fill(brute) });
  heart.player.deck = heart.player.deck.filter((card) => card.id !== 11).concat(heart.player.deck.filter((card) => card.id === 11)); // Ás no fundo do deck
  endTurn(heart, 'player');
  summon(heart, 'enemy', heart.enemy.hand[0].uid);
  endTurn(heart, 'enemy');
  const before = heart.player.hand.length;
  const pulled = heartOfTheCards(heart, 'player');
  assert.equal(pulled.name, 'Ás');
  assert.equal(heart.player.hand.length, before + 1);
  assert.throws(() => heartOfTheCards(heart, 'player'), /HEART_USED/);

  // Com escolha: qualquer carta do deck; uid fora do deck é recusado e não gasta o poder.
  const heart2 = createGame({ seed: 'heart2', playerDeck: [...Array(9).fill(weak), ace], enemyDeck: Array(10).fill(brute) });
  endTurn(heart2, 'player');
  endTurn(heart2, 'enemy');
  const chosen = heart2.player.deck[heart2.player.deck.length - 1];
  const handUid = heart2.player.hand[0].uid;
  assert.throws(() => heartOfTheCards(heart2, 'player', { uid: handUid }), /NOT_IN_DECK/);
  assert.ok(!heart2.player.heartUsed);
  assert.equal(heartRanking(heart2, 'player').length, heart2.player.deck.length);
  const decked = heart2.player.deck.length;
  const event = heartOfTheCards(heart2, 'player', { uid: chosen.uid });
  assert.equal(event.card, chosen.uid);
  assert.ok(heart2.player.hand.some((card) => card.uid === chosen.uid));
  assert.equal(heart2.player.deck.length, decked - 1);
  assert.throws(() => heartOfTheCards(heart2, 'player', { uid: heart2.player.deck[0].uid }), /HEART_USED/);
}

// Regra da casa: virado em Ataque; trocar posição mantendo a face; desvirar mantendo a posição.
{
  const game = createGame({ seed: 'casa', playerDeck: deck(knight), enemyDeck: deck(wall) });
  summon(game, 'player', game.player.hand[0].uid, { position: 'set-attack' });
  const card = game.player.field[0];
  assert.equal(card.faceUp, false);
  assert.equal(card.position, 'attack');
  endTurn(game, 'player');
  endTurn(game, 'enemy');
  changePosition(game, 'player', card.uid, { position: 'defense' });
  assert.equal(card.faceUp, false, 'continua virado');
  assert.equal(card.position, 'defense');
  assert.throws(() => changePosition(game, 'player', card.uid, { faceUp: true }), /CANNOT_CHANGE/, 'uma mudança por turno');
  endTurn(game, 'player');
  endTurn(game, 'enemy');
  changePosition(game, 'player', card.uid, { faceUp: true });
  assert.equal(card.faceUp, true);
  assert.equal(card.position, 'defense', 'desvira sem mudar a posição');
}
