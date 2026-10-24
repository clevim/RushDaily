import assert from 'node:assert/strict';
import { ARCHETYPES, CARD_POOL } from '../src/data/cards.mjs';
import { DECK_SIZE, generateDailyMatch, generateDeck, listDifficulties } from '../src/engine/daily-generator.mjs';

for (const difficulty of listDifficulties()) {
  const match = generateDailyMatch({ date: '2026-10-22', playerKey: 'ABC123', difficulty: difficulty.id, archetypes: ARCHETYPES, pool: CARD_POOL });
  assert.equal(match.player.deck.length, DECK_SIZE);
  assert.equal(match.enemy.deck.length, DECK_SIZE);
  assert.equal(match.player.valid, true);
  assert.equal(match.enemy.valid, true);
  for (const deck of [match.player.deck, match.enemy.deck]) {
    const copies = new Map(deck.map((card) => [card.id, 0]));
    for (const card of deck) copies.set(card.id, copies.get(card.id) + 1);
    assert.ok([...copies.values()].every((count) => count <= 3));
    assert.ok(deck.filter((card) => card.legend).length <= 3);
  }
  const repeat = generateDailyMatch({ date: '2026-10-22', playerKey: 'ABC123', difficulty: difficulty.id, archetypes: ARCHETYPES, pool: CARD_POOL });
  assert.deepEqual(match.player.deck.map((card) => card.id), repeat.player.deck.map((card) => card.id));
  assert.deepEqual(match.enemy.deck.map((card) => card.id), repeat.enemy.deck.map((card) => card.id));
}

const otherPlayer = generateDeck({ seed: '2026-10-22:OTHER:duelist', archetype: 'dragons', pool: CARD_POOL, difficulty: 'duelist' });
const samePlayer = generateDeck({ seed: '2026-10-22:ABC123', archetype: 'dragons', pool: CARD_POOL, difficulty: 'duelist' });
assert.notDeepEqual(otherPlayer.deck.map((card) => card.id), samePlayer.deck.map((card) => card.id));
console.log('daily-generator: valid decks, copy limits and deterministic seeds passed');
