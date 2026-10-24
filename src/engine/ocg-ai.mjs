// IA gulosa para o motor clássico: responde qualquer pergunta do ocgcore com uma regra simples.
// ponytail: sem busca ainda; a fase 4 troca decide() por simulação (o motor é determinístico e rápido).
import { cardMatchesOpcode, OcgLocation as L, OcgMessageType as M, OcgPosition as P, OcgResponseType as R } from '../vendor/ocgcore/index.js';
import { toCoreCard } from './ocg.mjs';

/** Os `count` primeiros bits ligados de `available` (Tipos e Atributos a declarar). */
function firstBits(available, count, big = false) {
  const out = [];
  for (let bit = 0; bit < 64 && out.length < count; bit += 1) {
    if (big ? (BigInt(available) >> BigInt(bit)) & 1n : (available >>> bit) & 1) out.push(big ? 1n << BigInt(bit) : 1 << bit);
  }
  return out;
}

const ATTACK = P.FACEUP_ATTACK;
const isFaceUp = (card) => card && card.position & (P.FACEUP_ATTACK | P.FACEUP_DEFENSE);
const inAttack = (card) => card && card.position & (P.FACEUP_ATTACK | P.FACEDOWN_ATTACK);
// Valor visível de um monstro para o lado `viewer`: carta virada do oponente vale um palpite médio.
const UNKNOWN_DEF = 1500;
const power = (card) => (card ? Math.max(card.attack || 0, inAttack(card) ? 0 : card.defense || 0) : 0);

function freePlaces(mask, player, count, mine = true) {
  const out = [];
  const sides = mine ? [[0, player], [1, 1 - player]] : [[1, 1 - player], [0, player]];
  for (const [side, owner] of sides) {
    for (const [location, offset, size] of [[L.MZONE, 0, 7], [L.SZONE, 8, 8]]) {
      for (let seq = 0; seq < size && out.length < count; seq += 1) if (!(mask & (1 << (offset + seq + side * 16)))) out.push({ player: owner, location, sequence: seq });
    }
  }
  return out;
}

/** Combinação de índices cuja soma (níveis) fecha a conta pedida. */
function sumPick(prompt) {
  const level = (card) => card.amount & 0xffff;
  const alt = (card) => card.amount >>> 16;
  const need = prompt.amount - prompt.selects_must.reduce((sum, card) => sum + level(card), 0);
  const n = Math.min(prompt.selects.length, 14);
  for (let mask = 1; mask < 1 << n; mask += 1) {
    const idx = [];
    let sum = 0;
    let sumAlt = 0;
    for (let i = 0; i < n; i += 1) if (mask & (1 << i)) { idx.push(i); sum += level(prompt.selects[i]); sumAlt += alt(prompt.selects[i]) || level(prompt.selects[i]); }
    if (prompt.select_max ? sum >= need : sum === need || sumAlt === need) return idx;
  }
  return [0];
}

/**
 * Decide a resposta para `prompt`, jogando como `me`.
 * view: snapshot() do duelo; cards: Map id -> carta do pool; memory: objeto mantido pelo chamador entre perguntas.
 */
export function decide(prompt, { view, me, cards, state, memory }) {
  const foe = 1 - me;
  const mine = view[me];
  const theirs = view[foe];
  const enemyMonsters = theirs.monsters.filter(Boolean);
  const strongest = Math.max(0, ...enemyMonsters.map((card) => (isFaceUp(card) ? power(card) : UNKNOWN_DEF)));
  const atkOf = (loc) => cards.get(loc.code)?.atk ?? 0;
  if (memory.turn !== state.turn) Object.assign(memory, { turn: state.turn, tried: new Set(), target: null, swings: new Map() });

  switch (prompt.type) {
    case M.SELECT_IDLECMD: {
      const fresh = (list, action) => list.map((loc, index) => ({ loc, index, action })).filter(({ loc, action: a }) => !memory.tried.has(`${a}:${loc.code}:${loc.location}:${loc.sequence}`));
      const take = (choice) => { memory.tried.add(`${choice.action}:${choice.loc.code}:${choice.loc.location}:${choice.loc.sequence}`); return { type: R.SELECT_IDLECMD, action: choice.action, index: choice.index }; };
      const special = fresh(prompt.special_summons, 1).sort((a, b) => atkOf(b.loc) - atkOf(a.loc))[0];
      if (special) return take(special);
      // Magias primeiro (podem limpar o campo antes de invocar); armadilhas ficam para baixar.
      const spell = fresh(prompt.activates, 5).find(({ loc }) => loc.location !== L.MZONE && !(cards.get(loc.code)?.type & 0x4));
      if (spell) return take(spell);
      const summon = fresh(prompt.summons, 0).sort((a, b) => atkOf(b.loc) - atkOf(a.loc))[0];
      if (summon && (atkOf(summon.loc) >= strongest || !prompt.monster_sets.length)) return take(summon);
      if (prompt.monster_sets.length && !memory.tried.has('set-monster')) {
        memory.tried.add('set-monster');
        const best = prompt.monster_sets.map((loc, index) => ({ loc, index, def: cards.get(loc.code)?.def ?? 0 })).sort((a, b) => b.def - a.def)[0];
        return { type: R.SELECT_IDLECMD, action: 3, index: best.index };
      }
      const effect = fresh(prompt.activates, 5)[0];
      if (effect) return take(effect);
      const trap = fresh(prompt.spell_sets, 4).find(({ loc }) => cards.get(loc.code)?.type & 0x4) || fresh(prompt.spell_sets, 4).find(({ loc }) => cards.get(loc.code)?.type & 0x10000);
      if (trap) return take(trap); // armadilhas e magias rápidas viram cartas baixadas
      // Muda para ataque quem pode vencer algo.
      const flip = fresh(prompt.pos_changes, 2).find(({ loc }) => !inAttack(mine.monsters[loc.sequence]) && (mine.monsters[loc.sequence]?.attack ?? 0) > strongest);
      if (flip) return take(flip);
      return { type: R.SELECT_IDLECMD, action: prompt.to_bp && mine.monsters.some(inAttack) ? 6 : 7, index: null };
    }
    case M.SELECT_BATTLECMD: {
      let best = null;
      prompt.attacks.forEach((loc, index) => {
        // Ataque cancelado ou repetido por efeito: no máximo 2 tentativas por monstro no turno.
        if ((memory.swings.get(loc.sequence) || 0) >= 2) return;
        const attacker = mine.monsters[loc.sequence];
        const atk = attacker?.attack ?? 0;
        if (loc.can_direct && !enemyMonsters.length) { best = best && best.score >= atk + 10000 ? best : { index, target: null, score: atk + 10000 }; return; }
        for (const target of enemyMonsters) {
          const guard = isFaceUp(target) ? (inAttack(target) ? target.attack : target.defense) : UNKNOWN_DEF;
          const gain = atk > guard ? 1000 + (inAttack(target) ? atk - guard : 0) + (target.attack || 0) / 10 : atk === guard && inAttack(target) && (target.attack || 0) > 1500 ? 200 : -1;
          if (gain > 0 && (!best || gain > best.score)) best = { index, target, score: gain };
        }
        if (loc.can_direct && (!best || atk > best.score)) best = { index, target: null, score: atk };
      });
      if (best) {
        const seq = prompt.attacks[best.index].sequence;
        memory.swings.set(seq, (memory.swings.get(seq) || 0) + 1);
        memory.target = best.target;
        return { type: R.SELECT_BATTLECMD, action: 1, index: best.index };
      }
      if (prompt.chains.length && !memory.tried.has('battle-chain')) { memory.tried.add('battle-chain'); return { type: R.SELECT_BATTLECMD, action: 0, index: 0 }; }
      return { type: R.SELECT_BATTLECMD, action: prompt.to_m2 ? 2 : 3, index: null };
    }
    case M.SELECT_CHAIN: {
      if (!prompt.selects.length) return { type: R.SELECT_CHAIN, index: null };
      if (prompt.forced) return { type: R.SELECT_CHAIN, index: 0 };
      // Reage na vez do oponente; na própria vez só encadeia o que for gatilho do próprio monstro.
      const reacting = state.active !== me;
      const key = `chain:${state.phase}:${prompt.selects.map((s) => s.code).join('.')}`;
      if ((reacting || prompt.selects.some((s) => s.location === L.MZONE)) && !memory.tried.has(key)) { memory.tried.add(key); return { type: R.SELECT_CHAIN, index: 0 }; }
      return { type: R.SELECT_CHAIN, index: null };
    }
    case M.SELECT_EFFECTYN: return { type: R.SELECT_EFFECTYN, yes: true };
    case M.SELECT_YESNO: return { type: R.SELECT_YESNO, yes: true };
    case M.SELECT_OPTION: return { type: R.SELECT_OPTION, index: 0 };
    case M.SELECT_CARD: case M.SELECT_TRIBUTE: {
      const target = memory.target;
      const scored = prompt.selects.map((loc, index) => {
        const live = loc.location === L.MZONE ? view[loc.controller].monsters[loc.sequence] : null;
        const value = live ? power(live) : cards.get(loc.code)?.atk ?? 500;
        // Alvo planejado no ataque vem primeiro; carta do oponente: a mais forte; minha: a mais fraca (custo).
        const planned = target && loc.controller === foe && loc.location === L.MZONE && loc.sequence === target.sequence;
        return { index, score: planned ? 1e9 : loc.controller === foe ? value : -value };
      }).sort((a, b) => b.score - a.score);
      memory.target = null;
      const count = Math.max(prompt.min, 1);
      const response = scored.slice(0, count).map((item) => item.index);
      return prompt.type === M.SELECT_CARD ? { type: R.SELECT_CARD, indicies: response } : { type: R.SELECT_TRIBUTE, indicies: response };
    }
    case M.SELECT_UNSELECT_CARD:
      return { type: R.SELECT_UNSELECT_CARD, index: prompt.can_finish || !prompt.select_cards.length ? null : 0 };
    case M.SELECT_PLACE: return { type: R.SELECT_PLACE, places: freePlaces(prompt.field_mask, prompt.player, prompt.count || 1) };
    case M.SELECT_DISFIELD: return { type: R.SELECT_DISFIELD, places: freePlaces(prompt.field_mask, prompt.player, prompt.count || 1, false) };
    case M.SELECT_POSITION: {
      const atk = cards.get(prompt.code)?.atk ?? 0;
      const order = atk >= strongest ? [ATTACK, P.FACEUP_DEFENSE, P.FACEDOWN_DEFENSE] : [P.FACEDOWN_DEFENSE, P.FACEUP_DEFENSE, ATTACK];
      return { type: R.SELECT_POSITION, position: order.find((p) => prompt.positions & p) ?? ATTACK };
    }
    case M.SELECT_SUM: return { type: R.SELECT_SUM, indicies: sumPick(prompt) };
    case M.SELECT_COUNTER: { let left = prompt.count; return { type: R.SELECT_COUNTER, counters: prompt.cards.map((card) => { const take = Math.min(left, card.count ?? left); left -= take; return take; }) }; }
    case M.SORT_CARD: case M.SORT_CHAIN: return { type: R.SORT_CARD, order: null };
    case M.ANNOUNCE_NUMBER: return { type: R.ANNOUNCE_NUMBER, value: prompt.options.length - 1 }; // índice: o maior número
    case M.ANNOUNCE_RACE: return { type: R.ANNOUNCE_RACE, races: firstBits(prompt.available, prompt.count, true) };
    case M.ANNOUNCE_ATTRIB: return { type: R.ANNOUNCE_ATTRIB, attributes: firstBits(prompt.available, prompt.count) };
    case M.ANNOUNCE_CARD: {
      // Declara a carta mais popular que cumpre a regra do efeito (ex.: "declare um monstro de Efeito").
      const valid = [...cards.values()].filter((card) => card.name && cardMatchesOpcode(toCoreCard(card), prompt.opcodes));
      const best = valid.sort((a, b) => (b.pop || 0) - (a.pop || 0))[0];
      return { type: R.ANNOUNCE_CARD, card: best?.id ?? 0 };
    }
    case M.ROCK_PAPER_SCISSORS: return { type: R.ROCK_PAPER_SCISSORS, value: 1 + (state.turn % 3) };
    default: return null;
  }
}
