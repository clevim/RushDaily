import assert from 'node:assert/strict';
import { activateSpell, activateTrap, createGame, endTurn, setCard, summon, trapsFor } from '../src/engine/game-engine.mjs';
import { canActivate } from '../src/engine/effects.mjs';

const dragon = { id: 1, name: 'Dragão', type: 'monster', atk: 1500, def: 1000, level: 4, raceKey: 'Dragon', attribute: 'FIRE' };
const warrior = { id: 2, name: 'Guerreiro', type: 'monster', atk: 1800, def: 1000, level: 4, raceKey: 'Warrior', attribute: 'EARTH' };
const fresh = () => createGame({ seed: 'efeitos', playerDeck: Array(10).fill(dragon), enemyDeck: Array(10).fill(warrior) });

// Condição: "você tem um Dragão com a face para cima"; ATK até o fim do turno volta ao normal.
{
  const game = fresh();
  const boost = { uid: 'boost', id: 50, name: 'Fôlego', type: 'spell', condition: { have: { race: 'Dragon', faceUp: true } }, steps: [{ do: 'atk', target: 'own', filter: { faceUp: true }, value: 700 }] };
  game.player.hand.push(boost);
  assert.equal(canActivate(game, 'player', boost), false, 'sem Dragão no campo');
  summon(game, 'player', game.player.hand[0].uid);
  assert.equal(canActivate(game, 'player', boost), true);
  activateSpell(game, 'player', 'boost');
  assert.equal(game.player.field[0].atk, 2200);
  endTurn(game, 'player');
  assert.equal(game.player.field[0].atk, 1500, 'bônus expira no fim do turno');
}

// Custo em PV, dano e cura.
{
  const game = fresh();
  game.player.hand.push({ uid: 'burn', id: 51, name: 'Faíscas', type: 'spell', cost: 'lp', costValue: 500, steps: [{ do: 'burn', value: 800 }, { do: 'heal', value: 300 }] });
  activateSpell(game, 'player', 'burn');
  assert.equal(game.enemy.lp, 4200);
  assert.equal(game.player.lp, 4800);
}

// Armadilha que responde à Invocação-Normal do oponente, com filtro de Nível.
{
  const big = { ...warrior, id: 3, level: 7, atk: 2500 };
  const game = createGame({ seed: 'efeitos', playerDeck: Array(10).fill(dragon), enemyDeck: [...Array(6).fill(warrior), ...Array(4).fill(big)] });
  game.player.hand.push({ uid: 'pit', id: 52, name: 'Fosso', type: 'trap', trigger: 'summon', summonFilter: { minLevel: 7 }, steps: [{ do: 'destroy-summoned' }] });
  setCard(game, 'player', 'pit');
  endTurn(game, 'player');
  summon(game, 'enemy', game.enemy.hand.find((card) => card.level === 4).uid);
  const small = { kind: 'summon', summoned: game.enemy.field[0] };
  assert.equal(trapsFor(game, 'player', small).length, 0, 'Nível 4 não ativa');
  game.enemy.field[0].level = 7; // simula a Invocação de um Nível 7
  const context = { kind: 'summon', summoned: game.enemy.field[0] };
  assert.equal(trapsFor(game, 'player', context).length, 1);
  activateTrap(game, 'player', 'pit', context);
  assert.equal(game.enemy.field.length, 0);
}
console.log('effects: condição, ATK temporário, custo em PV, dano, cura e armadilha de invocação passed');
