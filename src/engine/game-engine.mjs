import { chooseAction } from './ai.mjs';
import { canAttackNow, canChangePosition, canSet, canSummon, isAttacker, tributesFor, turnKey } from './rules.mjs';
import { canActivate, expireMods, payCost, runSteps, spellValue, trapReady } from './effects.mjs';

const STARTING_LP = 5000;
const STARTING_HAND = 4;
const MAX_HAND = 5;
const MAX_FIELD = 3;
// Limite de turnos: sem efeitos de monstro, dois campos defensivos travam o duelo. No turno 21, vence quem tem mais PV.
const TURN_LIMIT = 20;
const MAX_BACKROW = 3;

function hashSeed(seed) {
  let value = 2166136261;
  for (const character of String(seed)) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function randomNext(state) {
  let value = state.rng;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.rng = value >>> 0;
  return state.rng / 4294967296;
}

function shuffle(cards, state) {
  const result = [...cards];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(randomNext(state) * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function makeCard(template, owner, index) {
  return { ...template, uid: `${owner}-${template.id}-${index}` };
}

function makePlayer(deck, owner, lp = STARTING_LP) {
  return {
    owner,
    lp,
    deck: deck.map((card, index) => makeCard(card, owner, index)),
    hand: [],
    field: [],
    backrow: [],
    graveyard: [],
    normalSummons: 0,
    attacks: new Set(),
  };
}

function playerFor(state, owner) {
  return owner === 'player' ? state.player : state.enemy;
}

function opponentFor(state, owner) {
  return owner === 'player' ? state.enemy : state.player;
}

function cardInHand(player, uid) {
  return player.hand.find((card) => card.uid === uid);
}

function moveFromHand(player, uid) {
  const index = player.hand.findIndex((card) => card.uid === uid);
  if (index < 0) return null;
  return player.hand.splice(index, 1)[0];
}

function drawToFive(player, events) {
  while (player.hand.length < MAX_HAND && player.deck.length > 0) {
    const card = player.deck.shift();
    player.hand.push(card);
    events.push({ type: 'draw', owner: player.owner, card: card.uid });
  }
}

function drawCount(player, count, events) {
  for (let index = 0; index < count && player.deck.length > 0; index += 1) {
    const card = player.deck.shift();
    player.hand.push(card);
    events.push({ type: 'draw', owner: player.owner, card: card.uid });
  }
}

function destroy(player, card, events, reason) {
  for (const zone of [player.field, player.backrow]) {
    const index = zone.findIndex((item) => item.uid === card.uid);
    if (index >= 0) zone.splice(index, 1);
  }
  // No cemitério a carta volta ao estado de carta (sem posição nem face).
  const { position, faceUp, summonedTurn, changedTurn, setTurn, ...plain } = card;
  player.graveyard.push(plain);
  events.push({ type: 'destroy', owner: player.owner, card: card.uid, reason });
}

function assertTurn(state, owner) {
  if (state.gameOver) throw new Error('DUEL_OVER');
  if (state.active !== owner) throw new Error('NOT_YOUR_TURN');
}

function finishIfNeeded(state, events) {
  if (state.player.lp <= 0 || state.enemy.lp <= 0) {
    state.gameOver = true;
    state.winner = state.player.lp > state.enemy.lp ? 'player' : state.enemy.lp > state.player.lp ? 'enemy' : 'draw';
    events.push({ type: 'duel_end', winner: state.winner });
  }
}

export function createGame({ seed, playerDeck, enemyDeck, difficulty = 'duelist', enemyLp = STARTING_LP }) {
  const state = {
    seed: String(seed),
    rng: hashSeed(seed),
    turn: 1,
    active: 'player',
    gameOver: false,
    winner: null,
    difficulty,
    aiMemory: {},
    player: makePlayer(playerDeck, 'player'),
    enemy: makePlayer(enemyDeck, 'enemy', enemyLp),
    events: [],
  };
  state.player.deck = shuffle(state.player.deck, state);
  state.enemy.deck = shuffle(state.enemy.deck, state);
  drawCount(state.player, STARTING_HAND, state.events);
  drawCount(state.enemy, STARTING_HAND, state.events);
  state.events.push({ type: 'game_start', seed: state.seed });
  return state;
}

export function startTurn(state, owner = state.active) {
  assertTurn(state, owner);
  const player = playerFor(state, owner);
  player.normalSummons = 0;
  player.attacks.clear();
  const events = [];
  if (owner === 'player' && state.turn > TURN_LIMIT) {
    state.gameOver = true;
    state.winner = state.player.lp > state.enemy.lp ? 'player' : state.enemy.lp > state.player.lp ? 'enemy' : 'draw';
    events.push({ type: 'turn_limit', turn: TURN_LIMIT }, { type: 'duel_end', winner: state.winner });
    state.events.push(...events);
    return events;
  }
  // Regra Rush: quem precisa comprar e não tem deck perde o duelo.
  if (player.hand.length < MAX_HAND && player.deck.length === 0) {
    state.gameOver = true;
    state.winner = owner === 'player' ? 'enemy' : 'player';
    events.push({ type: 'deck_out', owner }, { type: 'duel_end', winner: state.winner });
    state.events.push(...events);
    return events;
  }
  drawToFive(player, events);
  state.events.push(...events, { type: 'turn_start', owner, turn: state.turn });
  return events;
}

/** position: 'attack', 'defense' (de lado), 'set' (virado em Defesa) ou 'set-attack' (virado em Ataque, regra da casa). */
export function summon(state, owner, uid, { position = 'attack', tributes: preferred = [] } = {}) {
  assertTurn(state, owner);
  const player = playerFor(state, owner);
  const card = cardInHand(player, uid);
  if (!card || card.type !== 'monster') throw new Error('INVALID_SUMMON');
  const tributeCount = tributesFor(card);
  if (player.field.length < tributeCount) throw new Error('NEED_TRIBUTES');
  if (!canSummon(player, card)) throw new Error('FIELD_FULL');
  // Tributos: os escolhidos (ex.: monstro sob a carta solta) primeiro, depois os mais fracos.
  const tributes = [...player.field]
    .sort((a, b) => (preferred.includes(b.uid) - preferred.includes(a.uid)) || a.atk - b.atk)
    .slice(0, tributeCount);
  for (const tribute of tributes) destroy(player, tribute, state.events, 'tribute');
  const summoned = moveFromHand(player, uid);
  // 'set' = virado em Defesa (regra Rush); 'set-attack' = virado em Ataque (regra da casa do RushDaily).
  const set = position === 'set' || position === 'set-attack';
  Object.assign(summoned, { position: position === 'set' || position === 'defense' ? 'defense' : 'attack', faceUp: !set, summonedTurn: turnKey(state), changedTurn: null });
  player.field.push(summoned);
  player.normalSummons += 1;
  const event = { type: set ? 'set_monster' : 'summon', owner, card: summoned.uid, name: set ? null : summoned.name, tributes: tributes.map((tribute) => tribute.uid) };
  state.events.push(event);
  return event;
}

/** Baixa uma Magia ou Armadilha virada na zona de Magias/Armadilhas. */
export function setCard(state, owner, uid) {
  assertTurn(state, owner);
  const player = playerFor(state, owner);
  const card = cardInHand(player, uid);
  if (!card || card.type === 'monster') throw new Error('INVALID_SET');
  if (!canSet(player)) throw new Error('BACKROW_FULL');
  const placed = moveFromHand(player, uid);
  Object.assign(placed, { faceUp: false, setTurn: turnKey(state) });
  player.backrow.push(placed);
  const event = { type: 'set_card', owner, card: placed.uid };
  state.events.push(event);
  return event;
}

/** Ataque <-> Defesa uma vez por turno; virada para baixo vira para cima em Ataque. */
/**
 * Muda a posição e/ou a face de um monstro no campo, uma vez por turno.
 * Sem `to`: virado vai para cima em Ataque; com a face para cima, alterna Ataque/Defesa.
 * Com `to` ({ position?, faceUp? }): aplica só o que vier (ex.: alternar mantendo virado, ou desvirar mantendo a posição).
 * Desvirar é permitido; virar para baixo de novo, não.
 */
export function changePosition(state, owner, uid, to = null) {
  assertTurn(state, owner);
  const player = playerFor(state, owner);
  const card = player.field.find((item) => item.uid === uid);
  if (!card || !canChangePosition(state, player, card)) throw new Error('CANNOT_CHANGE');
  const wasDown = card.faceUp === false;
  const next = to
    ? { position: to.position || card.position, faceUp: to.faceUp ?? card.faceUp }
    : { position: wasDown || card.position === 'defense' ? 'attack' : 'defense', faceUp: true };
  if (card.faceUp && next.faceUp === false) throw new Error('CANNOT_CHANGE');
  if (next.position === card.position && next.faceUp === card.faceUp) throw new Error('CANNOT_CHANGE');
  Object.assign(card, next, { changedTurn: turnKey(state) });
  const flipped = wasDown && card.faceUp;
  const event = { type: flipped ? 'flip' : 'position', owner, card: uid, name: card.faceUp ? card.name : null, position: card.position, faceUp: card.faceUp };
  state.events.push(event);
  return event;
}

export function activateSpell(state, owner, uid) {
  assertTurn(state, owner);
  const player = playerFor(state, owner);
  const fromHand = cardInHand(player, uid);
  const card = fromHand || player.backrow.find((item) => item.uid === uid);
  if (!card || card.type !== 'spell') throw new Error('INVALID_SPELL');
  if (fromHand && !canSet(player)) throw new Error('BACKROW_FULL');
  if (!canActivate(state, owner, card)) throw new Error('CANNOT_ACTIVATE');
  if (fromHand) moveFromHand(player, uid);
  else player.backrow.splice(player.backrow.indexOf(card), 1);
  const events = [];
  payCost(state, owner, card, events);
  const { faceUp, setTurn, ...plain } = card;
  player.graveyard.push(plain);
  events.push(...runSteps(state, owner, card, {}, { destroy, draw: drawCount }));
  const event = { type: 'spell', owner, card: card.uid, name: card.name, removed: events.filter((item) => item.type === 'destroy').map((item) => item.card), events };
  state.events.push(...events, event);
  finishIfNeeded(state, events);
  return event;
}

/** Armadilhas que `owner` pode ativar agora. context = { kind: 'attack', attacker, direct } | { kind: 'summon', summoned } */
export function trapsFor(state, owner, context = {}) {
  return playerFor(state, owner).backrow.filter((card) => trapReady(state, owner, card, context));
}

export function activateTrap(state, owner, uid, context = {}) {
  const player = playerFor(state, owner);
  const card = player.backrow.find((item) => item.uid === uid);
  if (!card || !trapReady(state, owner, card, context)) throw new Error('INVALID_TRAP');
  player.backrow.splice(player.backrow.indexOf(card), 1);
  const events = [];
  payCost(state, owner, card, events);
  const { faceUp, setTurn, ...plain } = card;
  player.graveyard.push(plain);
  events.push(...runSteps(state, owner, card, context, { destroy, draw: drawCount }));
  const event = { type: 'trap', owner, card: card.uid, name: card.name, removed: events.filter((item) => item.type === 'destroy').map((item) => item.card), events };
  state.events.push(...events, event);
  finishIfNeeded(state, events);
  return event;
}

export function attack(state, owner, attackerUid, defenderUid = null) {
  assertTurn(state, owner);
  const player = playerFor(state, owner);
  const opponent = opponentFor(state, owner);
  if (!canAttackNow(state, owner)) throw new Error('FIRST_TURN');
  const attacker = player.field.find((card) => card.uid === attackerUid);
  if (!attacker || player.attacks.has(attackerUid)) throw new Error('INVALID_ATTACK');
  if (!isAttacker(attacker)) throw new Error('NOT_IN_ATTACK');
  const defender = defenderUid ? opponent.field.find((card) => card.uid === defenderUid) : null;
  if (!defender && opponent.field.length) throw new Error('MUST_TARGET');
  player.attacks.add(attackerUid);
  const events = [];
  if (defender && !defender.faceUp) {
    defender.faceUp = true;
    events.push({ type: 'flip', owner: opponent.owner, card: defender.uid, name: defender.name, reason: 'attacked' });
  }
  if (!defender) {
    opponent.lp -= attacker.atk;
    events.push({ type: 'direct_attack', owner, attacker: attacker.uid, damage: attacker.atk });
  } else if (defender.position === 'defense') {
    // Contra Defesa: ninguém do lado defensor sofre dano; perder para a DEF fere o atacante.
    const result = attacker.atk > defender.def ? 'win' : attacker.atk < defender.def ? 'lose' : 'draw';
    const damage = result === 'lose' ? defender.def - attacker.atk : 0;
    if (result === 'win') destroy(opponent, defender, events, 'battle');
    player.lp -= damage;
    events.push({ type: 'attack', owner, attacker: attacker.uid, defender: defender.uid, damage, result, defense: true });
  } else if (attacker.atk > defender.atk) {
    const damage = attacker.atk - defender.atk;
    opponent.lp -= damage;
    destroy(opponent, defender, events, 'battle');
    events.push({ type: 'attack', owner, attacker: attacker.uid, defender: defender.uid, damage, result: 'win' });
  } else if (attacker.atk < defender.atk) {
    const damage = defender.atk - attacker.atk;
    player.lp -= damage;
    destroy(player, attacker, events, 'battle');
    events.push({ type: 'attack', owner, attacker: attacker.uid, defender: defender.uid, damage, result: 'lose' });
  } else {
    destroy(player, attacker, events, 'battle');
    destroy(opponent, defender, events, 'battle');
    events.push({ type: 'attack', owner, attacker: attacker.uid, defender: defender.uid, damage: 0, result: 'draw' });
  }
  state.events.push(...events);
  finishIfNeeded(state, events);
  return events;
}

export function endTurn(state, owner) {
  assertTurn(state, owner);
  expireMods(state);
  state.active = owner === 'player' ? 'enemy' : 'player';
  if (state.active === 'player') state.turn += 1;
  const events = [{ type: 'turn_end', owner, next: state.active, turn: state.turn }];
  state.events.push(...events);
  startTurn(state, state.active);
  return events;
}

/** Quanto uma carta do deck vale agora, para esta mesa. */
function keyValue(state, owner, card) {
  const player = playerFor(state, owner);
  const opponent = opponentFor(state, owner);
  const threat = Math.max(0, ...opponent.field.filter(isAttacker).map((item) => item.atk));
  if (card.type === 'monster') {
    const ready = player.field.length >= tributesFor(card);
    return (card.atk / 1000) * (ready ? 1 : 0.4) + (ready && card.atk > threat ? 1.5 : 0);
  }
  if (card.type === 'spell') return spellValue(state, owner, card);
  return opponent.field.some(isAttacker) ? 0.6 : 0.2;
}

/** Coração das Cartas: uma vez por duelo, puxa do deck a carta-chave para a mesa atual. */
export function heartOfTheCards(state, owner) {
  assertTurn(state, owner);
  const player = playerFor(state, owner);
  if (player.heartUsed) throw new Error('HEART_USED');
  if (!player.deck.length) throw new Error('DECK_EMPTY');
  let best = player.deck[0];
  for (const card of player.deck) if (keyValue(state, owner, card) > keyValue(state, owner, best)) best = card;
  player.deck.splice(player.deck.indexOf(best), 1);
  player.hand.push(best);
  player.heartUsed = true;
  const event = { type: 'heart', owner, card: best.uid, name: best.name };
  state.events.push(event);
  return event;
}

/** Executa uma ação da IA (ou de qualquer lado) já decidida. */
export function applyAction(state, owner, action) {
  if (action.type === 'summon') return [summon(state, owner, action.uid, { position: action.position })];
  if (action.type === 'setCard') return [setCard(state, owner, action.uid)];
  if (action.type === 'changePosition') return [changePosition(state, owner, action.uid, action.to)];
  if (action.type === 'activateSpell') return [activateSpell(state, owner, action.uid)];
  if (action.type === 'attack') return attack(state, owner, action.uid, action.target);
  return endTurn(state, owner);
}

export function chooseAiAction(state) {
  assertTurn(state, 'enemy');
  const actions = [];
  while (!state.gameOver && state.active === 'enemy') {
    const decision = chooseAction(state, 'enemy', state.difficulty);
    state.events.push({ type: 'ai_decision', difficulty: state.difficulty, selected: decision.action.type, candidates: decision.candidates });
    actions.push(...applyAction(state, 'enemy', decision.action));
    if (decision.action.type === 'endTurn') break;
  }
  return actions;
}

export function serializeGame(state) {
  return JSON.stringify({ ...state, player: { ...state.player, attacks: [...state.player.attacks] }, enemy: { ...state.enemy, attacks: [...state.enemy.attacks] } });
}

export function snapshotGame(state) {
  return JSON.parse(serializeGame(state));
}

export const RULES = { STARTING_LP, STARTING_HAND, MAX_HAND, MAX_FIELD, MAX_BACKROW, TURN_LIMIT };
