// Dados do modo clássico (booster, coleção, decks e PvP). O desafio diário continua Rush e não usa nada daqui.
// CONTRATO compartilhado pela arena (arena.js) e pelas telas (screens.js): mudar assinaturas só combinando os dois lados.
import { FORMATS, isExtra } from '../engine/ocg.mjs';
import { buildDeck } from '../engine/classic-deck.mjs';
import { readJson, writeJson } from './common.js';

/** PvP é o clássico normal: 8000 PV, deck de 40 a 60, Adicional até 15, duas Fases Principais. */
export const PVP_FORMAT = FORMATS.classico;
export const MAIN_MIN = 40;
export const MAIN_MAX = 60;
export const EXTRA_MAX = 15;
const MAX_CODE = 2048; // 75 ids de até 9 dígitos em base64 dão ~1.030 caracteres; o legítimo cabe folgado
const MAX_ID = 2 ** 31 - 1;

const json = async (url) => (await fetch(url)).json();
let loaded = null;
let hints = null;

/**
 * Pool da temporada atual (a maior ativa em seasons.json, somando as anteriores).
 * { season, label, pool, cards: Map(id -> carta, inclui fichas) }
 */
export function loadSeasonPool() {
  loaded ||= (async () => {
    const seasons = await json('src/data/classic/seasons.json');
    const active = seasons.filter((item) => item.enabled);
    const current = active.at(-1);
    const [parts, tokens] = await Promise.all([
      Promise.all(active.map((item) => json(`src/data/classic/s${item.season}.json`))),
      json('src/data/classic/tokens.json'),
    ]);
    const pool = parts.flat();
    return { season: current.season, label: current.label, pool, cards: new Map([...tokens, ...pool].map((card) => [card.id, card])) };
  })();
  return loaded;
}

/**
 * Dicas do gerador de decks (~1,2 MB): { synergy, templates }. Só baixa quando alguém monta deck
 * (deck inicial, "Completar automático", rival do treino).
 */
export function loadDeckHints() {
  hints ||= loadSeasonPool().then(async ({ season }) => {
    const [synergy, templates] = await Promise.all([
      json(`src/data/classic/synergy-s${season}.json`).catch(() => null),
      json(`src/data/classic/templates-s${season}.json`).catch(() => []),
    ]);
    return { synergy, templates };
  });
  return hints;
}

/* ---------- Coleção e decks (por chave de jogador) ---------- */

export const collectionKey = (playerKey) => `rushdaily-classic-collection:${playerKey}`;
export const decksKey = (playerKey) => `rushdaily-classic-decks:${playerKey}`;
export const foilsKey = (playerKey) => `rushdaily-classic-foils:${playerKey}`;

export const readCollection = (playerKey) => readJson(collectionKey(playerKey), {});
export const writeCollection = (playerKey, owned) => writeJson(collectionKey(playerKey), owned);

/** { active, list: [{ id, name, main: [ids], extra: [ids], updatedAt }] } */
export const readDecks = (playerKey) => readJson(decksKey(playerKey), { active: null, list: [] });
export const writeDecks = (playerKey, decks) => writeJson(decksKey(playerKey), decks);
export function deckById(playerKey, id) {
  const { active, list } = readDecks(playerKey);
  return list.find((deck) => deck.id === id) || list.find((deck) => deck.id === active) || list[0] || null;
}

/**
 * Regras do PvP: Principal 40-60, Adicional até 15 (só Fusão/Sincro/Xyz/Link), até 3 cópias somando os dois,
 * só cartas da temporada e, se owned vier, só o que o jogador tem.
 */
export function validDeck({ main = [], extra = [] } = {}, cards, owned = null) {
  const problems = [];
  if (main.length < MAIN_MIN || main.length > MAIN_MAX) problems.push(`O Deck Principal precisa de ${MAIN_MIN} a ${MAIN_MAX} cartas (tem ${main.length}).`);
  if (extra.length > EXTRA_MAX) problems.push(`O Deck Adicional aceita até ${EXTRA_MAX} cartas (tem ${extra.length}).`);
  const counts = new Map();
  for (const id of [...main, ...extra]) counts.set(id, (counts.get(id) || 0) + 1);
  for (const [id, count] of counts) {
    const card = cards.get(id);
    // Ficha (0x4000) está no Map só para o motor/desenho; não é carta de booster, então não vale em deck.
    if (!card || card.type & 0x4000) { problems.push('O deck tem uma carta fora da temporada.'); continue; }
    if (count > 3) problems.push(`${card.name}: no máximo 3 cópias.`);
    if (owned && count > (owned[id] || 0)) problems.push(`${card.name}: você só tem ${owned[id] || 0}.`);
  }
  if (main.some((id) => cards.get(id) && isExtra(cards.get(id)))) problems.push('Fusão, Sincro, Xyz e Link vão no Deck Adicional.');
  if (extra.some((id) => cards.get(id) && !isExtra(cards.get(id)))) problems.push('O Deck Adicional só aceita Fusão, Sincro, Xyz e Link.');
  return { ok: !problems.length, problems };
}

/* ---------- Link de desafio: "C1|CHAVE|ids.principal|ids.adicional" em base64url ---------- */

export function encodeDeck(playerKey, { main, extra = [] }) {
  return btoa(`C1|${playerKey}|${main.join('.')}|${extra.join('.')}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decodeDeck(code) {
  if (!code || code.length > MAX_CODE) return null; // teto antes do atob: link de 1 MB não é decodificado
  try {
    const [tag, key, main, extra = ''] = atob(code.replaceAll('-', '+').replaceAll('_', '/')).split('|');
    if (tag !== 'C1' || !/^[A-Z0-9]{6}$/.test(key)) return null;
    if (![main, extra].every((text) => /^[0-9.]*$/.test(text ?? ''))) return null; // ids só numéricos
    const ids = (text) => text.split('.').filter(Boolean).map(Number);
    const result = { key, main: ids(main), extra: ids(extra) };
    // Quantidade e tamanho de cada id limitados (o máximo legítimo é 60 + 15 cartas de até 9 dígitos).
    if (result.main.length > MAIN_MAX || result.extra.length > EXTRA_MAX) return null;
    if (![...result.main, ...result.extra].every((id) => Number.isSafeInteger(id) && id > 0 && id <= MAX_ID)) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * Jogador sem coleção clássica ganha duas listas iniciais (sorteadas pela chave, com sinergia de decks reais)
 * e a primeira vira o deck principal. Devolve a coleção.
 */
export async function ensureStarter(playerKey) {
  const owned = readCollection(playerKey);
  if (Object.keys(owned).length) return owned;
  const [{ pool }, { synergy, templates }] = await Promise.all([loadSeasonPool(), loadDeckHints()]);
  const starters = ['a'].map((tag) => buildDeck({ seed: `starter:${playerKey}:${tag}`, pool, synergy, templates, format: PVP_FORMAT }));
  const collection = {};
  for (const deck of starters) for (const id of [...deck.main, ...deck.extra]) collection[id] = Math.min(3, (collection[id] || 0) + 1);
  writeCollection(playerKey, collection);
  // O deck inicial respeita a coleção (cópias além de 3 foram cortadas acima).
  const first = starters[0];
  const fit = (ids) => { const used = new Map(); return ids.filter((id) => { const n = (used.get(id) || 0) + 1; used.set(id, n); return n <= collection[id]; }); };
  writeDecks(playerKey, { active: 'd1', list: [{ id: 'd1', name: 'Deck inicial', main: fit(first.main), extra: fit(first.extra), updatedAt: 0 }] });
  // updatedAt 0: num aparelho recém-ligado, o deck inicial nunca vence (na sincronização) o deck já editado no outro.
  return collection;
}
