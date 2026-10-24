// Compartilhar: link de replay do duelo clássico e grade de emojis do desafio Rush.
// Sem DOM: roda no navegador e no Node (testes).

/* ---------- Replay clássico: JSON -> deflate -> base64url (vai no # do link) ---------- */

const MAX_LINK = 400_000; // caracteres do código no link
const MAX_JSON = 4_000_000; // bytes depois de descomprimir (bomba de compressão para aqui)
const MAX_RESPONSES = 30_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function toBase64url(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function fromBase64url(text) {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** data: { v, kind: 'duel'|'puzzle', seed, me, decks?, puzzle?, day?, label, date, responses } -> código para o link. */
export async function encodeReplay(data) {
  const json = JSON.stringify(data, (key, value) => (typeof value === 'bigint' ? `${value}n` : value)); // Tipos declarados são BigInt
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return toBase64url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function inflate(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_JSON) { reader.cancel(); throw new Error('grande demais'); }
    parts.push(value);
  }
  return new TextDecoder().decode(await new Blob(parts).arrayBuffer());
}

const isInt = (value) => Number.isSafeInteger(value);
const ints = (list, max) => Array.isArray(list) && list.length <= max && list.every(isInt);
const RESPONSE_KEYS = ['action', 'index', 'indicies', 'yes', 'position', 'places', 'counters', 'order', 'value', 'races', 'attributes', 'card'];

/** Copia só o que uma resposta do motor pode ter; qualquer outra coisa invalida o replay. */
function cleanResponse(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || !isInt(item.type) || item.type < 0 || item.type > 64) return null;
  const out = { type: item.type };
  for (const [key, value] of Object.entries(item)) {
    if (key === 'type') continue;
    if (!RESPONSE_KEYS.includes(key)) return null;
    if (value === null || typeof value === 'boolean' || isInt(value)) out[key] = value;
    else if (key === 'races' && Array.isArray(value) && value.length <= 32 && value.every((bit) => /^\d{1,20}n$/.test(bit))) out[key] = value.map((bit) => BigInt(bit.slice(0, -1)));
    else if (key === 'places' && Array.isArray(value) && value.length <= 16 && value.every((place) => place && isInt(place.player) && isInt(place.location) && isInt(place.sequence))) out[key] = value.map(({ player, location, sequence }) => ({ player, location, sequence }));
    else if (Array.isArray(value) && ints(value, 64)) out[key] = [...value];
    else return null;
  }
  return out;
}

/** Valida e limpa um replay já decodificado. Devolve null se algo não bater (entrada não confiável). */
export function cleanReplay(data) {
  if (!data || typeof data !== 'object' || data.v !== 1) return null;
  const text = (value, max) => typeof value === 'string' && value.length <= max;
  if (!text(data.seed, 160) || ![0, 1].includes(data.me) || !text(data.label ?? '', 80) || !(typeof data.date === 'string' && DATE.test(data.date))) return null;
  if (!Array.isArray(data.responses) || data.responses.length > MAX_RESPONSES) return null;
  const responses = data.responses.map(cleanResponse);
  if (responses.includes(null)) return null;
  const base = { v: 1, kind: data.kind, seed: data.seed, me: data.me, label: data.label || '', date: data.date, responses };
  if (data.kind === 'puzzle') {
    if (!(typeof data.puzzle === 'string' && /^[a-z0-9-]{1,64}$/.test(data.puzzle))) return null;
    return { ...base, puzzle: data.puzzle };
  }
  if (data.kind !== 'duel' || !Array.isArray(data.decks) || data.decks.length !== 2) return null;
  const decks = data.decks.map((deck) => (deck && ints(deck.main, 60) && ints(deck.extra ?? [], 15) ? { main: [...deck.main], extra: [...(deck.extra || [])] } : null));
  return decks.includes(null) ? null : { ...base, decks };
}

/** Código do link -> replay limpo, ou null. */
export async function decodeReplay(code) {
  if (typeof code !== 'string' || !code || code.length > MAX_LINK || !/^[A-Za-z0-9_-]+$/.test(code)) return null;
  try {
    return cleanReplay(JSON.parse(await inflate(fromBase64url(code))));
  } catch {
    return null;
  }
}

/* ---------- Grade do desafio Rush (estilo Wordle, sem revelar cartas) ---------- */

export const GRID = { dealt: '🟩', taken: '🟥', both: '🟨', none: '⬛', win: '⭐' };

/**
 * Um quadrado por turno a partir dos PV de cada turno ([você, rival] no fim do turno; buraco = nada mudou).
 * { date, difficulty, rating, outcome: 'win'|'loss'|'draw', turns, start: [você, rival], lpByTurn }
 */
export function resultGrid({ date, difficulty, rating, outcome, turns, start, lpByTurn = [] }) {
  const squares = [];
  let last = start;
  for (let turn = 1; turn <= turns; turn += 1) {
    const now = lpByTurn[turn] || last;
    const dealt = now[1] < last[1];
    const taken = now[0] < last[0];
    squares.push(dealt && taken ? GRID.both : dealt ? GRID.dealt : taken ? GRID.taken : GRID.none);
    last = now;
  }
  if (outcome === 'win') squares.push(GRID.win);
  const rows = [];
  for (let at = 0; at < squares.length; at += 5) rows.push(squares.slice(at, at + 5).join(''));
  const [, month, day] = date.split('-');
  const label = { win: 'Vitória', loss: 'Derrota', draw: 'Empate' }[outcome];
  return [`RushDaily ${day}/${month} · ${difficulty} ${'★'.repeat(rating)}${'☆'.repeat(Math.max(0, 4 - rating))}`, `${label} em ${turns} turno${turns === 1 ? '' : 's'}`, ...rows].join('\n');
}
