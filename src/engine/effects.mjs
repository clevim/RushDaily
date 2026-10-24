// Efeitos de Magias e Armadilhas como listas de passos (gerados por tools/card-render/classify.py).
// Alvos são escolhidos automaticamente pelo melhor resultado para quem ativa.
import { isAttacker, turnKey } from './rules.mjs';

const sides = (state, owner) => (owner === 'player' ? [state.player, state.enemy] : [state.enemy, state.player]);

/** A carta (monstro no campo ou na mão) atende ao filtro do texto? */
export function matches(card, filter = {}) {
  if (!card || card.type !== 'monster') return false;
  if (filter.faceUp && card.faceUp === false) return false;
  if (filter.attackPosition && !isAttacker(card)) return false;
  if (filter.minLevel && card.level < filter.minLevel) return false;
  if (filter.maxLevel && card.level > filter.maxLevel) return false;
  if (filter.attribute && card.attribute !== filter.attribute) return false;
  if (filter.race && card.raceKey !== filter.race) return false;
  if (filter.minAtk !== undefined && card.atk < filter.minAtk) return false;
  if (filter.maxAtk !== undefined && card.atk > filter.maxAtk) return false;
  return true;
}

const value = (card) => (card.atk || 0) + (card.def || 0) * 0.25;
const byStrength = (a, b) => value(b) - value(a);

function costPayable(player, card) {
  const others = player.hand.filter((item) => item.uid !== card.uid);
  if (card.cost === 'discard') return others.length >= (card.costValue || 1);
  if (card.cost === 'discard-monster') return others.filter((item) => item.type === 'monster').length >= (card.costValue || 1);
  if (card.cost === 'mill') return player.deck.length >= (card.costValue || 1);
  if (card.cost === 'lp') return player.lp > card.costValue;
  return true;
}

function conditionMet(player, card) {
  const condition = card.condition || {};
  if (condition.have && !player.field.some((item) => item.faceUp !== false && matches(item, condition.have))) return false;
  if (condition.haveName && !player.field.some((item) => item.faceUp !== false && item.enName === condition.haveName)) return false;
  return true;
}

/** O primeiro passo com alvo precisa ter alvo (não se ativa "Destrua 1 monstro" num campo vazio). */
function hasTargets(state, owner, card, context = {}) {
  const [me, them] = sides(state, owner);
  const step = (card.steps || []).find((item) => ['destroy', 'destroy-strongest', 'destroy-backrow', 'atk', 'special-summon', 'destroy-attacker', 'destroy-summoned'].includes(item.do));
  if (!step) return true;
  if (step.do === 'destroy') return pool(me, them, step.side).some((item) => matches(item, step.filter));
  if (step.do === 'destroy-strongest') return [...me.field, ...them.field].some(isAttacker);
  if (step.do === 'destroy-backrow') return (step.side === 'own' ? me.backrow : step.side === 'any' ? [...me.backrow, ...them.backrow] : them.backrow).some((item) => item.uid !== card.uid);
  if (step.do === 'special-summon') return me.field.length < 3 && me.hand.some((item) => item.uid !== card.uid && matches(item, step.filter));
  if (step.do === 'atk') {
    if (step.target === 'attacker') return Boolean(context.attacker);
    return (step.target === 'own' ? me.field : them.field).some((item) => item.faceUp !== false && matches(item, step.filter));
  }
  if (step.do === 'destroy-attacker') return Boolean(context.attacker);
  return Boolean(context.summoned);
}

/** Magia pode ser ativada agora (custo, condição e alvo)? */
export function canActivate(state, owner, card) {
  const [me] = sides(state, owner);
  return card.type === 'spell' && costPayable(me, card) && conditionMet(me, card) && hasTargets(state, owner, card);
}

/**
 * Armadilha pronta para responder: baixada antes deste meio-turno, gatilho certo e condição cumprida.
 * context = { kind: 'attack', attacker, direct } | { kind: 'summon', summoned }
 */
export function trapReady(state, owner, card, context = {}) {
  if (card.type !== 'trap' || card.setTurn === undefined || card.setTurn === turnKey(state)) return false;
  const [me, them] = sides(state, owner);
  if (card.trigger === 'summon') {
    if (context.kind !== 'summon' || (card.summonFilter && !matches(context.summoned, card.summonFilter))) return false;
  } else {
    if (context.kind !== 'attack') return false;
    if (card.trigger === 'direct-attack' && !context.direct) return false;
    if (card.attackerFilter && !matches(context.attacker, card.attackerFilter)) return false;
    if (card.condition?.attackerSideAttackers && them.field.filter(isAttacker).length < card.condition.attackerSideAttackers) return false;
  }
  return costPayable(me, card) && conditionMet(me, card) && hasTargets(state, owner, card, context);
}

function pool(me, them, side) {
  return side === 'own' ? me.field : side === 'any' ? [...them.field, ...me.field] : them.field;
}

export function payCost(state, owner, card, events) {
  const [me] = sides(state, owner);
  const count = card.costValue || 1;
  if (card.cost === 'discard' || card.cost === 'discard-monster') {
    // ponytail: descarta as cartas mais fracas; escolha manual quando a UI tiver seleção de custo.
    const candidates = me.hand.filter((item) => item.uid !== card.uid && (card.cost === 'discard' || item.type === 'monster'));
    for (const item of candidates.sort((a, b) => (a.power || 0) - (b.power || 0)).slice(0, count)) {
      me.hand.splice(me.hand.indexOf(item), 1);
      me.graveyard.push(item);
      events.push({ type: 'discard', owner, card: item.uid });
    }
  }
  if (card.cost === 'mill') for (const item of me.deck.splice(0, count)) me.graveyard.push(item);
  if (card.cost === 'lp') me.lp -= card.costValue;
}

/** Executa os passos. `destroy(side, card, events, reason)` e `draw(player, n, events)` vêm do engine. */
export function runSteps(state, owner, card, context, { destroy, draw }) {
  const [me, them] = sides(state, owner);
  const events = [];
  const sideOf = (target) => (me.field.includes(target) || me.backrow.includes(target) ? me : them);
  for (const step of card.steps || []) {
    if (step.do === 'heal') me.lp += step.value;
    if (step.do === 'burn') them.lp -= step.value;
    if (step.do === 'draw') draw(me, step.value, events);
    if (step.do === 'discard') {
      for (const item of [...me.hand].sort((a, b) => (a.power || 0) - (b.power || 0)).slice(0, step.value)) {
        me.hand.splice(me.hand.indexOf(item), 1);
        me.graveyard.push(item);
        events.push({ type: 'discard', owner, card: item.uid });
      }
    }
    if (step.do === 'destroy') {
      // Lado do oponente: os mais fortes primeiro. Lado próprio: os mais fracos.
      const theirs = (step.side === 'own' ? [] : them.field).filter((item) => matches(item, step.filter)).sort(byStrength);
      const mine = (step.side === 'opponent' ? [] : me.field).filter((item) => matches(item, step.filter)).sort((a, b) => -byStrength(a, b));
      const targets = step.count === 'all' ? [...theirs, ...mine] : [...theirs, ...mine].slice(0, step.count);
      for (const target of targets) destroy(sideOf(target), target, events, 'effect');
    }
    if (step.do === 'destroy-strongest') {
      const target = [...me.field, ...them.field].filter(isAttacker).sort((a, b) => b.atk - a.atk)[0];
      if (target) destroy(sideOf(target), target, events, 'effect');
    }
    if (step.do === 'destroy-backrow') {
      const list = (step.side === 'own' ? me.backrow : step.side === 'any' ? [...them.backrow, ...me.backrow] : them.backrow).filter((item) => item.uid !== card.uid);
      for (const target of step.count === 'all' ? list : list.slice(0, step.count)) destroy(sideOf(target), target, events, 'effect');
    }
    if (step.do === 'destroy-attacker' && context.attacker && them.field.includes(context.attacker)) destroy(them, context.attacker, events, 'effect');
    if (step.do === 'destroy-summoned' && context.summoned && them.field.includes(context.summoned)) destroy(them, context.summoned, events, 'effect');
    if (step.do === 'atk') {
      const target = step.target === 'attacker' ? context.attacker
        : (step.target === 'own' ? me.field : them.field).filter((item) => item.faceUp !== false && matches(item, step.filter)).sort((a, b) => b.atk - a.atk)[0]; // o mais forte: bônus no próprio, corte no do rival
      if (target) {
        const delta = Math.max(-target.atk, step.value);
        target.atk += delta;
        (state.tempMods ||= []).push({ uid: target.uid, delta, until: turnKey(state) });
        events.push({ type: 'atk', owner, card: target.uid, delta });
      }
    }
    if (step.do === 'special-summon' && me.field.length < 3) {
      const pick = me.hand.filter((item) => item.uid !== card.uid && matches(item, step.filter)).sort(byStrength)[0];
      if (pick) {
        me.hand.splice(me.hand.indexOf(pick), 1);
        Object.assign(pick, { position: 'attack', faceUp: true, summonedTurn: turnKey(state), changedTurn: null });
        me.field.push(pick);
        events.push({ type: 'special_summon', owner, card: pick.uid, name: pick.name });
      }
    }
  }
  return events;
}

/** Desfaz os bônus/penalidades de ATK "até o fim deste turno". */
export function expireMods(state) {
  const now = turnKey(state);
  for (const mod of state.tempMods || []) {
    if (mod.until !== now) continue;
    const card = [...state.player.field, ...state.enemy.field].find((item) => item.uid === mod.uid);
    if (card) card.atk -= mod.delta;
  }
  state.tempMods = (state.tempMods || []).filter((mod) => mod.until !== now);
}

/** Valor aproximado de uma Magia agora, para a IA e o Coração das Cartas. */
export function spellValue(state, owner, card) {
  const [me, them] = sides(state, owner);
  let total = 0;
  for (const step of card.steps || []) {
    if (step.do === 'heal') total += step.value / 1500;
    if (step.do === 'burn') total += step.value / 1000 * (them.lp <= step.value ? 50 : 1.1);
    if (step.do === 'draw') total += step.value * 0.6;
    if (step.do === 'discard') total -= step.value * 0.5;
    if (step.do === 'destroy') {
      const theirs = (step.side === 'own' ? [] : them.field).filter((item) => matches(item, step.filter)).sort(byStrength);
      const mine = (step.side === 'opponent' ? [] : me.field).filter((item) => matches(item, step.filter));
      const take = step.count === 'all' ? theirs : theirs.slice(0, step.count);
      total += take.reduce((sum, item) => sum + value(item), 0) / 1000 - (step.count === 'all' ? mine.reduce((sum, item) => sum + value(item), 0) / 1000 : 0);
    }
    if (step.do === 'destroy-strongest') {
      const target = [...me.field, ...them.field].filter(isAttacker).sort((a, b) => b.atk - a.atk)[0];
      if (target) total += (them.field.includes(target) ? 1 : -1) * value(target) / 1000;
    }
    if (step.do === 'destroy-backrow') total += (step.side === 'own' ? -0.4 : 0.5) * (step.count === 'all' ? them.backrow.length : Math.min(step.count, them.backrow.length));
    if (step.do === 'atk') total += Math.abs(step.value) / 1000 * 0.6;
    if (step.do === 'special-summon') total += 1;
  }
  return total - (card.cost === 'lp' ? card.costValue / 2000 : card.cost ? 0.3 : 0);
}
