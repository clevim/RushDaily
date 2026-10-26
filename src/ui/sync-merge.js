// Sincronização entre aparelhos: formato do progresso e a junção que nunca perde progresso.
// Módulo puro (sem DOM): usado no navegador, no servidor (validação) e nos testes. Desenho em docs/sync/README.md.

export const SCHEMA_VERSION = 1;
/** Seções do progresso (o resto do localStorage é do aparelho e não sincroniza). */
export const SECTIONS = ['history', 'pvp', 'boosters', 'rewards', 'collection', 'foils', 'pity', 'decks', 'recover', 'heartUsed', 'settings'];

export class SchemaError extends Error {}

/** Chaves do localStorage que são progresso (gravar uma delas agenda um sync). */
export const PROGRESS_PREFIXES = ['rushdaily-history', 'rushdaily-classic-pvp:', 'rushdaily-classic-booster:', 'rushdaily-reward:', 'rushdaily-classic-collection:', 'rushdaily-classic-foils:', 'rushdaily-classic-pity:', 'rushdaily-classic-decks:', 'rushdaily-enigma-recover:', 'rushdaily-heart-used:', 'rushdaily-settings:'];
export const isProgressKey = (key) => typeof key === 'string' && PROGRESS_PREFIXES.some((prefix) => key.startsWith(prefix));

/** JSON com as chaves ordenadas: compara progresso sem depender da ordem de inserção. */
export const canonical = (value) => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));

const PVP_MAX = 100; // = arena.js
const REPLAY_MAX = 4096; // replay maior que isso não viaja (o resultado viaja)
const TOMBSTONE_DAYS = 180;
const RESULTS = ['loss', 'draw', 'win']; // ordem = força: vitória nunca vira derrota
const FOILS = ['star', 'etched', 'prism', 'gold', 'galaxy'];
const TIERS = ['common', 'silver', 'gold', 'galaxy'];

const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDay = (text) => typeof text === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(text);
// Booster/recompensa: o dia, ou "dia~2" para o 2º booster (vitória em outra dificuldade, sem peça).
const isSlot = (text) => typeof text === 'string' && isDay(text.replace(/~2$/, ''));
const isMonth = (text) => typeof text === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(text);
const isCardId = (id) => /^[1-9]\d{0,9}$/.test(String(id)) && Number(id) <= 2 ** 31 - 1;
const int = (value, max) => (Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null);
const str = (value, max, pattern = null) => (typeof value === 'string' && value.length <= max && (!pattern || pattern.test(value)) ? value : null);
const time = (value) => int(value, 8.64e15) ?? 0;
const entries = (value) => (isObj(value) ? Object.entries(value) : []);
const ids = (list) => (Array.isArray(list) ? list.filter(isCardId).map(Number).slice(0, 60) : []);

/* ---------- Normalização: aceita esquema antigo/parcial e descarta o que não tem o formato certo ---------- */
// Os dados vêm de outro aparelho (via servidor): tratados como entrada não confiável, como o localStorage.

function booster(value) {
  if (!isObj(value) || !Array.isArray(value.cards)) return null;
  const cards = value.cards.filter((card) => isObj(card) && isCardId(card.id)).slice(0, 10).map((card) => ({
    id: Number(card.id),
    foil: FOILS.includes(card.foil) ? card.foil : null,
    back: card.back === 'safira' ? 'safira' : 'rubi',
    rare: card.rare === true,
    ...(card.isNew === true ? { isNew: true } : {}),
  }));
  return {
    openedAt: str(value.openedAt, 40) || '',
    seed: str(value.seed, 80) || '',
    tier: TIERS.includes(value.tier) ? value.tier : 'common',
    theme: str(value.theme, 80),
    layout: value.layout === 'row' ? 'row' : 'arc',
    disguise: value.disguise === true,
    cards,
  };
}

function deck(value) {
  const id = isObj(value) && str(value.id, 24, /^[a-z0-9]+$/i);
  if (!id) return null;
  return { id, name: (str(value.name, 40) ?? 'Deck').trim() || 'Deck', main: ids(value.main), extra: ids(value.extra).slice(0, 15), updatedAt: time(value.updatedAt) };
}

/** Progresso no formato atual, com padrões nas seções que faltam. Esquema mais novo que este código: SchemaError. */
export function normalize(data) {
  const src = isObj(data) ? data : {};
  const v = src.v ?? 0; // sem "v" = dado anterior ao esquema (v0): mesmo formato, sem lápides nem datas de ajuste
  if (!Number.isSafeInteger(v) || v < 0) throw new SchemaError('Versão de esquema inválida.');
  if (v > SCHEMA_VERSION) throw new SchemaError(`Progresso salvo por uma versão mais nova do jogo (esquema ${v}). Recarregue a página.`);
  const out = { v: SCHEMA_VERSION };
  out.history = Object.fromEntries(entries(src.history).filter(([day, result]) => isDay(day) && RESULTS.includes(result)));
  out.pvp = (Array.isArray(src.pvp) ? src.pvp : []).filter((duel) => isObj(duel) && isDay(duel.date) && str(duel.vs, 6, /^[A-Z0-9]{6}$/)).slice(0, PVP_MAX).map((duel) => ({
    date: duel.date,
    vs: duel.vs,
    result: RESULTS.includes(duel.result) ? duel.result : null,
    turns: int(duel.turns, 999),
    lp: int(duel.lp, 1e6),
    ...(str(duel.replay, REPLAY_MAX, /^[A-Za-z0-9_-]+$/) ? { replay: duel.replay } : {}),
  }));
  out.boosters = Object.fromEntries(entries(src.boosters).filter(([day]) => isSlot(day)).map(([day, value]) => [day, booster(value)]).filter(([, value]) => value));
  out.rewards = Object.fromEntries(entries(src.rewards).filter(([day, value]) => isSlot(day) && isObj(value) && value.pending === true && str(value.seed, 80))
    .map(([day, value]) => [day, { seed: value.seed, difficulty: str(value.difficulty, 20) || 'duelist', pending: true }]));
  out.collection = Object.fromEntries(entries(src.collection).filter(([id, count]) => isCardId(id) && int(count, 999) !== null && count > 0));
  out.foils = Object.fromEntries(entries(src.foils).filter(([id]) => isCardId(id)).map(([id, list]) => [id, [...new Set(Array.isArray(list) ? list.filter((foil) => FOILS.includes(foil)) : [])]]).filter(([, list]) => list.length));
  out.pity = int(src.pity, 9999) ?? 0;
  const decks = isObj(src.decks) ? src.decks : {};
  const list = (Array.isArray(decks.list) ? decks.list : []).map(deck).filter(Boolean).slice(0, 50);
  out.decks = {
    active: str(decks.active, 24, /^[a-z0-9]+$/i),
    activeAt: time(decks.activeAt),
    list: list.filter((item, index) => list.findIndex((other) => other.id === item.id) === index),
    deleted: Object.fromEntries(entries(decks.deleted).filter(([id, at]) => /^[a-z0-9]{1,24}$/i.test(id) && int(at, 8.64e15)).slice(0, 200)),
  };
  out.recover = Object.fromEntries(entries(src.recover).filter(([day, id]) => isDay(day) && str(id, 60, /^[\w-]+$/)));
  out.heartUsed = [...new Set(Array.isArray(src.heartUsed) ? src.heartUsed.filter(isMonth) : [])].sort();
  const settings = isObj(src.settings) ? src.settings : {};
  out.settings = { ...(str(settings.difficulty, 20, /^[a-z-]+$/) ? { difficulty: settings.difficulty } : {}), updatedAt: time(settings.updatedAt) };
  return out;
}

/* ---------- Junção ---------- */

const countCards = (boosters, days) => {
  const counts = {};
  for (const day of days) for (const card of boosters[day].cards) counts[card.id] = (counts[card.id] || 0) + 1;
  return counts;
};

/** Sorte acumulada = pacotes comuns seguidos no fim da lista (a mesma conta que a tela faz ao abrir cada pacote). */
function pityOf(boosters) {
  let streak = 0;
  for (const day of Object.keys(boosters).sort().reverse()) {
    if (boosters[day].tier !== 'common') break;
    streak += 1;
  }
  return streak;
}

function mergeDecks(local, remote, now) {
  const deleted = { ...remote.deleted };
  for (const [id, at] of Object.entries(local.deleted)) deleted[id] = Math.max(at, deleted[id] || 0);
  const byId = new Map();
  // Ordem: a do aparelho local, depois os decks que só o outro tem. Empate de updatedAt: fica o local.
  for (const item of [...remote.list, ...local.list]) {
    const seen = byId.get(item.id);
    if (!seen || item.updatedAt >= seen.updatedAt) byId.set(item.id, item);
  }
  const order = [...new Set([...local.list, ...remote.list].map((item) => item.id))];
  // Lápide vence a edição feita antes dela; editar depois de apagar (no outro aparelho) traz o deck de volta.
  const list = order.map((id) => byId.get(id)).filter((item) => !(deleted[item.id] >= item.updatedAt));
  for (const [id, at] of Object.entries(deleted)) if (now - at > TOMBSTONE_DAYS * 864e5) delete deleted[id];
  const pick = remote.activeAt > local.activeAt ? remote : local;
  const active = list.some((item) => item.id === pick.active) ? pick.active : list.find((item) => item.id === local.active)?.id ?? list[0]?.id ?? null;
  return { active, activeAt: Math.max(local.activeAt, remote.activeAt), list, deleted };
}

/**
 * Junta o progresso deste aparelho (local) com o do servidor (remote). Nunca perde progresso:
 * eventos (dias, pacotes, peças, usos do Coração, duelos) entram por união; o que é só estado (decks, ajustes)
 * fica com a versão mais nova. Regras e justificativas em docs/sync/README.md.
 */
export function mergeProgress(localData, remoteData, now = Date.now()) {
  const local = normalize(localData);
  const remote = normalize(remoteData);
  const out = { v: SCHEMA_VERSION };

  out.history = { ...remote.history };
  for (const [day, result] of Object.entries(local.history)) {
    if (!out.history[day] || RESULTS.indexOf(result) >= RESULTS.indexOf(out.history[day])) out.history[day] = result;
  }

  const seen = new Set();
  const fingerprint = (duel) => [duel.date, duel.vs, duel.result, duel.turns, duel.lp, duel.replay || ''].join('|');
  out.pvp = [...local.pvp, ...remote.pvp].filter((duel) => !seen.has(fingerprint(duel)) && seen.add(fingerprint(duel)))
    .map((duel, index) => [duel, index]).sort(([a, i], [b, j]) => b.date.localeCompare(a.date) || i - j).map(([duel]) => duel).slice(0, PVP_MAX);

  // Pacote do dia aberto nos dois aparelhos (offline): fica o primeiro aberto; as cartas dos dois continuam na coleção.
  out.boosters = { ...remote.boosters };
  for (const [day, value] of Object.entries(local.boosters)) {
    const other = out.boosters[day];
    if (!other || !other.openedAt || (value.openedAt && value.openedAt <= other.openedAt)) out.boosters[day] = value;
  }

  // Coleção: cada lado já somou os próprios pacotes. Somando a cada lado os pacotes que só o outro abriu,
  // dois aparelhos que abriram pacotes diferentes (mesma carta inclusive) ficam com a soma, não com o maior.
  const onlyLocal = countCards(local.boosters, Object.keys(local.boosters).filter((day) => !remote.boosters[day]));
  const onlyRemote = countCards(remote.boosters, Object.keys(remote.boosters).filter((day) => !local.boosters[day]));
  out.collection = {};
  for (const id of new Set([...Object.keys(local.collection), ...Object.keys(remote.collection)])) {
    out.collection[id] = Math.min(999, Math.max((local.collection[id] || 0) + (onlyRemote[id] || 0), (remote.collection[id] || 0) + (onlyLocal[id] || 0)));
  }

  out.foils = { ...remote.foils };
  for (const [id, list] of Object.entries(local.foils)) out.foils[id] = [...new Set([...(out.foils[id] || []), ...list])];

  // Derivada dos pacotes (não dá para somar nem pegar o maior sem inventar sorte); sem pacotes, o maior.
  out.pity = Object.keys(out.boosters).length ? pityOf(out.boosters) : Math.max(local.pity, remote.pity);

  // Booster ganho e ainda fechado: união, menos os dias cujo pacote já foi aberto em algum aparelho (não abre duas vezes).
  out.rewards = Object.fromEntries(Object.entries({ ...remote.rewards, ...local.rewards }).filter(([day]) => !out.boosters[day]));

  out.decks = mergeDecks(local.decks, remote.decks, now);
  out.recover = { ...remote.recover, ...local.recover };
  // "Coração usado" é evento (o mês gasto): união. Um mês gasto em qualquer aparelho fica gasto em todos.
  out.heartUsed = [...new Set([...local.heartUsed, ...remote.heartUsed])].sort();
  out.settings = remote.settings.updatedAt > local.settings.updatedAt ? remote.settings : local.settings;
  return out;
}

/* ---------- localStorage <-> progresso (a fase 2 liga isto às telas) ---------- */
// `storage` é um Storage (localStorage) ou algo com getItem/setItem/removeItem/key/length. Nada aqui usa BigInt.

const parse = (storage, key, fallback) => { try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; } };
const put = (storage, key, value) => storage.setItem(key, JSON.stringify(value));
const keysOf = (storage) => Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(Boolean);
const byDay = (storage, prefix) => Object.fromEntries(keysOf(storage).filter((key) => key.startsWith(prefix) && isSlot(key.slice(prefix.length))).map((key) => [key.slice(prefix.length), parse(storage, key, null)]));

export function readProgress(storage, playerKey) {
  const settings = parse(storage, `rushdaily-settings:${playerKey}`, {});
  return normalize({
    v: SCHEMA_VERSION,
    history: parse(storage, 'rushdaily-history', {})?.[playerKey],
    pvp: parse(storage, `rushdaily-classic-pvp:${playerKey}`, []),
    boosters: byDay(storage, `rushdaily-classic-booster:${playerKey}:`),
    rewards: byDay(storage, `rushdaily-reward:${playerKey}:`),
    collection: parse(storage, `rushdaily-classic-collection:${playerKey}`, {}),
    foils: parse(storage, `rushdaily-classic-foils:${playerKey}`, {}),
    pity: parse(storage, `rushdaily-classic-pity:${playerKey}`, 0),
    decks: parse(storage, `rushdaily-classic-decks:${playerKey}`, {}),
    recover: parse(storage, `rushdaily-enigma-recover:${playerKey}`, {}),
    heartUsed: parse(storage, `rushdaily-heart-used:${playerKey}`, []),
    settings: { difficulty: settings?.difficulty, updatedAt: settings?.updatedAt },
  });
}

/** Grava o progresso (já juntado) nas chaves de sempre. Não apaga nada que não seja recompensa já aberta. */
export function writeProgress(storage, playerKey, data) {
  const progress = normalize(data);
  const history = parse(storage, 'rushdaily-history', {});
  put(storage, 'rushdaily-history', { ...(isObj(history) ? history : {}), [playerKey]: progress.history });
  put(storage, `rushdaily-classic-pvp:${playerKey}`, progress.pvp);
  for (const [day, value] of Object.entries(progress.boosters)) put(storage, `rushdaily-classic-booster:${playerKey}:${day}`, value);
  for (const day of Object.keys(byDay(storage, `rushdaily-reward:${playerKey}:`))) if (!progress.rewards[day]) storage.removeItem(`rushdaily-reward:${playerKey}:${day}`);
  for (const [day, value] of Object.entries(progress.rewards)) put(storage, `rushdaily-reward:${playerKey}:${day}`, value);
  put(storage, `rushdaily-classic-collection:${playerKey}`, progress.collection);
  put(storage, `rushdaily-classic-foils:${playerKey}`, progress.foils);
  put(storage, `rushdaily-classic-pity:${playerKey}`, progress.pity);
  put(storage, `rushdaily-classic-decks:${playerKey}`, progress.decks);
  put(storage, `rushdaily-enigma-recover:${playerKey}`, progress.recover);
  put(storage, `rushdaily-heart-used:${playerKey}`, progress.heartUsed);
  // Ajustes: só a dificuldade viaja; "reduzir animações" continua sendo do aparelho.
  const settings = parse(storage, `rushdaily-settings:${playerKey}`, {});
  put(storage, `rushdaily-settings:${playerKey}`, { ...(isObj(settings) ? settings : {}), ...progress.settings });
}
