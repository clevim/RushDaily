// IA do rival: busca de um turno com simulação.
// Para cada jogada possível, copia a partida (escondendo o que o rival não pode ver),
// joga o resto do turno com uma política gulosa e avalia a mesa resultante.
// Elite e Caos também preveem o contra-ataque do oponente e respeitam armadilhas baixadas.
import { applyAction } from './game-engine.mjs';
import { canAttackNow, canChangePosition, canSet, canSummon, isAttacker } from './rules.mjs';
import { canActivate, spellValue } from './effects.mjs';

const UNKNOWN_DEF = 1300; // ATK/DEF presumidos de um monstro virado (a IA não espia)
const WIN = 1000;

const DIFFICULTY = {
  apprentice: { search: false, response: false, cautious: false, noise: 0.3, aggression: 0.65 },
  duelist: { search: true, response: false, cautious: false, noise: 0.16, aggression: 0.9 },
  elite: { search: true, response: true, cautious: true, noise: 0.05, aggression: 1 },
  chaos: { search: true, response: true, cautious: true, noise: 0.01, aggression: 1.2 },
};

function settings(level = 'duelist') {
  return DIFFICULTY[level] || DIFFICULTY.duelist;
}

function hash(value) {
  let result = 2166136261;
  for (const char of String(value)) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function random(seed) {
  let value = hash(seed);
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

const sides = (state, owner) => [state[owner], owner === 'enemy' ? state.player : state.enemy];

function strongestAttacker(side) {
  return Math.max(0, ...side.field.filter(isAttacker).map((card) => card.atk));
}

/** Valor que o atacante precisa superar para destruir o alvo (virado = desconhecido). */
function wall(target) {
  if (!target.faceUp) return UNKNOWN_DEF;
  return target.position === 'defense' ? target.def : target.atk;
}

/* ---------- Jogadas possíveis ---------- */

/**
 * `expand` lista todas as variações úteis (as duas posições de invocação, recuar para Defesa,
 * cada alvo). Sem `expand`, uma variação por carta: é o que o Aprendiz usa.
 */
export function getLegalActions(state, owner = 'enemy', { expand = false } = {}) {
  const [actor, opponent] = sides(state, owner);
  const threat = strongestAttacker(opponent);
  const attackNow = canAttackNow(state, owner);
  const actions = [];
  for (const card of actor.hand) {
    if (card.type === 'spell' && canSet(actor) && canActivate(state, owner, card) && spellValue(state, owner, card) > 0.2) actions.push({ type: 'activateSpell', uid: card.uid, card });
    if (card.type === 'spell' && canSet(actor) && expand) actions.push({ type: 'setCard', uid: card.uid, card });
    if (card.type === 'trap' && canSet(actor)) actions.push({ type: 'setCard', uid: card.uid, card });
    if (card.type === 'monster' && canSummon(actor, card)) {
      const preferred = card.atk >= threat || card.def < card.atk ? 'attack' : 'set';
      if (expand) for (const position of ['attack', 'set']) actions.push({ type: 'summon', uid: card.uid, card, position });
      else actions.push({ type: 'summon', uid: card.uid, card, position: preferred });
    }
  }
  for (const card of actor.backrow) {
    if (card.type === 'spell' && canActivate(state, owner, card) && spellValue(state, owner, card) > 0.2) actions.push({ type: 'activateSpell', uid: card.uid, card });
  }
  for (const card of actor.field) {
    if (!canChangePosition(state, actor, card)) continue;
    if (!isAttacker(card) && (card.atk > threat || expand)) actions.push({ type: 'changePosition', uid: card.uid, card });
    // Recuar: monstro em Ataque que apanharia do maior atacante, mas aguenta em Defesa.
    if (expand && isAttacker(card) && card.atk < threat && card.def > card.atk) actions.push({ type: 'changePosition', uid: card.uid, card });
  }
  if (attackNow) {
    for (const card of actor.field) {
      if (actor.attacks.has(card.uid) || !isAttacker(card)) continue;
      if (!opponent.field.length) {
        actions.push({ type: 'attack', uid: card.uid, target: null, card });
        continue;
      }
      const beatable = opponent.field.filter((target) => card.atk > wall(target));
      if (expand) for (const target of beatable) actions.push({ type: 'attack', uid: card.uid, target: target.uid, card });
      else {
        const target = beatable.sort((a, b) => (isAttacker(b) - isAttacker(a)) || wall(b) - wall(a))[0];
        if (target) actions.push({ type: 'attack', uid: card.uid, target: target.uid, card });
      }
    }
  }
  actions.push({ type: 'endTurn' });
  return actions;
}

/* ---------- Avaliação da mesa ---------- */

function monsterValue(card, enemyThreat) {
  if (!card.faceUp) return 0.9; // virado: o rival não sabe o que é
  if (card.position === 'defense') return card.def / 1000 * 0.55 + (card.def >= enemyThreat ? 0.3 : 0);
  // Em Ataque vale o ATK, mas perde valor se o maior atacante do rival o atropela.
  return card.atk / 1000 + (card.atk >= enemyThreat ? 0.4 : -Math.min(1.2, (enemyThreat - card.atk) / 1000));
}

/** Contra-ataque previsto do oponente com o que está visível no campo dele. */
function counterAttack(me, opponent) {
  const mine = me.field.map((card) => ({ ...card }));
  let damage = 0;
  let lost = 0;
  const attackers = opponent.field.filter((card) => card.faceUp !== false && card.position !== 'defense').sort((a, b) => b.atk - a.atk);
  for (const attacker of attackers) {
    if (!mine.length) { damage += attacker.atk; continue; }
    // O oponente vê meus monstros com face para cima; os virados ele presume.
    const seen = (card) => (card.faceUp ? (card.position === 'defense' ? card.def : card.atk) : UNKNOWN_DEF);
    const target = mine.filter((card) => attacker.atk > seen(card)).sort((a, b) => seen(b) - seen(a))[0];
    if (!target) continue;
    const real = target.position === 'defense' ? target.def : target.atk;
    if (attacker.atk <= real) continue;
    if (target.position !== 'defense') damage += attacker.atk - real;
    lost += monsterValue({ ...target, faceUp: true }, 0);
    mine.splice(mine.indexOf(target), 1);
  }
  return { damage, lost };
}

/** Quão boa é a mesa para `owner` (positivo = bom). */
export function evaluate(state, owner, config = settings(state.difficulty)) {
  const [me, opponent] = sides(state, owner);
  if (state.gameOver) return state.winner === owner ? WIN : state.winner === 'draw' ? 0 : -WIN;
  if (opponent.lp <= 0) return WIN;
  const myThreat = strongestAttacker(me);
  const theirThreat = strongestAttacker(opponent);
  let score = (me.lp - opponent.lp) / 1000 * 1.1;
  score += opponent.lp <= 1500 ? 0.8 : 0; // pressão perto do fim
  score += me.field.reduce((sum, card) => sum + monsterValue(card, theirThreat), 0);
  score -= opponent.field.reduce((sum, card) => sum + monsterValue(card, myThreat), 0);
  score += (me.hand.length + me.backrow.length - opponent.hand.length - opponent.backrow.length) * 0.3;
  score += me.backrow.filter((card) => card.type === 'trap').length * 0.35;
  if (me.deck.length < 3) score -= (3 - me.deck.length) * 0.4;
  if (config.response) {
    const { damage, lost } = counterAttack(me, opponent);
    if (damage >= me.lp) return -WIN / 2;
    score -= damage / 1000 * 1.1 + lost * 0.8;
    score -= opponent.hand.length * 0.12; // o que ainda pode descer da mão dele
  }
  // Força Espelho Radiante pune quem fica com 3 monstros em Ataque diante de carta baixada.
  if (config.cautious && opponent.backrow.length && me.field.filter(isAttacker).length >= 3) score -= 1.4;
  return score;
}

/* ---------- Simulação ---------- */

/** Cópia da partida do ponto de vista de `owner`: os virados do oponente viram "desconhecidos". */
function believedCopy(state, owner) {
  const { events, aiMemory, ...rest } = state;
  const copy = structuredClone({ ...rest, events: [] });
  const opponent = owner === 'enemy' ? copy.player : copy.enemy;
  for (const card of opponent.field) if (!card.faceUp) Object.assign(card, { atk: UNKNOWN_DEF, def: UNKNOWN_DEF });
  return copy;
}

/** Heurística rápida, usada pelo Aprendiz e para completar o turno nas simulações. */
function quick(action, state, owner, config) {
  const [actor, opponent] = sides(state, owner);
  if (action.type === 'summon') return action.card.atk / 1000 * (action.position === 'set' ? 0.6 : 1.4) + (actor.field.length ? 0 : 0.5);
  if (action.type === 'setCard') return action.card.type === 'trap' ? 0.8 : 0.1;
  if (action.type === 'changePosition') return isAttacker(action.card) ? 0.3 : 1;
  if (action.type === 'activateSpell') return spellValue(state, owner, action.card) * 1.6;
  if (action.type === 'attack') {
    const target = opponent.field.find((card) => card.uid === action.target);
    return target ? 0.6 + (action.card.atk - wall(target)) / 1000 + (isAttacker(target) ? 0.5 : 0) : action.card.atk / 1000 * config.aggression + 0.4;
  }
  return 0.2; // endTurn
}

const MAX_STEPS = 10;

// Planos de fim de turno: "develop" prioriza descer cartas, "strike" prioriza atacar e limpar o campo.
const PLAN_BIAS = {
  develop: { summon: 0.4, setCard: 0.4, changePosition: 0.2 },
  strike: { attack: 0.5, activateSpell: 0.4 },
};

function finishTurn(copy, owner, config, plan) {
  const bias = PLAN_BIAS[plan] || {};
  for (let step = 0; step < MAX_STEPS && !copy.gameOver; step += 1) {
    const options = getLegalActions(copy, owner).filter((action) => action.type !== 'endTurn');
    if (!options.length) break;
    const best = options.map((action) => ({ action, score: quick(action, copy, owner, config) + (bias[action.type] || 0) })).sort((a, b) => b.score - a.score)[0];
    if (best.score <= 0.2) break;
    try { applyAction(copy, owner, best.action); } catch { break; }
  }
  return copy;
}

function simulate(action, state, owner, config) {
  const copy = believedCopy(state, owner);
  if (action.type === 'endTurn') return evaluate(copy, owner, config);
  try { applyAction(copy, owner, action); } catch { return -Infinity; }
  // Caos testa mais de um plano para o resto do turno e fica com o melhor.
  const plans = config.plans || [null];
  return Math.max(...plans.map((plan) => evaluate(finishTurn(plans.length > 1 ? structuredClone(copy) : copy, owner, config, plan), owner, config)));
}

export function chooseAction(state, owner = 'enemy', difficulty = state.difficulty || 'duelist') {
  const config = settings(difficulty);
  const actions = getLegalActions(state, owner, { expand: config.search });
  const ranked = actions
    .map((action) => ({ action, score: config.search ? simulate(action, state, owner, config) : quick(action, state, owner, config) }))
    .sort((left, right) => right.score - left.score);
  const roll = random(`${state.seed}:${state.turn}:${state.events.length}:${difficulty}`)();
  // Erro proposital: troca pela segunda melhor, nunca por uma que perde o duelo.
  const slip = roll < config.noise && ranked.length > 1 && ranked[1].score > -WIN / 2;
  const selected = ranked[slip ? 1 : 0] || { action: { type: 'endTurn' }, score: 0 };
  return { ...selected, candidates: ranked.slice(0, 4).map(({ action, score }) => ({ type: action.type, uid: action.uid, position: action.position, score: Number(score.toFixed(3)) })) };
}

/** Decide se ativa uma armadilha quando o oponente declara ataque. */
export function chooseTrap(traps) {
  // Toda armadilha pronta já passou pelo teste de alvo/condição: usar é quase sempre bom.
  return traps[0] || null;
}

export function evaluatePosition(state, owner = 'enemy') {
  return Number(evaluate(state, owner).toFixed(4));
}

export function recordOutcome(state) {
  const outcome = state.winner === 'enemy' ? 'wins' : 'losses';
  state.aiMemory ||= {};
  for (const event of state.events.filter((item) => item.type === 'ai_decision')) {
    state.aiMemory[event.selected] ||= { wins: 0, losses: 0 };
    state.aiMemory[event.selected][outcome] += 1;
  }
  return state.aiMemory;
}

export const AI_DIFFICULTIES = Object.keys(DIFFICULTY);
