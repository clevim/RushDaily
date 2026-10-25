// IA do rival no Rush Duel (motor do EDOPro). Usa as regras do Rush a seu favor: Invocações-Normais ilimitadas,
// campo de 3 colunas, sem Fase Principal 2 (posições e baixas antes da Batalha) e efeitos de monstro no campo.
// O que não é específico do Rush (anúncios, somas, contadores) cai na IA gulosa do clássico (ocg-ai.mjs).
// Níveis: aprendiz (a IA gulosa do clássico, sem plano), duelista, elite e caos (mais agressiva nas trocas).
import { OcgLocation as L, OcgMessageType as M, OcgPosition as P, OcgResponseType as R } from '../vendor/ocgcore/index.js';
import { decide as greedy } from './ocg-ai.mjs';
import { RUSH_ZONES, TYPE } from './ocg.mjs';

export const AI_LEVELS = ['aprendiz', 'duelista', 'elite', 'caos'];

const isFaceUp = (card) => card && card.position & (P.FACEUP_ATTACK | P.FACEUP_DEFENSE);
const inAttack = (card) => card && card.position & (P.FACEUP_ATTACK | P.FACEDOWN_ATTACK);
const levelOf = (card) => (card?.level ?? 0) & 0xff;
const tributesFor = (level) => (level >= 7 ? 2 : level >= 5 ? 1 : 0);
// Dicas do motor (HINTMSG_*): escolher carta para custo (pior primeiro) ou para ganho (melhor primeiro).
const GAIN_HINTS = new Set([506n, 509n, 518n, 527n, 551n]);

/** Sorteio determinístico guardado na memória (mesma seed, mesmas decisões). */
function chance(memory, p) {
  memory.rng = ((memory.rng ?? 0x9e3779b9) * 1103515245 + 12345) >>> 0;
  return (memory.rng >>> 8) / 16777216 < p;
}

/**
 * Responde `prompt` jogando como `me`. Mesmo contrato do decide() do clássico, mais `level`.
 * view: snapshot() do duelo; cards: Map id -> carta; memory: objeto mantido pelo chamador entre perguntas.
 */
export function decideRush(prompt, context) {
  const level = context.level || 'duelista';
  if (level === 'aprendiz') return greedy(prompt, context);
  const { view, me, cards, state, memory } = context;
  const foe = 1 - me;
  const mine = view[me];
  const theirs = view[foe];
  const caos = level === 'caos';
  const unknown = caos ? 1200 : 1500; // palpite de DEF de um monstro virado
  if (memory.turn !== state.turn) Object.assign(memory, { turn: state.turn, tried: new Set(), target: null, swings: new Map() });
  const data = (code) => cards.get(code) || { atk: 0, def: 0, level: 0, type: 0 };
  const myMonsters = RUSH_ZONES.monsters.map((seq) => mine.monsters[seq]).filter(Boolean);
  const foeMonsters = RUSH_ZONES.monsters.map((seq) => theirs.monsters[seq]).filter(Boolean);
  const freeZones = RUSH_ZONES.monsters.filter((seq) => !mine.monsters[seq]).length;
  // Ameaça: o maior ATK que o rival mostra (virado conta como um palpite médio).
  const threat = Math.max(0, ...foeMonsters.map((card) => (isFaceUp(card) ? card.attack : unknown)));
  // Guarda: quanto é preciso para vencer cada monstro dele em combate.
  const guard = (card) => (isFaceUp(card) ? (inAttack(card) ? card.attack : card.defense) : unknown);
  // Monstro virado em Defesa: atacar não custa o atacante (no pior caso, dano de perfuração ao contrário) e abre o campo.
  const probe = level === 'duelista' ? 1500 : 1000;
  const beats = (atk, card) => atk > guard(card) || (!isFaceUp(card) && !inAttack(card) && atk >= probe)
    || (caos && inAttack(card) && isFaceUp(card) && atk === card.attack && atk >= 1500);
  const key = (action, loc) => `${action}:${loc.code}:${loc.location}:${loc.sequence}`;

  switch (prompt.type) {
    case M.SELECT_IDLECMD: {
      const fresh = (list, action) => list.map((loc, index) => ({ loc, index, action })).filter(({ loc }) => !memory.tried.has(key(action, loc)));
      const take = (choice) => { memory.tried.add(key(choice.action, choice.loc)); return { type: R.SELECT_IDLECMD, action: choice.action, index: choice.index }; };
      // 1. Invocação-Especial (Máximo, efeitos que invocam): a de maior ATK.
      const special = fresh(prompt.special_summons, 1).sort((a, b) => data(b.loc.code).atk - data(a.loc.code).atk)[0];
      if (special) return take(special);
      // 2. Magias da mão ou do campo (inclui Fusão e Magia de Campo). Armadilhas ficam para baixar.
      const spell = fresh(prompt.activates, 5).find(({ loc }) => loc.location !== L.MZONE && !(data(loc.code).type & TYPE.TRAP));
      if (spell) return take(spell);
      // 3. Invocações (ilimitadas no Rush): primeiro os de nível baixo (base para os tributos), depois os de tributo.
      const summons = fresh(prompt.summons, 0).map((item) => ({ ...item, card: data(item.loc.code) }));
      const sets = fresh(prompt.monster_sets, 3);
      const weakest = myMonsters.map((card) => Math.max(card.attack, isFaceUp(card) ? 0 : card.defense)).sort((a, b) => a - b);
      const tribute = summons.filter(({ card }) => tributesFor(levelOf(card)) > 0)
        .filter(({ card }) => {
          const need = tributesFor(levelOf(card));
          const lost = weakest.slice(0, need);
          return lost.length >= need && card.atk > Math.max(...lost) + 300;
        })
        .sort((a, b) => b.card.atk - a.card.atk)[0];
      const lows = summons.filter(({ card }) => !tributesFor(levelOf(card))).sort((a, b) => b.card.atk - a.card.atk);
      // Com monstro de tributo na mão e campo vazio, os baixos sobem mesmo fracos: viram tributo.
      const wantsFodder = summons.some(({ card }) => tributesFor(levelOf(card)) > myMonsters.length);
      if (freeZones > 0) {
        const strong = lows.find(({ card }) => card.atk >= threat || !foeMonsters.length);
        if (strong) return take(strong);
        if (tribute) return take(tribute);
        // Fraco demais para ficar em Ataque: baixa virado em Defesa (bloqueia e serve de tributo).
        const blocker = sets.filter(({ loc }) => !tributesFor(levelOf(data(loc.code)))).sort((a, b) => data(b.loc.code).def - data(a.loc.code).def)[0];
        if (blocker && (wantsFodder || myMonsters.length < 2 || data(blocker.loc.code).def >= threat)) return take(blocker);
        if (lows[0] && wantsFodder) return take(lows[0]);
      } else if (tribute) return take(tribute);
      // 4. Efeitos de monstro (no campo ou na mão) e Magias que ainda sobrarem.
      const effect = fresh(prompt.activates, 5).find(({ loc }) => !(data(loc.code).type & TYPE.TRAP) || loc.location === L.MZONE);
      if (effect) return take(effect);
      // 5. Armadilhas baixadas enquanto houver zona.
      const trap = fresh(prompt.spell_sets, 4).find(({ loc }) => data(loc.code).type & TYPE.TRAP);
      if (trap) return take(trap);
      // 6. Posições: levanta quem vence algo (ou com o campo dele vazio); deita quem só apanharia.
      for (const choice of fresh(prompt.pos_changes, 2)) {
        const card = mine.monsters[choice.loc.sequence];
        if (!card) continue;
        const atk = card.attack ?? data(card.code).atk;
        const canWin = !foeMonsters.length || foeMonsters.some((target) => beats(atk, target));
        if (!inAttack(card) && canWin && (atk >= threat || !foeMonsters.length)) return take(choice);
        if (inAttack(card) && isFaceUp(card) && !canWin && threat > atk && state.turn > 1) return take(choice);
      }
      // 7. Batalha se algum monstro em Ataque tem ataque que valha; senão encerra.
      const attackers = myMonsters.filter((card) => inAttack(card));
      const worth = attackers.some((card) => !foeMonsters.length || foeMonsters.some((target) => beats(card.attack, target)));
      return { type: R.SELECT_IDLECMD, action: prompt.to_bp && (worth || attackers.length) ? 6 : 7, index: null };
    }
    case M.SELECT_BATTLECMD: {
      // Efeitos de Batalha primeiro (uma vez por turno), depois o melhor ataque.
      if (prompt.chains.length && !memory.tried.has('battle-chain')) { memory.tried.add('battle-chain'); return { type: R.SELECT_BATTLECMD, action: 0, index: 0 }; }
      let best = null;
      const live = (loc) => mine.monsters[loc.sequence];
      prompt.attacks.forEach((loc, index) => {
        if ((memory.swings.get(loc.sequence) || 0) >= 2) return;
        const atk = live(loc)?.attack ?? 0;
        if (!foeMonsters.length && loc.can_direct) { if (!best || atk + 10000 > best.score) best = { index, target: null, score: atk + 10000 }; return; }
        for (const target of foeMonsters) {
          if (!beats(atk, target)) continue;
          // Prefere matar o monstro mais forte dele com o atacante mais fraco que dá conta.
          const gain = 2000 + (target.attack || 0) + (inAttack(target) ? atk - guard(target) : 0) - atk / 4;
          if (!best || gain > best.score) best = { index, target, score: gain };
        }
        if (loc.can_direct && foeMonsters.length && (!best || atk > best.score)) best = { index, target: null, score: atk }; // efeito de ataque direto
      });
      if (best) {
        const seq = prompt.attacks[best.index].sequence;
        memory.swings.set(seq, (memory.swings.get(seq) || 0) + 1);
        memory.target = best.target;
        return { type: R.SELECT_BATTLECMD, action: 1, index: best.index };
      }
      return { type: R.SELECT_BATTLECMD, action: prompt.to_m2 ? 2 : 3, index: null };
    }
    case M.SELECT_CHAIN: {
      if (!prompt.selects.length) return { type: R.SELECT_CHAIN, index: null };
      if (prompt.forced) return { type: R.SELECT_CHAIN, index: 0 };
      const chainKey = `chain:${state.phase}:${prompt.selects.map((s) => s.code).join('.')}`;
      if (memory.tried.has(chainKey)) return { type: R.SELECT_CHAIN, index: null };
      memory.tried.add(chainKey);
      // Na vez dele: responde (armadilhas no ataque). Na própria vez: gatilhos dos próprios monstros.
      const reacting = state.active !== me;
      const own = prompt.selects.findIndex((s) => s.location === L.MZONE || s.location === L.HAND);
      if (reacting && (level !== 'duelista' || chance(memory, 0.75))) return { type: R.SELECT_CHAIN, index: 0 };
      return { type: R.SELECT_CHAIN, index: own >= 0 ? own : null };
    }
    case M.SELECT_CARD: {
      const target = memory.target;
      const gain = GAIN_HINTS.has(BigInt(state.hint ?? 0));
      const scored = prompt.selects.map((loc, index) => {
        const live = loc.location === L.MZONE ? view[loc.controller].monsters[loc.sequence] : null;
        const card = data(loc.code);
        const value = live ? Math.max(live.attack, inAttack(live) ? 0 : live.defense) : (card.type & TYPE.MONSTER ? card.atk + levelOf(card) * 50 : 1200);
        const planned = target && loc.controller === foe && loc.location === L.MZONE && loc.sequence === target.sequence;
        // Do rival: o mais forte. Meu: o mais forte se é ganho (buscar, invocar, alvo de bônus); o mais fraco se é custo.
        const score = planned ? 1e9 : loc.controller === foe ? value : gain || loc.location === L.DECK ? value : -value;
        return { index, score };
      }).sort((a, b) => b.score - a.score);
      memory.target = null;
      return { type: R.SELECT_CARD, indicies: scored.slice(0, Math.max(prompt.min, 1)).map((item) => item.index) };
    }
    case M.SELECT_POSITION: {
      const atk = data(prompt.code).atk;
      const order = atk >= threat || !foeMonsters.length ? [P.FACEUP_ATTACK, P.FACEUP_DEFENSE, P.FACEDOWN_DEFENSE] : [P.FACEUP_DEFENSE, P.FACEDOWN_DEFENSE, P.FACEUP_ATTACK];
      return { type: R.SELECT_POSITION, position: order.find((p) => prompt.positions & p) ?? P.FACEUP_ATTACK };
    }
    default:
      return greedy(prompt, context);
  }
}
