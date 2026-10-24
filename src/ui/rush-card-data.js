// Mapeia uma carta Rush (src/data/rush/cards.json) para os dados do RushDuelCard (yugioh-card).
// Usado pelo navegador (rush-render.js) e pelo Node (tools/rush/render.mjs): os dois desenham igual.
import { RACES as CLASSIC_RACES } from '../data/classic/strings-pt.mjs';

export const SCALE = 0.3; // 1394x2031 -> 418x609
// Tipos do Rush depois de Ilusão (bits 26 a 31 do EDOPro).
export const RACES = [...CLASSIC_RACES, 'Ciborgue', 'Cavaleiro Mágico', 'Grão-Dragão', 'Psíquico Ômega', 'Guerreiro Celestial', 'Galáxia'];
const ATTRIBUTE = { 1: 'earth', 2: 'water', 4: 'fire', 8: 'wind', 16: 'light', 32: 'dark', 64: 'divine' };
const T = { MONSTER: 0x1, SPELL: 0x2, TRAP: 0x4, NORMAL: 0x10, EFFECT: 0x20, FUSION: 0x40, RITUAL: 0x80, MAXIMUM: 0x8000, QUICK: 0x10000, CONTINUOUS: 0x20000, EQUIP: 0x40000, FIELD: 0x80000, COUNTER: 0x100000 };
const ICONS = [[T.QUICK, 'quick-play', 'Rápida'], [T.CONTINUOUS, 'continuous', 'Contínua'], [T.EQUIP, 'equip', 'Equipamento'], [T.FIELD, 'field', 'Campo'], [T.COUNTER, 'counter', 'Resposta'], [T.RITUAL, 'ritual', 'Ritual']];
const LABEL = Object.fromEntries(ICONS.map(([, icon, label]) => [icon, label]));

// Estilo latino (a biblioteca só traz chinês e japonês para o Rush): fontes Matrix/Stone do yugioh-card, só os números do rd-atk-def.
const STYLE = {
  name: { fontFamily: 'ygo-en-name', top: 64, fontSize: 128, letterSpacing: 1 },
  spellTrap: { fontFamily: 'ygo-en-race', top: 1468, fontSize: 60, fontWeight: 'normal', letterSpacing: 1, icon: { marginTop: 4, marginLeft: 8, marginRight: 10 } },
  effect: { fontFamily: 'ygo-en-race', top: 1468, fontSize: 60, fontWeight: 'normal', letterSpacing: 1 },
  description: { fontFamily: 'ygo-en', top: 1552, fontSize: 46, lineHeight: 1.08 },
};

/**
 * Ajusta o RushDuelCard para o português (chamar uma vez com a classe): estilo latino, rótulos de Magia/Armadilha
 * e colchetes [ ] no lugar de 【 】, que as fontes latinas não têm.
 */
export function patchRushCard(RushDuelCard) {
  const proto = RushDuelCard.prototype;
  if (proto.__rushdaily) return;
  proto.__rushdaily = true;
  Object.defineProperty(proto, 'style', { get() { return STYLE; } });
  Object.defineProperty(proto, 'spellTrapName', {
    get() { return `${this.data.type === 'spell' ? 'Carta Mágica' : 'Carta de Armadilha'}${this.data.icon ? `/${LABEL[this.data.icon]}` : ''}`; },
  });
  const drawSpellTrap = proto.drawSpellTrap;
  proto.drawSpellTrap = function () {
    drawSpellTrap.call(this);
    const [open, icon, close] = this.spellTrapLeaf.children;
    const { icon: gap } = STYLE.spellTrap;
    open.text = `[${this.spellTrapName}`;
    icon.x = open.x + open.bounds.width + (this.data.icon ? gap.marginLeft : 0);
    close.text = ']';
    close.x = icon.x + (this.data.icon ? 60 + gap.marginRight : 0);
  };
  // Atributo com o nome em inglês (LIGHT, TRAP...), o mesmo ícone das cartas clássicas, no tamanho do círculo do Rush.
  Object.defineProperty(proto, 'attributeUrl', {
    get() {
      const name = this.data.type === 'monster' ? this.data.attribute : this.data.type;
      return name ? `${this.resourcePath}/yugioh/image/attribute-${name}-en.png` : '';
    },
  });
  const drawAttribute = proto.drawAttribute;
  proto.drawAttribute = function () {
    drawAttribute.call(this);
    this.attributeLeaf.set({ width: 178, height: 178, x: 1142, y: 72 });
  };
  const drawEffect = proto.drawEffect;
  proto.drawEffect = function () {
    drawEffect.call(this);
    this.effectLeaf.text = `[${this.data.monsterType}]`;
  };
}

function monsterLine(card) {
  const t = card.type;
  const tags = [RACES[Math.log2(Number(card.race) || 1)] || ''];
  if (t & T.MAXIMUM) tags.push('Máximo');
  if (t & T.FUSION) tags.push('Fusão');
  if (t & T.RITUAL) tags.push('Ritual');
  if (t & T.EFFECT) tags.push('Efeito');
  else if (t & T.NORMAL) tags.push('Normal');
  return tags.filter(Boolean).join('/');
}

// "[REQUIREMENT]\ntexto" -> "[REQUIREMENT] texto", como nas cartas impressas; o "MAXIMUM ATK = N" vira o selo ATK MAX.
export function rushDescription(card) {
  return String(card.desc || '')
    .replace(/^MAXIMUM ATK = \d+\n?/m, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/^(\[[^\]\n]{2,30}\])\n/gm, '$1 ')
    .trim();
}

export const maximumAtk = (card) => (card.maximum === 'C' && Number(/MAXIMUM ATK = (\d+)/.exec(card.desc || '')?.[1])) || 0;

// Texto longo: encolhe a fonte antes da compressão da biblioteca (cada quebra de linha gasta uma linha inteira, ~45 caracteres).
export function descriptionZoom(text) {
  const cost = text.length + 45 * (text.match(/\n/g) || []).length;
  return [[620, 0.72], [520, 0.8], [430, 0.88], [360, 0.94]].find(([limit]) => cost > limit)?.[1] ?? 1;
}

// Cor de cada atributo/tipo no quadro sem arte: [centro, borda].
const TONES = {
  earth: ['#7a5a32', '#24170b'], water: ['#2f6f9e', '#0b1a2b'], fire: ['#b2402c', '#2d0c07'], wind: ['#3f8a52', '#0c2414'],
  light: ['#c79a2e', '#3a2706'], dark: ['#5b3b86', '#160c26'], divine: ['#c9a646', '#33260a'], spell: ['#1f8a7a', '#06231f'], trap: ['#a3366f', '#2a0a1c'],
};

/** Quadro da arte quando ela ainda não foi baixada: feltro no tom do atributo, com o selo dourado do verso. */
export function placeholderArt(card) {
  const kind = card.type & T.SPELL ? 'spell' : card.type & T.TRAP ? 'trap' : ATTRIBUTE[card.attribute] || 'dark';
  const [mid, edge] = TONES[kind];
  const rays = Array.from({ length: 24 }, (_, i) => `<path d="M200 200 L${(200 + 300 * Math.cos((i * Math.PI) / 12 - 0.03)).toFixed(1)} ${(200 + 300 * Math.sin((i * Math.PI) / 12 - 0.03)).toFixed(1)} L${(200 + 300 * Math.cos((i * Math.PI) / 12 + 0.03)).toFixed(1)} ${(200 + 300 * Math.sin((i * Math.PI) / 12 + 0.03)).toFixed(1)}Z"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><defs>`
    + `<radialGradient id="f" cx=".5" cy=".46" r=".75"><stop offset="0" stop-color="${mid}"/><stop offset="1" stop-color="${edge}"/></radialGradient>`
    + '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe7a0"/><stop offset=".3" stop-color="#e9a51c"/><stop offset=".6" stop-color="#8e560c"/><stop offset="1" stop-color="#f3b62a"/></linearGradient>'
    + '<pattern id="w" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0V8" stroke="#000" stroke-opacity=".18" stroke-width="2"/></pattern></defs>'
    + '<rect width="400" height="400" fill="url(#f)"/><rect width="400" height="400" fill="url(#w)"/>'
    + `<g fill="#ffd36a" fill-opacity=".08">${rays}</g>`
    + '<g fill="none" stroke="#f3b62a"><circle cx="200" cy="200" r="118" stroke-opacity=".22" stroke-width="1.5"/><circle cx="200" cy="200" r="150" stroke-opacity=".12" stroke-width="1.5"/></g>'
    + '<path d="M200 112 288 200 200 288 112 200Z" fill="none" stroke="url(#g)" stroke-width="5"/>'
    + '<path d="M200 140 260 200 200 260 140 200Z" fill="url(#g)" fill-opacity=".28"/>'
    + '<path d="M200 168 232 200 200 232 168 200Z" fill="url(#g)" fill-opacity=".75"/></svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// image: URL ou data URL da arte (sem arte: placeholderArt).
export function rushCardData(card, image) {
  const t = card.type;
  const description = rushDescription(card);
  const base = { language: 'pt', name: card.name, description, descriptionZoom: descriptionZoom(description), legend: !!card.legend, radius: true, scale: SCALE, image: image || placeholderArt(card), color: '', package: '', laser: '', rare: '' };
  if (t & (T.SPELL | T.TRAP)) {
    const icon = ICONS.find(([bit]) => t & bit)?.[1] || '';
    return { ...base, type: t & T.SPELL ? 'spell' : 'trap', icon, attribute: '', level: 0, monsterType: '', maximumAtk: 0, atk: 0, def: 0 };
  }
  const cardType = t & T.FUSION ? 'fusion' : t & T.RITUAL ? 'ritual' : t & T.EFFECT ? 'effect' : 'normal';
  const stat = (value) => (value < 0 ? -1 : value);
  return {
    ...base,
    type: 'monster',
    cardType,
    icon: '',
    attribute: ATTRIBUTE[card.attribute] || '',
    level: card.level & 0xff,
    monsterType: monsterLine(card),
    maximumAtk: maximumAtk(card),
    atk: stat(card.atk),
    def: stat(card.def),
  };
}
