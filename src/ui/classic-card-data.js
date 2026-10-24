// Mapeia uma carta clássica (formato do importador) para os dados do yugioh-card.
// Usado pelo navegador (classic-render.js) e pelo Node (tools/classic/render/render.mjs): os dois desenham igual.
export const SCALE = 0.3; // 1394x2031 -> 418x609

const RACES = ['Guerreiro', 'Mago', 'Fada', 'Demônio', 'Zumbi', 'Máquina', 'Aqua', 'Piro', 'Rocha', 'Besta Alada', 'Planta', 'Inseto',
  'Trovão', 'Dragão', 'Besta', 'Besta-Guerreira', 'Dinossauro', 'Peixe', 'Serpente Marinha', 'Réptil', 'Psíquico', 'Besta Divina',
  'Deus Criador', 'Wyrm', 'Ciberso', 'Ilusão'];
const ATTRIBUTE = { 1: 'earth', 2: 'water', 4: 'fire', 8: 'wind', 16: 'light', 32: 'dark', 64: 'divine' };
const T = { MONSTER: 0x1, SPELL: 0x2, TRAP: 0x4, NORMAL: 0x10, EFFECT: 0x20, FUSION: 0x40, RITUAL: 0x80, SPIRIT: 0x200, UNION: 0x400, GEMINI: 0x800, TUNER: 0x1000, SYNCHRO: 0x2000, TOKEN: 0x4000, QUICK: 0x10000, CONTINUOUS: 0x20000, EQUIP: 0x40000, FIELD: 0x80000, COUNTER: 0x100000, FLIP: 0x200000, TOON: 0x400000, XYZ: 0x800000, PENDULUM: 0x1000000, LINK: 0x4000000 };
// Marcadores de Link do motor -> ordem do yugioh-card [cima, cima-dir, dir, baixo-dir, baixo, baixo-esq, esq, cima-esq]
const ARROWS = [[0x080, 1], [0x100, 2], [0x020, 3], [0x004, 4], [0x002, 5], [0x001, 6], [0x008, 7], [0x040, 8]];

// Rótulos de Magia/Armadilha em PT (a biblioteca só traz en/jp/zh/kr). Chamar uma vez com a classe YugiohCard.
export function patchSpellTrapLabel(YugiohCard) {
  Object.defineProperty(YugiohCard.prototype, 'spellTrapName', { get() { return this.data.type === 'spell' ? 'Carta Mágica' : 'Carta de Armadilha'; } });
}

function monsterLine(card) {
  const t = card.type;
  const race = RACES[Math.log2(Number(card.race) || 1)] || '';
  const tags = [race];
  for (const [bit, label] of [[T.FUSION, 'Fusão'], [T.RITUAL, 'Ritual'], [T.SYNCHRO, 'Sincro'], [T.XYZ, 'Xyz'], [T.LINK, 'Link']]) if (t & bit) tags.push(label);
  for (const [bit, label] of [[T.TUNER, 'Regulador'], [T.FLIP, 'Virar'], [T.TOON, 'Toon'], [T.SPIRIT, 'Espírito'], [T.UNION, 'União'], [T.GEMINI, 'Gêmeo'], [T.PENDULUM, 'Pêndulo']]) if (t & bit) tags.push(label);
  if (t & T.EFFECT) tags.push('Efeito');
  else if (t & T.NORMAL && !(t & T.TOKEN)) tags.push('Normal');
  return tags.join('/');
}

// Texto longo: encolhe a fonte antes da compressão da biblioteca, que sozinha deixa o texto passar de ATK/DEF ou cortar o 2º efeito.
// Cada quebra de linha (efeitos com marcador) gasta uma linha inteira, por isso pesa como ~40 caracteres.
// Magias e Armadilhas têm a caixa de texto mais alta e aguentam mais texto.
export function descriptionZoom(card) {
  const cost = String(card.desc || '').length + 40 * (String(card.desc || '').match(/\n/g) || []).length;
  const steps = card.type & (T.SPELL | T.TRAP) ? [[1000, 0.7], [800, 0.8], [650, 0.9]] : [[800, 0.65], [650, 0.72], [500, 0.8], [400, 0.9]];
  return steps.find(([limit]) => cost > limit)?.[1] ?? 1;
}

// image: URL ou data URL da arte da carta.
export function cardData(card, image) {
  const t = card.type;
  const level = card.level & 0xff;
  const base = { language: 'en', name: card.name, password: String(card.id).padStart(8, '0'), description: card.desc, descriptionZoom: descriptionZoom(card), radius: true, scale: SCALE, image };
  if (t & (T.SPELL | T.TRAP)) {
    const icon = [[T.QUICK, 'quick-play'], [T.CONTINUOUS, 'continuous'], [T.EQUIP, 'equip'], [T.FIELD, 'field'], [T.COUNTER, 'counter'], [T.RITUAL, 'ritual']].find(([bit]) => t & bit)?.[1] || '';
    return { ...base, type: t & T.SPELL ? 'spell' : 'trap', icon, attribute: '' };
  }
  const cardType = t & T.TOKEN ? 'token' : t & T.LINK ? 'link' : t & T.XYZ ? 'xyz' : t & T.SYNCHRO ? 'synchro' : t & T.FUSION ? 'fusion' : t & T.RITUAL ? 'ritual' : t & T.EFFECT ? 'effect' : 'normal';
  const stat = (value) => (value < 0 ? -1 : value);
  return {
    ...base,
    type: t & T.PENDULUM ? 'pendulum' : 'monster',
    cardType,
    attribute: ATTRIBUTE[card.attribute] || '',
    level: cardType === 'xyz' || cardType === 'link' ? 0 : level,
    rank: cardType === 'xyz' ? level : 0,
    pendulumScale: (card.level >> 24) & 0xff,
    monsterType: monsterLine(card),
    atk: stat(card.atk),
    def: cardType === 'link' ? level : stat(card.def),
    arrowList: cardType === 'link' ? ARROWS.filter(([bit]) => card.def & bit).map(([, n]) => n) : [],
  };
}
