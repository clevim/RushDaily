// Decks do formato rápido gerados por seed a partir do pool da temporada.
// Fonte da coerência: decks reais de jogadores (YGOPRODeck), resumidos em sinergia (lift entre cartas) e moldes.
//   - molde: um deck real que cabe na temporada, comprimido para 20 cartas;
//   - sinergia: começa de uma carta-semente e cresce puxando as parceiras mais ligadas, com ruído para variar.
// Sem dados de sinergia, cai num sorteio por popularidade com tema (arquétipo ou Tipo).
import { FORMATS, TYPE, isExtra } from './ocg.mjs';

function hash(text) {
  let value = 2166136261;
  for (const char of String(text)) { value ^= char.charCodeAt(0); value = Math.imul(value, 16777619); }
  return value >>> 0;
}
export function seeded(seed) {
  let value = hash(seed) || 1;
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; };
}

const isMonster = (card) => card.type & TYPE.MONSTER;
const level = (card) => card.level & 0xff;
// Rituais precisam da Magia certa: só entram quando vêm de um molde (deck real).
const playable = (card) => card && !isExtra(card) && !(card.type & TYPE.RITUAL) && !(card.type & TYPE.TOKEN);

/** Cotas do deck de 20 (escalam para outros tamanhos). */
function quotas(format) {
  const scale = format.main / 20;
  return [
    { key: 'low', test: (c) => isMonster(c) && level(c) <= 4, n: Math.round(10 * scale) },
    { key: 'mid', test: (c) => isMonster(c) && level(c) >= 5 && level(c) <= 6, n: Math.round(2 * scale) },
    { key: 'high', test: (c) => isMonster(c) && level(c) >= 7, n: Math.round(1 * scale) },
    { key: 'spell', test: (c) => c.type & TYPE.SPELL, n: Math.round(4 * scale) },
    { key: 'trap', test: (c) => c.type & TYPE.TRAP, n: Math.round(3 * scale) },
  ];
}

function weightedPick(random, entries) {
  let roll = random() * entries.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [value, weight] of entries) { roll -= weight; if (roll <= 0) return value; }
  return entries.at(-1)?.[0];
}

/** Temas para o modo sem sinergia: arquétipos com 8+ monstros jogáveis e Tipos com 25+. */
export function themesOf(pool) {
  const counts = new Map();
  for (const card of pool) if (playable(card) && isMonster(card) && card.archetype) counts.set(card.archetype, (counts.get(card.archetype) || 0) + 1);
  const archetypes = [...counts].filter(([, n]) => n >= 8).map(([name]) => ({ kind: 'archetype', key: name, match: (card) => card.archetype === name }));
  const races = [...new Set(pool.filter(isMonster).map((card) => card.race))].filter((race) => pool.filter((card) => card.race === race && playable(card)).length >= 25)
    .map((race) => ({ kind: 'race', key: race, match: (card) => card.race === race }));
  return [...archetypes, ...races];
}

/** Fusões cujo texto cita pelo nome uma carta do deck (matéria provável), mais as ligadas por sinergia. */
function extraFor(random, main, byId, pool, links, format) {
  const names = main.map((id) => byId.get(id)).flatMap((card) => [card.name, card.nameEn]);
  const score = new Map();
  for (const card of pool) {
    if (!(card.type & TYPE.FUSION)) continue;
    if (names.some((name) => card.desc.includes(`"${name}"`))) score.set(card.id, 3);
  }
  for (const id of main) for (const [other, weight] of links?.[id] || []) if (byId.get(other)?.type & TYPE.FUSION) score.set(other, (score.get(other) || 0) + weight);
  const out = [];
  const entries = [...score];
  while (out.length < format.extra && entries.length) {
    const pick = weightedPick(random, entries.map(([id, weight]) => [id, weight + random() * 0.5]));
    out.push(pick);
    entries.splice(entries.findIndex(([id]) => id === pick), 1);
  }
  return out;
}

/** Comprime um deck real para o tamanho do formato, guardando a proporção de tipos e as cartas mais repetidas. */
function fromTemplate(random, template, byId, format) {
  const copies = new Map();
  for (const id of template.main) copies.set(id, (copies.get(id) || 0) + 1);
  const total = template.main.length;
  const groups = [(c) => isMonster(c), (c) => c.type & TYPE.SPELL, (c) => c.type & TYPE.TRAP];
  const main = [];
  for (const test of groups) {
    const ids = [...copies].filter(([id]) => byId.get(id) && test(byId.get(id)));
    const share = ids.reduce((sum, [, n]) => sum + n, 0);
    let want = Math.round((share / total) * format.main);
    // Mais cópias primeiro; empate vira sorteio (molde igual não gera sempre o mesmo deck).
    const ranked = ids.map(([id, n]) => ({ id, n, key: n + random() })).sort((a, b) => b.key - a.key);
    for (const { id, n } of ranked) {
      const take = Math.min(want, Math.max(1, Math.round((n * format.main) / total)));
      for (let i = 0; i < take; i += 1) main.push(id);
      want -= take;
      if (want <= 0) break;
    }
  }
  return main.slice(0, format.main);
}

/** Cresce um deck a partir de uma semente puxando parceiras de sinergia, respeitando as cotas. */
function fromSynergy(random, seedCard, pool, byId, links, usage, format, themed) {
  const main = [seedCard.id];
  const counts = new Map([[seedCard.id, 1]]);
  const plan = quotas(format).map((quota) => ({ ...quota, have: quota.test(seedCard) ? 1 : 0 }));
  const maxCopies = (card) => (isMonster(card) && level(card) >= 5 ? 1 : 2);
  const room = (card) => plan.find((quota) => quota.test(card) && quota.have < quota.n);
  const popular = (card) => Math.log(2 + (usage[card.id] || 0) + (card.pop || 0) / 5000);
  while (plan.some((quota) => quota.have < quota.n)) {
    const score = new Map();
    for (const id of new Set(main)) {
      for (const [other, weight] of links?.[id] || []) {
        const card = byId.get(other);
        if (!playable(card) || !room(card) || (counts.get(other) || 0) >= maxCopies(card)) continue;
        score.set(other, (score.get(other) || 0) + weight);
      }
    }
    let pick;
    if (score.size) {
      // Ruído exponencial: as melhores parceiras ganham quase sempre, mas não sempre.
      pick = weightedPick(random, [...score].map(([id, s]) => [id, Math.exp(s * 1.6) * (themed(byId.get(id)) ? 1.5 : 1)]));
    } else {
      const quota = plan.find((q) => q.have < q.n);
      const options = pool.filter((card) => playable(card) && quota.test(card) && (counts.get(card.id) || 0) < maxCopies(card));
      pick = weightedPick(random, options.map((card) => [card.id, popular(card) * (themed(card) ? 4 : 1)]));
    }
    const card = byId.get(pick);
    room(card).have += 1;
    counts.set(pick, (counts.get(pick) || 0) + 1);
    main.push(pick);
  }
  return main;
}

/**
 * Deck do formato (20 + Extra de até 5). synergy: { links, usage } e templates vêm de tools/classic (build).
 * Mesma seed, mesmo pool e mesmos dados: mesmo deck.
 */
export function buildDeck({ seed, pool, synergy = null, templates = [], format = FORMATS.rapido }) {
  const random = seeded(seed);
  const byId = new Map(pool.map((card) => [card.id, card]));
  const links = synergy?.links || {};
  const usage = synergy?.usage || {};
  const themes = themesOf(pool);
  const theme = themes[Math.floor(random() * themes.length)];
  const themed = (card) => Boolean(theme?.match(card));
  let main;
  let label;
  const usable = templates.filter((template) => template.main.every((id) => byId.has(id)));
  if (usable.length && random() < 0.4) {
    const template = usable[Math.floor(random() * usable.length)];
    main = fromTemplate(random, template, byId, format);
    label = { kind: 'template', key: template.format };
  }
  if (!main || main.length < format.main) {
    // Semente: monstro de nível 4 ou menos, popular nos decks reais e de preferência do tema sorteado.
    const seeds = pool.filter((card) => playable(card) && isMonster(card) && level(card) <= 4);
    const seedId = weightedPick(random, seeds.map((card) => [card.id, Math.sqrt(1 + (usage[card.id] || 0) * 20 + (card.pop || 0) / 1000) * (themed(card) ? 3 : 1)]));
    main = fromSynergy(random, byId.get(seedId), pool, byId, links, usage, format, themed);
    label = { kind: byId.get(seedId).archetype ? 'archetype' : 'seed', key: byId.get(seedId).archetype || byId.get(seedId).name };
  }
  const extra = extraFor(random, main, byId, pool, links, format);
  return { main, extra, theme: label };
}
