// Texto das cartas Rush (cards.json) em PT: tipo de carta e a linha de dados da leitura (arena e home).
import { TYPE } from '../engine/ocg.mjs';
import { ATTRIBUTES, RACES } from '../data/classic/strings-pt.mjs';

export const isMonster = (card) => Boolean(card.type & TYPE.MONSTER);
export const raceOf = (card) => RACES[Math.log2(Number(card.race) || 1)] || '';

/** "Dragão / Efeito", "Magia de Campo", "Armadilha". */
export function kindLabel(card) {
  if (card.skill) return 'Skill';
  if (card.type & TYPE.SPELL) return `Magia${card.type & 0x80000 ? ' de Campo' : card.type & 0x40000 ? ' de Equipamento' : card.type & TYPE.RITUAL ? ' de Ritual' : ''}`;
  if (card.type & TYPE.TRAP) return 'Armadilha';
  const kind = card.maximum ? 'Máximo' : card.type & TYPE.FUSION ? 'Fusão' : card.type & TYPE.RITUAL ? 'Ritual' : card.type & TYPE.EFFECT ? 'Efeito' : 'Normal';
  return [raceOf(card), kind].filter(Boolean).join(' / ');
}

/** "Nível 4 · Dragão / Efeito · TREVAS · ATK 1800 / DEF 1000" (com os valores atuais do campo, se houver). */
export function cardStats(card, live = null) {
  if (!isMonster(card)) return `${kindLabel(card)}${card.legend ? ' · LENDA' : ''}`;
  const atk = live?.attack ?? card.atk;
  const def = live?.defense ?? card.def;
  return `Nível ${card.level & 0xff} · ${kindLabel(card)} · ${ATTRIBUTES[card.attribute] || ''}${card.legend ? ' · LENDA' : ''} · ATK ${atk < 0 ? '?' : atk} / DEF ${def < 0 ? '?' : def}`;
}
