// Carta clássica desenhada em HTML/CSS (moldura por tipo + arte recortada + texto PT-BR).
// ponytail: provisório até a fase 5 (cartas renderizadas em imagem); serve para mesa e zoom.
import { TYPE } from '../engine/ocg.mjs';
import { RACES } from '../data/classic/strings-pt.mjs';
import { classicImg } from './classic-render.js';

export function frameOf(card) {
  const t = card.type;
  if (t & TYPE.SPELL) return 'spell';
  if (t & TYPE.TRAP) return 'trap';
  if (t & TYPE.TOKEN) return 'token';
  if (t & TYPE.LINK) return 'link';
  if (t & TYPE.XYZ) return 'xyz';
  if (t & TYPE.SYNCHRO) return 'synchro';
  if (t & TYPE.FUSION) return 'fusion';
  if (t & TYPE.RITUAL) return 'ritual';
  if (t & TYPE.EFFECT) return 'effect';
  return 'normal';
}

const SUBTYPE = [[0x10000, 'Rápida'], [0x20000, 'Contínua'], [0x40000, 'Equipamento'], [0x80000, 'de Campo'], [0x100000, 'de Resposta'], [TYPE.RITUAL, 'de Ritual']];
export function raceOf(card) {
  const index = Math.log2(Number(card.race) || 1);
  return RACES[index] || '';
}
export function kindLabel(card) {
  if (card.type & (TYPE.SPELL | TYPE.TRAP)) {
    const sub = SUBTYPE.find(([bit]) => card.type & bit)?.[1];
    return `${card.type & TYPE.SPELL ? 'Magia' : 'Armadilha'}${sub ? ` ${sub}` : ''}`;
  }
  const tags = [raceOf(card), frameOf(card) === 'normal' ? 'Normal' : { effect: 'Efeito', fusion: 'Fusão', ritual: 'Ritual', synchro: 'Sincro', xyz: 'Xyz', link: 'Link', token: 'Ficha' }[frameOf(card)]];
  if (card.type & 0x1000) tags.push('Regulador');
  if (card.type & TYPE.PENDULUM) tags.push('Pêndulo');
  return tags.filter(Boolean).join(' / ');
}

const isMonster = (card) => card.type & TYPE.MONSTER;

/**
 * Frente da carta: a imagem oficial desenhada em PT (tools/classic/render).
 * live: dados atuais do motor; num monstro no campo mostra a faixa de ATK/DEF (verde/vermelho se mudou).
 */
export function cardFace(card, { live = null } = {}) {
  let stats = '';
  if (live && isMonster(card) && !(card.type & TYPE.LINK)) {
    const tone = (now, base) => (now > base ? 'up' : now < base ? 'down' : '');
    stats = `<span class="live-stats"><b class="${tone(live.attack, card.atk)}">${live.attack}</b><b class="${tone(live.defense, card.def)}">${live.defense}</b></span>`;
  } else if (live && card.type & TYPE.LINK) {
    stats = `<span class="live-stats"><b class="${live.attack > card.atk ? 'up' : live.attack < card.atk ? 'down' : ''}">${live.attack}</b><b>L${card.level & 0xff}</b></span>`;
  }
  return `<span class="ycard">${classicImg(card, 'loading="lazy"')}${stats}</span>`;
}

/** Linha de dados do zoom: "Nível 4 · Guerreiro/Efeito · ATK 1800 / DEF 1000". */
export function cardStats(card, live = null) {
  if (!isMonster(card)) return kindLabel(card);
  const level = card.level & 0xff;
  const tier = card.type & TYPE.LINK ? `Link ${level}` : card.type & TYPE.XYZ ? `Classe ${level}` : `Nível ${level}`;
  const atk = live?.attack ?? card.atk;
  const def = live?.defense ?? card.def;
  return `${tier} · ${kindLabel(card)} · ATK ${atk < 0 ? '?' : atk}${card.type & TYPE.LINK ? '' : ` / DEF ${def < 0 ? '?' : def}`}`;
}

export const cardBack = () => '<span class="ycard back" aria-hidden="true"><img src="src/assets/card-back.svg" alt="" draggable="false"></span>';
