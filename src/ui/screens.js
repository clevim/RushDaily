import { listDifficulties } from '../engine/daily-generator.mjs';
import { buildDeck, seeded } from '../engine/classic-deck.mjs';
import { TYPE, isExtra } from '../engine/ocg.mjs';
import { daysInMonth, heartCharges, monthName, monthOf, monthPieces, recoveredDays, bindKeyChip, escape, glove, getPlayerKey, longDate, nav, readJson, removeKey, settingsFor, tilt, today, toast, writeJson } from './common.js';
// scene.js (e o Three.js, ~270 KB gzip) só carrega nas telas que têm 3D: Recompensa e Enigma.
const loadScene = () => import('./scene.js');
import { EXTRA_MAX, MAIN_MAX, MAIN_MIN, PVP_FORMAT, collectionKey, decodeDeck, encodeDeck, ensureStarter, foilsKey, loadDeckHints, loadSeasonPool, readCollection, readDecks, validDeck, writeCollection, writeDecks } from './classic-store.js';
import { classicCardUrl, classicImg, paintCards } from './classic-render.js';
import { cardStats, frameOf, kindLabel } from './classic-card.js';
import { credOf, disableSync, enableSync, moveToNewKey, rotateSecret, syncLink, syncNow } from './sync.js';

const playerKey = getPlayerKey();
const date = today();
const screen = new URLSearchParams(location.search).get('screen') || 'collection';
const root = document.querySelector('#screen');
const settingsKey = `rushdaily-settings:${playerKey}`;

if (screen === 'today') location.replace(`index.html?player=${playerKey}`);
document.querySelector('#nav').outerHTML = nav(screen, playerKey);
bindKeyChip(playerKey);

// Pool clássico da temporada atual e coleção inicial (as cartas Rush antigas não aparecem mais aqui).
const season = await loadSeasonPool();
const { pool, label: seasonLabel } = season;
// Puxa o progresso antes da coleção inicial: aparelho recém-ligado recebe as cartas do outro em vez de ganhar outras.
await syncNow({ timeout: 2500 });
await ensureStarter(playerKey);

const byId = (id) => season.cards.get(Number(id));
const isMonster = (card) => Boolean(card.type & TYPE.MONSTER);
const levelOf = (card) => card.level & 0xff;
const BACK = 'src/assets/card-back.svg';
const byName = new Intl.Collator('pt-BR').compare;
/** Espera o jogador parar de digitar antes de refiltrar milhares de cartas. */
const debounce = (fn, ms = 150) => { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }; };

/* ---------- Acabamento foil das cartas clássicas ---------- */

const FOIL_RANK = ['star', 'etched', 'prism', 'gold', 'galaxy'];
const RARITY_FOIL = { common: '', rare: 'foil-star', super: 'foil-prism', ultra: 'foil-gold', secret: 'foil-galaxy' };
const RARITY_NAMES = { common: 'Comum', rare: 'Rara', super: 'Super Rara', ultra: 'Ultra Rara', secret: 'Secreta' };
/** Foil que o jogador tirou na carta (o mais raro) ou, sem ele, o da raridade impressa. */
function foilClass(card, foils, variant = null) {
  const best = variant || [...(foils[card.id] || [])].sort((a, b) => FOIL_RANK.indexOf(b) - FOIL_RANK.indexOf(a))[0];
  return best && /^[a-z0-9-]+$/i.test(String(best)) ? `foil-${best}` : RARITY_FOIL[card.rarity] || '';
}

/** Zoom de uma carta clássica: imagem oficial, linha de dados e texto em PT. */
function inspect(card) {
  const dialog = document.createElement('dialog');
  dialog.className = 'inspect';
  const foils = readJson(foilsKey(playerKey), {});
  dialog.innerHTML = `<div class="card ${foilClass(card, foils)} inspect-card">${classicImg(card)}</div>
    <div class="inspect-copy"><h2>${escape(card.name)}</h2><p class="inspect-stats">${escape(cardStats(card))}</p><p>${escape(card.desc || '').replaceAll('\n', '<br>')}</p>
    <p class="inspect-rarity">${RARITY_NAMES[card.rarity] || ''}</p>
    <button class="btn ghost" type="button" data-close>Fechar</button></div>`;
  document.body.append(dialog);
  paintCards(dialog);
  tilt(dialog.querySelector('.inspect-card'), 18);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => { if (event.target === dialog || event.target.closest('[data-close]')) dialog.close(); });
  dialog.showModal();
}

/* ---------- Booster determinístico ---------- */

const FOILS = {
  common: [[null, 55], ['star', 18], ['etched', 15], ['prism', 12]],
  silverCommon: [[null, 25], ['star', 30], ['etched', 25], ['prism', 20]],
  allFoil: [['star', 35], ['etched', 30], ['prism', 35]],
  rare: [['prism', 40], ['gold', 35], ['galaxy', 25]],
  legend: [['gold', 60], ['galaxy', 40]],
  cosmic: [['galaxy', 70], ['gold', 30]],
};
// Chance de cada raridade de pacote (em 100): a sorte decide pela seed do jogador.
const TIER_ODDS = [['galaxy', 2], ['gold', 8], ['silver', 20], ['common', 70]];
// Sorte acumulada: cada pacote comum seguido soma estes pesos (até 8 seguidos); no 9º vem pelo menos Prata.
const PITY_BONUS = { silver: 5, gold: 1.5, galaxy: 0.3 };
// Piso do pacote por dificuldade (rating 1 a 4: Aprendiz, Duelista, Elite, Caos) e chance extra de Galáxia por ponto de rating acima de 2.
const TIER_ORDER = ['common', 'silver', 'gold', 'galaxy'];
const DIFFICULTY_FLOOR = ['common', 'silver', 'gold', 'gold'];
const GALAXY_PER_RATING = 0.03;
export const pityKey = (key) => `rushdaily-classic-pity:${key}`;

function weighted(random, table) {
  let roll = random() * table.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [value, weight] of table) { roll -= weight; if (roll <= 0) return value; }
  return table.at(-1)[0];
}

/** Arquétipos com cartas suficientes para virar tema de pacote. */
const themesOf = (cards) => {
  const counts = new Map();
  for (const card of cards) if (card.archetype) counts.set(card.archetype, (counts.get(card.archetype) || 0) + 1);
  return [...counts].filter(([, n]) => n >= 8).map(([name]) => name).sort();
};

/**
 * Pacote do dia: raridade (comum, prata, ouro, galáxia), se aparece disfarçado de comum,
 * a disposição das cartas, um tema de arquétipo opcional e as 5 cartas (sem repetir) com foil e verso.
 * Slots por raridade impressa: comum nos comuns, rare/super nos raros, ultra/secret nos LEGEND.
 * Cartas que o jogador ainda não tem pesam 3x; as que ele já tem 3 cópias pesam 1/4.
 * Mesma seed, mesma coleção e mesma sorte acumulada: mesmo pacote.
 */
export function openBooster(seed, { owned = {}, pity = 0, cards = pool, difficulty = null } = {}) {
  const random = seeded(seed);
  const themes = themesOf(cards);
  const theme = themes.length && random() < 0.35 ? themes[Math.floor(random() * themes.length)] : null;
  const streak = Math.min(pity, 8);
  let tier = weighted(random, TIER_ODDS.map(([id, weight]) => [id, weight + (PITY_BONUS[id] || 0) * streak]));
  if (tier === 'common' && pity >= 8) tier = 'silver';
  // Dificuldade: define o piso do pacote (a sorte e a pity só podem melhorar) e, a partir da Elite, dá uma chance extra de Galáxia.
  const rating = listDifficulties().find((item) => item.id === difficulty)?.rating || 0;
  const floor = TIER_ORDER.indexOf(DIFFICULTY_FLOOR[rating - 1] || 'common');
  const galaxyChance = rating >= 3 ? (rating - 2) * GALAXY_PER_RATING : 0;
  if (random() < galaxyChance) tier = 'galaxy';
  if (TIER_ORDER.indexOf(tier) < floor) tier = TIER_ORDER[floor];
  const taken = new Set();
  const weight = (card) => (owned[card.id] ? (owned[card.id] >= 3 ? 0.25 : 1) : 3) * (theme && card.archetype === theme ? 20 : 1);
  const pick = (list) => {
    const card = weighted(random, list.filter((item) => !taken.has(item.id)).map((item) => [item, weight(item)]));
    taken.add(card.id);
    return card;
  };
  const legends = cards.filter((card) => card.rarity === 'ultra' || card.rarity === 'secret');
  const rares = cards.filter((card) => card.rarity === 'rare' || card.rarity === 'super');
  const commons = cards.filter((card) => !card.rarity || card.rarity === 'common');
  const slot = (list, foils, rare) => ({ id: pick(list).id, foil: weighted(random, foils), back: rare ? 'safira' : 'rubi', rare });
  const recipe = {
    common: () => [...[0, 1, 2, 3].map(() => slot(commons, FOILS.common, false)), slot(rares, FOILS.rare, true)],
    silver: () => [...[0, 1, 2].map(() => slot(commons, FOILS.silverCommon, false)), slot(rares, FOILS.rare, true), slot(rares, FOILS.rare, true)],
    gold: () => [...[0, 1, 2].map(() => slot(commons, FOILS.allFoil, false)), slot(rares, FOILS.rare, true), slot(legends, FOILS.legend, true)],
    galaxy: () => [slot(rares, FOILS.allFoil, false), slot(rares, FOILS.cosmic, true), slot(rares, FOILS.cosmic, true), slot(legends, FOILS.cosmic, true), slot(legends, FOILS.cosmic, true)],
  }[tier];
  const picked = recipe();
  return { tier, theme, cards: picked, disguise: (tier === 'gold' || tier === 'galaxy') && random() < 0.5, layout: random() < 0.5 ? 'arc' : 'row' };
}

/* ---------- Telas ---------- */

function head(title, copy, aside = '') {
  return `<header class="screen-head"><div class="head-main"><h1>${title}</h1>${copy ? `<p>${copy}</p>` : ''}</div>${aside}</header>`;
}

// Ordem e nomes das estantes da coleção (por moldura da carta).
const GROUPS = [['normal', 'Monstros Normais'], ['effect', 'Monstros de Efeito'], ['ritual', 'Monstros de Ritual'], ['fusion', 'Monstros de Fusão'], ['synchro', 'Monstros Sincro'], ['xyz', 'Monstros Xyz'], ['link', 'Monstros Link'], ['spell', 'Magias'], ['trap', 'Armadilhas']];
const ARCHETYPES = [...new Set(pool.map((card) => card.archetype).filter(Boolean))].sort((a, b) => byName(a, b));
const archetypeOptions = () => `<option value="all">Todos os arquétipos</option>${ARCHETYPES.map((name) => `<option value="${escape(name)}">${escape(name)}</option>`).join('')}`;
const matchesQuery = (card, query) => !query || card.name.toLowerCase().includes(query) || (card.nameEn || '').toLowerCase().includes(query);
const PAGE = 60;

/** Liga o carregamento por rolagem: chama more() quando o gatilho chega perto da tela. */
function infinite(trigger, more) {
  if (!('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting) || trigger.hidden) return;
    observer.disconnect();
    more();
    if (!trigger.hidden) observer.observe(trigger); // reobserva para disparar de novo se ainda estiver à vista
  }, { rootMargin: '600px' });
  observer.observe(trigger);
}

function renderCollection() {
  const owned = readCollection(playerKey);
  const foils = readJson(foilsKey(playerKey), {});
  const total = pool.length;
  const have = pool.filter((card) => owned[card.id]).length;
  // Quem tem pouco da coleção abre no que tem (senão as cartas ficam enterradas atrás de centenas de versos).
  const filters = { query: '', archetype: 'all', status: have * 2 < total ? 'have' : 'all' };
  root.innerHTML = `${head(`Coleção <small>${escape(seasonLabel)}</small>`, '', `<div class="head-meter" role="img" aria-label="${have} de ${total} cartas"><b>${have}</b><span>de ${total} cartas</span><div class="progress"><i style="width:${(have / total) * 100}%"></i></div></div>`)}
    <div class="toolbar">
      <input type="search" id="col-search" placeholder="Buscar carta" aria-label="Buscar carta">
      <div class="chips" role="radiogroup" aria-label="Mostrar">${[['all', 'Todas'], ['have', 'Que tenho'], ['miss', 'Que faltam']].map(([value, text]) => `<button type="button" class="chip ${value === filters.status ? 'on' : ''}" data-status="${value}" role="radio" aria-checked="${value === filters.status}">${text}</button>`).join('')}</div>
      <div class="selects"><select id="col-archetype" aria-label="Arquétipo">${archetypeOptions()}</select></div>
    </div>
    <div id="shelves"></div>
    <div class="center more" id="col-more" hidden><button class="btn ghost" type="button">Mostrar mais</button></div>`;
  const shelves = root.querySelector('#shelves');
  const more = root.querySelector('#col-more');
  let list = [];
  let shown = 0;
  let lastGroup = null;
  let ul = null;
  const groupOf = (card) => frameOf(card);
  const groupRank = new Map(pool.map((card) => [card.id, GROUPS.findIndex(([id]) => id === groupOf(card))]));

  const rebuild = () => {
    const found = pool.filter((card) => matchesQuery(card, filters.query)
      && (filters.archetype === 'all' || card.archetype === filters.archetype)
      && (filters.status === 'all' || (filters.status === 'have') === Boolean(owned[card.id])));
    // Dentro de cada estante, o que você tem vem primeiro; depois por nome.
    list = found.sort((a, b) => groupRank.get(a.id) - groupRank.get(b.id)
      || Boolean(owned[b.id]) - Boolean(owned[a.id]) || byName(a.name, b.name));
    shown = 0;
    lastGroup = null;
    shelves.innerHTML = list.length ? '' : '<p class="empty-note">Nenhuma carta com esse filtro.</p>';
    next();
  };
  const next = () => {
    const slice = list.slice(shown, shown + PAGE);
    shown += slice.length;
    for (const card of slice) {
      const group = groupOf(card);
      if (group !== lastGroup) {
        const members = list.filter((item) => groupOf(item) === group);
        shelves.insertAdjacentHTML('beforeend', `<section class="shelf"><h2>${GROUPS.find(([id]) => id === group)[1]} <span>${members.filter((item) => owned[item.id]).length}/${members.length}</span></h2><ul class="binder"></ul></section>`);
        ul = shelves.lastElementChild.querySelector('ul');
        lastGroup = group;
      }
      ul.insertAdjacentHTML('beforeend', owned[card.id]
        ? `<li><button class="slot" type="button" data-id="${card.id}" aria-label="Ver ${escape(card.name)}"><span class="card ${foilClass(card, foils)}">${classicImg(card, 'loading="lazy"')}</span>${owned[card.id] > 1 ? `<span class="copies">×${owned[card.id]}</span>` : ''}</button></li>`
        : `<li><div class="slot missing" aria-label="${escape(card.name)}, ainda não obtida"><span class="card"><img src="${BACK}" alt="" loading="lazy"></span><span class="missing-name" aria-hidden="true">${escape(card.name)}</span></div></li>`);
    }
    paintCards(shelves);
    shelves.querySelectorAll('.slot:not(.missing) .card:not([data-tilt])').forEach((node) => { node.dataset.tilt = '1'; tilt(node, 10); });
    more.hidden = shown >= list.length;
    more.querySelector('button').textContent = `Mostrar mais (${list.length - shown} restantes)`;
  };
  rebuild();
  more.querySelector('button').addEventListener('click', next);
  infinite(more, next);

  root.querySelector('#col-search').addEventListener('input', debounce((event) => { filters.query = event.target.value.trim().toLowerCase(); rebuild(); }));
  root.querySelector('#col-archetype').addEventListener('change', (event) => { filters.archetype = event.target.value; rebuild(); });
  root.querySelector('.chips').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-status]');
    if (!chip) return;
    filters.status = chip.dataset.status;
    root.querySelectorAll('.chip').forEach((node) => { node.classList.toggle('on', node === chip); node.setAttribute('aria-checked', String(node === chip)); });
    rebuild();
  });
  shelves.addEventListener('click', (event) => {
    const slot = event.target.closest('.slot[data-id]');
    if (slot) inspect(byId(slot.dataset.id));
  });
}

const RESULT_NAME = { win: 'Vitória', draw: 'Empate', loss: 'Derrota' };
function pvpRows() {
  const duels = readJson(`rushdaily-classic-pvp:${playerKey}`, []);
  if (!duels.length) return '';
  return `<h2 class="sub">Contra amigos</h2><ol class="days">${duels.slice(0, 10).map((duel) => `<li class="day ${RESULT_NAME[duel.result] ? duel.result : ''}"><span class="day-date">Deck de ${escape(duel.vs)}, ${longDate(duel.date)}${Number.isFinite(duel.turns) && duel.turns > 0 ? ` · ${duel.turns} turno${duel.turns > 1 ? 's' : ''}` : ''}${Number.isFinite(duel.lp) ? ` · você terminou com ${duel.lp.toLocaleString('pt-BR')} PV` : ''}</span><span class="stamp">${RESULT_NAME[duel.result] || 'Sem resultado'}</span>${typeof duel.replay === 'string' && /^[A-Za-z0-9_-]+$/.test(duel.replay) ? `<a class="replay-link" href="arena.html#r=${duel.replay}">Replay</a>` : ''}</li>`).join('')}</ol><h2 class="sub">Desafios do dia</h2>`;
}

function renderHistory() {
  const entries = Object.entries(readJson('rushdaily-history', {})[playerKey] || {}).sort(([a], [b]) => b.localeCompare(a));
  const wins = entries.filter(([, result]) => result === 'win').length;
  // Sequência: vitórias em dias seguidos, contando de hoje (ou de ontem, se hoje ainda não jogou).
  const results = Object.fromEntries(entries);
  const dayBefore = (iso) => { const [y, m, d] = iso.split('-').map(Number); const at = new Date(y, m - 1, d - 1); return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`; };
  let streak = 0;
  for (let day = results[date] ? date : dayBefore(date); results[day] === 'win'; day = dayBefore(day)) streak += 1;
  root.innerHTML = `${head('Histórico')}
    <dl class="stats">
      <div class="sheet"><dt>Vitórias</dt><dd>${wins}</dd></div>
      <div class="sheet"><dt>Duelos</dt><dd>${entries.length}</dd></div>
      <div class="sheet"><dt>Sequência</dt><dd>${streak}</dd></div>
    </dl>
    ${pvpRows()}
    ${entries.length ? `<ol class="days">${entries.map(([day, result]) => `
      <li class="day ${RESULT_NAME[result] ? escape(result) : ''}">
        <span class="day-date">${longDate(day)}</span>
        <span class="stamp">${RESULT_NAME[result] || 'Sem resultado'}</span>
      </li>`).join('')}</ol>` : `<div class="empty sheet"><p>Nenhum duelo registrado ainda.</p><a class="btn" href="index.html?player=${playerKey}">Ver o desafio de hoje</a></div>`}`;
}

const BACKS = { rubi: BACK, safira: BACK };
const FOIL_NAMES = { star: 'Estrelas', etched: 'Gravado', prism: 'Prisma', gold: 'Ouro', galaxy: 'Galáxia' };
const TIER_COPY = {
  common: 'Booster',
  silver: 'Booster Prata: duas raras e mais foil.',
  gold: 'Booster Ouro: todas com foil e uma LEGEND garantida!',
  galaxy: 'Booster Galáxia: duas LEGEND com foil cósmico. Sorte rara!',
};

function summary(result) {
  const fresh = result.cards.filter((entry) => entry.isNew).length;
  return `${result.theme || fresh ? `<p class="pull-note">${[result.theme && `Edição ${escape(result.theme)}`, fresh && `${fresh} carta${fresh > 1 ? 's' : ''} nova${fresh > 1 ? 's' : ''} na coleção`].filter(Boolean).join(' · ')}</p>` : ''}<ul class="pull-summary">${result.cards.map((entry) => {
    const card = byId(entry.id);
    return `<li><button type="button" data-id="${entry.id}"><span class="dot ${entry.rare ? 'rare' : ''}"></span>${escape(card.name)}${entry.isNew ? '<strong class="new-tag">Nova</strong>' : ''}${entry.foil ? `<em>${FOIL_NAMES[entry.foil]}</em>` : ''}</button></li>`;
  }).join('')}</ul>`;
}

const TIER_NAME = { common: 'Booster', silver: 'Booster Prata', gold: 'Booster Ouro', galaxy: 'Booster Galáxia' }; // = PACK_TIERS[...].label (scene.js)

const SHOWCASE = ['common', 'silver', 'gold'];
// Dificuldades que dão cada raridade como piso (o Ouro junta Elite e Caos).
const tierDifficulties = (id) => listDifficulties().filter((item) => DIFFICULTY_FLOOR[item.rating - 1] === id).map((item) => item.label).join(' e ');

async function renderReward() {
  const sceneModule = loadScene(); // baixa o Three.js enquanto o resto da tela é montado
  const rewardKey = `rushdaily-reward:${playerKey}:${date}`;
  const boosterKey = `rushdaily-classic-booster:${playerKey}:${date}`;
  const pending = readJson(rewardKey, null);
  const opened = readJson(boosterKey, null);
  const locked = !pending?.pending && !opened;
  const result = opened ? { tier: 'common', layout: 'arc', ...opened, cards: opened.cards.filter((entry) => byId(entry.id)) }
    : locked ? null : openBooster(pending.seed, { owned: readCollection(playerKey), pity: readJson(pityKey(playerKey), 0), difficulty: pending.difficulty });
  const reduced = settingsFor(playerKey).reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wonToday = readJson('rushdaily-history', {})[playerKey]?.[date] === 'win';
  const tierName = result ? TIER_NAME[result.tier] || 'Booster' : 'Booster';
  root.innerHTML = `${head(locked ? 'Booster do dia' : opened ? `${tierName} de hoje` : 'Booster liberado',
    locked ? 'Vença o duelo de hoje para liberar 5 cartas.'
      : opened ? 'Toque numa carta para ler.'
        : 'Toque no pacote para abrir.')}
    <div class="pack-row ${opened ? 'solo' : ''}" id="pack-row">
    <div class="pack-stage ${locked ? 'locked' : ''}"><canvas class="pack-canvas" id="pack-canvas" aria-label="Booster em 3D"></canvas>
      ${locked || opened ? '' : '<button class="pack-hit" type="button" id="pack" aria-label="Abrir booster"></button>'}</div>
    <section class="tier-ref" aria-labelledby="tier-ref-title"><h2 id="tier-ref-title">Versões do booster</h2>
      <canvas class="tier-canvas" id="tier-canvas" aria-label="Boosters Comum, Prata e Ouro em 3D"></canvas>
      <ul class="tier-legend">${SHOWCASE.map((id) => `<li><b>${TIER_NAME[id]}</b><span>${tierDifficulties(id)}</span></li>`).join('')}</ul>
      <p class="tier-note">Qualquer pacote pode sair melhor por sorte; a Elite e o Caos ainda têm chance de Galáxia.</p></section>
    </div>
    <div class="pack-controls" id="pack-controls" ${opened ? '' : 'hidden'}>
      <p class="pack-hint" id="pack-hint">${opened ? '' : 'Toque nas cartas para virar.'}</p>
      <div class="center"><button class="btn" type="button" id="reveal-all" ${opened ? 'hidden' : ''}>Revelar todas</button> <a class="btn ghost" href="screens.html?screen=collection&player=${playerKey}">Ver coleção</a></div>
      <div id="pack-summary">${opened ? summary(result) : ''}</div>
    </div>
    ${locked ? `<div class="center"><a class="btn big" href="index.html?player=${playerKey}">Ir para o desafio</a></div>` : ''}`;

  const copy = (text) => { root.querySelector('.screen-head p').textContent = text; };
  // O toque no pacote vale desde já: a cena 3D (e as frentes das cartas) termina de carregar enquanto ele espera.
  let packReady;
  const scene = new Promise((resolve) => { packReady = resolve; });
  root.querySelector('#pack')?.addEventListener('click', async (event) => {
    event.currentTarget.remove();
    // Salva antes da animação: fechar a aba no meio não perde o pacote.
    const collection = readCollection(playerKey);
    const foils = readJson(foilsKey(playerKey), {});
    for (const entry of result.cards) {
      entry.isNew = !collection[entry.id];
      collection[entry.id] = (collection[entry.id] || 0) + 1;
      if (entry.foil) foils[entry.id] = [...new Set([...(foils[entry.id] || []), entry.foil])];
    }
    writeJson(boosterKey, { openedAt: new Date().toISOString(), seed: pending.seed, ...result });
    writeCollection(playerKey, collection);
    writeJson(foilsKey(playerKey), foils);
    writeJson(pityKey(playerKey), result.tier === 'common' ? readJson(pityKey(playerKey), 0) + 1 : 0);
    removeKey(rewardKey);
    root.querySelector('#pack-row').classList.add('solo'); // as 5 cartas precisam da largura toda: a vitrine desce
    copy('Abrindo…');
    await (await scene).open();
    root.querySelector('#pack-controls').hidden = false;
    copy('Toque nas cartas para virar, ou revele todas.');
  });

  const fronts = result ? await Promise.all(result.cards.map((entry) => classicCardUrl(byId(entry.id)))) : [];
  const { boosterScene } = await sceneModule;
  const pack = boosterScene(root.querySelector('#pack-canvas'), {
    mark: 'src/assets/logo-mark.png',
    subtitle: result?.theme ? `Edição ${result.theme}` : longDate(date),
    tier: result?.tier,
    disguise: result?.disguise,
    layout: result?.layout,
    opened: Boolean(opened),
    reduced,
    cards: (result?.cards || []).map((entry, index) => ({ front: fronts[index], back: BACKS[entry.back] || BACK, foil: entry.foil, rare: entry.rare })),
    piece: result && wonToday ? { index: Number(date.slice(8)) - 1, total: daysInMonth() } : null,
    onPiece: () => { location.href = `screens.html?screen=puzzle&fresh=${Number(date.slice(8)) - 1}&player=${playerKey}`; },
    onInspect: (index) => inspect(byId(result.cards[index].id)),
    onAllRevealed: () => {
      root.querySelector('#pack-summary').innerHTML = summary(result);
      root.querySelector('#reveal-all').hidden = true;
      const hint = root.querySelector('#pack-hint');
      hint.textContent = wonToday ? `Peça do dia ${Number(date.slice(8))}: ela desceu sobre as cartas, toque nela para ver o Enigma.` : '';
      hint.classList.toggle('piece-note', wonToday);
      root.querySelector('.screen-head h1').textContent = TIER_COPY[result.tier] && result.tier !== 'common' ? `${tierName}!` : 'Seu booster';
      copy('Toque numa carta para ler.');
      if (result.tier !== 'common') toast(TIER_COPY[result.tier]);
    },
  });
  sceneModule.then(({ tierShowcase }) => tierShowcase(root.querySelector('#tier-canvas'), { mark: 'src/assets/logo-mark.png', reduced }));
  window.__packCards = (index) => pack.cardAt(index); // usado pelos testes automáticos
  window.__pack = pack;
  root.querySelector('#pack-summary').addEventListener('click', (event) => { const item = event.target.closest('[data-id]'); if (item) inspect(byId(item.dataset.id)); });
  root.querySelector('#reveal-all').addEventListener('click', () => pack.revealAll());
  packReady(pack);
}

function renderPuzzle() {
  const month = monthOf(date);
  const total = daysInMonth(month);
  const owned = monthPieces(playerKey, month);
  const recovered = recoveredDays(playerKey).filter((day) => monthOf(day) === month).map((day) => Number(day.slice(8)) - 1);
  const charges = heartCharges(playerKey).length;
  const todayIndex = Number(date.slice(8)) - 1;
  const seenKey = `rushdaily-enigma-seen:${playerKey}:${month}`; // peças cuja animação de encaixe já tocou
  const unseen = owned.filter((index) => !readJson(seenKey, []).includes(index));
  const fresh = unseen.length ? unseen[unseen.length - 1] : null; // a mais nova ainda não animada
  if (unseen.length) writeJson(seenKey, owned);
  const missed = Array.from({ length: todayIndex }, (_, index) => index).filter((index) => !owned.includes(index));
  const dayIso = (index) => `${month}-${String(index + 1).padStart(2, '0')}`;
  const recoverHref = (index) => `arena.html?dia=${dayIso(index)}&player=${playerKey}`;
  const status = owned.length === total ? 'Completo: virou um Coração das Cartas.'
    : missed.length ? `${owned.length} de ${total} peças. ${missed.length === 1 ? 'Um dia ficou' : `${missed.length} dias ficaram`} sem vitória: recupere vencendo o puzzle daquele dia.`
      : `${owned.length} de ${total} peças. Vença (ou recupere no puzzle) todos os dias para ganhar o Coração.`;
  document.querySelector('.felt')?.classList.add('seal'); // o selo só aparece aqui, onde faz sentido
  root.innerHTML = `${head(`Enigma de ${monthName(month)}`, status)}
    <div class="puzzle-layout">
      <div class="puzzle-stage"><canvas id="puzzle-canvas" aria-label="Enigma do Milênio com ${owned.length} de ${total} peças"></canvas></div>
      <aside class="heart scroll ${charges ? 'on' : ''}">
        <h2>Coração das Cartas</h2>
        <p>Mês completo, vencido ou recuperado, vira uma carga: no desafio do dia, 1 vez por duelo, escolha qualquer carta do seu deck e coloque na mão.</p>
        <ol class="calendar" aria-label="Dias de ${monthName(month)}">${Array.from({ length: total }, (_, index) => {
          const state = recovered.includes(index) ? 'recovered' : owned.includes(index) ? 'won' : index < todayIndex ? 'missed' : index === todayIndex ? 'today' : 'later';
          const label = { won: 'vencido', recovered: 'recuperado no puzzle', missed: 'sem vitória, toque para recuperar', today: 'hoje', later: 'ainda não chegou' }[state];
          return state === 'missed'
            ? `<li class="missed"><a href="${recoverHref(index)}" aria-label="Recuperar dia ${index + 1}" title="Recuperar dia ${index + 1}">${index + 1}</a></li>`
            : `<li class="${state}" aria-label="Dia ${index + 1}, ${label}">${index + 1}</li>`;
        }).join('')}</ol>
        ${missed.length ? `<div class="recover">
          <p>Perdeu um dia? Toque no dia riscado no calendário para jogar o puzzle "vença neste turno" daquele dia e recuperar a peça.</p>
        </div>` : ''}
        ${recovered.length ? `<p class="recover-note"><i class="recover-dot" aria-hidden="true"></i>${recovered.length} dia${recovered.length > 1 ? 's' : ''} recuperado${recovered.length > 1 ? 's' : ''} no puzzle.</p>` : ''}
        <p class="heart-state">${charges ? `${charges} carga${charges > 1 ? 's' : ''} pronta${charges > 1 ? 's' : ''} para usar.` : 'Nenhuma carga ainda.'}</p>
        <p class="credit">Modelo 3D: Millennium Puzzle Remix, de TechSpiderbot (Printables), CC BY-NC-SA, a partir do enigma de Sho Tozuka.</p>
      </aside>
    </div>`;
  const canvas = root.querySelector('#puzzle-canvas');
  loadScene().then(({ puzzleScene }) => puzzleScene(canvas, {
    assemble: new URLSearchParams(location.search).get('demo') === '1',
    owned,
    total,
    fresh,
    reduced: settingsFor(playerKey).reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches,
  }));
}

const KIND_LABEL = { monster: 'Monstros', spell: 'Magias', trap: 'Armadilhas' };
const kindOf = (card) => (isMonster(card) ? 'monster' : card.type & TYPE.SPELL ? 'spell' : 'trap');

const LEVEL_BANDS = [['1-4', 'Nível 1–4', (card) => levelOf(card) <= 4], ['5-6', 'Nível 5–6', (card) => levelOf(card) >= 5 && levelOf(card) <= 6], ['7+', 'Nível 7+', (card) => levelOf(card) >= 7]];
const SORTS = {
  pop: ['Mais populares', (a, b) => (b.pop || 0) - (a.pop || 0)],
  atk: ['Maior ATK', (a, b) => (b.atk ?? -1) - (a.atk ?? -1)],
  level: ['Maior nível', (a, b) => levelOf(b) - levelOf(a)],
  name: ['Nome', (a, b) => byName(a.name, b.name)],
};

/**
 * Completa o deck mantendo o que já está nele. Usa o gerador de decks (sinergia de decks reais) só com o que o jogador tem
 * e, se faltar carta, preenche o Principal até o mínimo com as mais populares da coleção.
 */
async function autoDeck(owned, main, extra) {
  const { synergy, templates } = await loadDeckHints();
  const used = new Map();
  for (const id of [...main, ...extra]) used.set(id, (used.get(id) || 0) + 1);
  const room = (id) => Math.min(3, owned[id] || 0) - (used.get(id) || 0);
  const take = (id, list) => { list.push(id); used.set(id, (used.get(id) || 0) + 1); };
  const mine = pool.filter((card) => owned[card.id]);
  try {
    const built = buildDeck({ seed: `auto:${playerKey}:${Date.now()}`, pool: mine, synergy, templates, format: PVP_FORMAT });
    for (const id of built.main) if (main.length < MAIN_MIN && room(id) > 0) take(id, main);
    for (const id of built.extra) if (extra.length < EXTRA_MAX && room(id) > 0) take(id, extra);
  } catch { /* coleção pequena demais para o gerador: o preenchimento abaixo resolve */ }
  const popular = mine.filter((card) => !isExtra(card)).sort(SORTS.pop[1]);
  for (const card of popular) while (main.length < MAIN_MIN && room(card.id) > 0) take(card.id, main);
  return { main, extra };
}

function renderDeck() {
  const owned = readCollection(playerKey);
  const foils = readJson(foilsKey(playerKey), {});
  const params = new URLSearchParams(location.search);
  const challenge = decodeDeck(params.get('vs'));
  if (params.get('vs') && !challenge) setTimeout(() => toast('Link de desafio inválido. Peça um novo link ao seu amigo.'), 300);
  if (params.get('problem')) setTimeout(() => toast(`Este deck ainda não pode duelar: ${params.get('problem')}`), 300);
  const decks = readDecks(playerKey);
  if (!decks.list.length) { decks.list.push({ id: 'd1', name: 'Deck 1', main: [], extra: [], updatedAt: Date.now() }); decks.active = 'd1'; }
  if (!decks.list.some((item) => item.id === decks.active)) decks.active = decks.list[0].id;
  let editing = decks.list.some((item) => item.id === params.get('deck')) ? params.get('deck') : decks.active;
  const filters = { kind: 'all', query: '', archetype: 'all', level: 'all', sort: 'pop' };
  let gridLimit = PAGE;
  const current = () => decks.list.find((item) => item.id === editing);
  const persist = () => { current().updatedAt = Date.now(); writeDecks(playerKey, decks); };
  // Cartas que o jogador não tem (ou que passam das cópias que tem) saem do deck ao abrir.
  for (const item of decks.list) {
    const used = new Map();
    const fit = (ids = []) => ids.filter((id) => {
      const n = (used.get(id) || 0) + 1;
      used.set(id, n);
      return byId(id) && n <= Math.min(3, owned[id] || 0);
    });
    item.main = fit(item.main);
    item.extra = fit(item.extra);
  }

  root.innerHTML = `${head('Seus decks', challenge ? `Escolha um deck para aceitar o desafio de ${challenge.key}.` : `Salvo na hora. O deck principal abre os desafios.`)}
    <nav class="deck-tabs" id="deck-tabs" aria-label="Seus decks"></nav>
    <div class="builder">
      <section class="binder-pane" aria-label="Sua coleção">
        <div class="toolbar">
          <input type="search" id="deck-search" placeholder="Buscar carta" aria-label="Buscar carta">
          <div class="chips" role="radiogroup" aria-label="Tipo de carta">${[['all', 'Todas'], ['monster', 'Monstros'], ['spell', 'Magias'], ['trap', 'Armadilhas'], ['extra', 'Adicional']].map(([value, text]) => `<button type="button" class="chip ${value === 'all' ? 'on' : ''}" data-kind="${value}" role="radio" aria-checked="${value === 'all'}">${text}</button>`).join('')}</div>
          <div class="selects">
            <select id="deck-archetype" aria-label="Arquétipo">${archetypeOptions()}</select>
            <select id="deck-level" aria-label="Nível"><option value="all">Todos os níveis</option>${LEVEL_BANDS.map(([id, text]) => `<option value="${id}">${text}</option>`).join('')}</select>
            <select id="deck-sort" aria-label="Ordenar">${Object.entries(SORTS).map(([id, [text]]) => `<option value="${id}">${text}</option>`).join('')}</select>
          </div>
        </div>
        <ul class="mini-grid" id="owned-grid"></ul>
        <a class="deck-jump" href="#deck-pane" id="deck-jump"></a>
      </section>
      <aside class="deck-pane sheet" id="deck-pane" aria-label="Deck">
        <div class="deck-title">
          <input id="deck-name" maxlength="24" aria-label="Nome do deck" autocomplete="off">
          <span class="badge" id="deck-badge">Principal</span>
        </div>
        <div class="deck-count"><b id="deck-count"></b><span>de ${MAIN_MIN}–${MAIN_MAX}</span><span class="extra-count">Adicional <b id="deck-extra-count"></b>/${EXTRA_MAX}</span></div>
        <div class="progress"><i id="deck-bar"></i></div>
        <ul class="problems" id="deck-problems"></ul>
        <div class="deck-stats" id="deck-stats"></div>
        <h3 class="deck-sub">Principal</h3>
        <ol class="deck-list" id="deck-main"></ol>
        <h3 class="deck-sub">Adicional</h3>
        <ol class="deck-list" id="deck-extra"></ol>
        <div class="deck-actions">
          <button class="btn ghost" type="button" id="deck-auto">Completar automático</button>
          <button class="btn ghost" type="button" id="deck-clear">Limpar</button>
          <button class="btn ghost" type="button" id="deck-active">Tornar principal</button>
          <button class="btn ghost" type="button" id="deck-copy">Duplicar</button>
          <button class="btn ghost danger" type="button" id="deck-delete">Apagar</button>
        </div>
        <div class="deck-share">
          <button class="btn big" type="button" id="deck-challenge">${challenge ? 'Aceitar desafio' : 'Desafiar amigos'}</button>
          <p class="note">${challenge ? `Você duela com este deck contra o deck de ${challenge.key}, pilotado pela IA.` : 'Copia um link: quem abrir duela contra este deck, pilotado pela IA.'}</p>
        </div>
      </aside>
    </div>`;

  const countIn = (id) => [...current().main, ...current().extra].filter((item) => item === id).length;
  const drawTabs = () => {
    root.querySelector('#deck-tabs').innerHTML = `${decks.list.map((item) => `<button type="button" class="deck-tab ${item.id === editing ? 'on' : ''}" data-deck="${escape(item.id)}" aria-pressed="${item.id === editing}">
      <span class="tab-name">${item.id === decks.active ? '<i class="star" aria-label="Principal">★</i>' : ''}${escape(item.name)}</span>
      <small class="${validDeck(item, season.cards, owned).ok ? 'ready' : ''}">${item.main.length} + ${item.extra.length}</small></button>`).join('')}
      <button type="button" class="deck-tab add" id="deck-new" aria-label="Novo deck">+ Novo deck</button>`;
  };
  const drawGrid = () => {
    const band = LEVEL_BANDS.find(([id]) => id === filters.level)?.[2];
    const visible = pool.filter((card) => owned[card.id]
      && (filters.kind === 'all' || (filters.kind === 'extra' ? isExtra(card) : kindOf(card) === filters.kind))
      && (filters.archetype === 'all' || card.archetype === filters.archetype)
      && (!band || (isMonster(card) && band(card)))
      && matchesQuery(card, filters.query)).sort(SORTS[filters.sort][1]);
    root.querySelector('#owned-grid').innerHTML = visible.slice(0, gridLimit).map((card) => {
      const left = (owned[card.id] || 0) - countIn(card.id);
      return `<li><button class="pick ${left ? '' : 'used'}" type="button" data-add="${card.id}" ${left ? '' : 'disabled'} aria-label="Adicionar ${escape(card.name)} (${left} disponível)">
        <span class="card ${foilClass(card, foils)}">${classicImg(card, 'loading="lazy"')}</span>
        <span class="pick-count">${left}/${owned[card.id]}</span></button>
        <button class="pick-info" type="button" data-info="${card.id}" aria-label="Ler ${escape(card.name)}">i</button></li>`;
    }).join('') || '<li class="empty-note">Nenhuma carta com esse filtro.</li>';
    if (visible.length > gridLimit) root.querySelector('#owned-grid').insertAdjacentHTML('beforeend', `<li class="grid-more"><button class="btn ghost" type="button" data-more>Mostrar mais (${visible.length - gridLimit} restantes)</button></li>`);
    paintCards(root.querySelector('#owned-grid'));
  };
  const drawStats = (cards) => {
    const monsters = cards.filter(isMonster);
    const bands = LEVEL_BANDS.map(([, text, test]) => [text, monsters.filter(test).length]);
    const peak = Math.max(1, ...bands.map(([, n]) => n));
    const known = monsters.filter((card) => card.atk >= 0);
    const atk = known.length ? Math.round(known.reduce((sum, card) => sum + card.atk, 0) / known.length) : 0;
    const types = ['monster', 'spell', 'trap'].map((type) => `<span><b>${cards.filter((card) => kindOf(card) === type).length}</b> ${KIND_LABEL[type].toLowerCase()}</span>`).join('');
    root.querySelector('#deck-stats').innerHTML = `<p class="types">${types}<span><b>${atk.toLocaleString('pt-BR')}</b> ATK médio</span></p>
      <div class="curve" role="img" aria-label="Curva de níveis: ${bands.map(([text, n]) => `${text}: ${n}`).join(', ')}">${bands.map(([text, n]) => `<div><b>${n}</b><i style="--h:${(n / peak) * 100}%"></i><span>${text.replace('Nível ', '')}</span></div>`).join('')}</div>`;
  };
  const meta = (card) => (!isMonster(card) ? (card.type & TYPE.SPELL ? 'Magia' : 'Armadilha')
    : `${card.type & TYPE.LINK ? 'L' : card.type & TYPE.XYZ ? 'Cl' : 'Nv'} ${levelOf(card)} · ${card.atk < 0 ? '?' : card.atk}`);
  const rowsOf = (ids, zone) => {
    const grouped = new Map();
    for (const id of ids) grouped.set(id, (grouped.get(id) || 0) + 1);
    const order = { monster: 0, spell: 1, trap: 2 };
    const rows = [...grouped].map(([id, count]) => [byId(id), count]).sort(([a], [b]) => order[kindOf(a)] - order[kindOf(b)] || levelOf(b) - levelOf(a) || byName(a.name, b.name));
    return rows.map(([card, count]) => `<li><button type="button" data-remove="${card.id}" data-zone="${zone}" aria-label="Tirar uma cópia de ${escape(card.name)}">
      ${classicImg(card, 'loading="lazy"')}<span class="row-name">${escape(card.name)}</span><span class="row-meta">${meta(card)}</span><b>×${count}</b></button></li>`).join('') || `<li class="empty-note">${zone === 'main' ? 'Toque nas cartas da coleção para colocar aqui.' : 'Fusão, Sincro, Xyz e Link vão para cá.'}</li>`;
  };
  const drawDeck = () => {
    const deck = current();
    root.querySelector('#deck-main').innerHTML = rowsOf(deck.main, 'main');
    root.querySelector('#deck-extra').innerHTML = rowsOf(deck.extra, 'extra');
    paintCards(root.querySelector('.deck-pane'));
    const check = validDeck(deck, season.cards, owned);
    const name = root.querySelector('#deck-name');
    if (document.activeElement !== name) name.value = deck.name;
    root.querySelector('#deck-badge').hidden = deck.id !== decks.active;
    root.querySelector('#deck-active').hidden = deck.id === decks.active;
    root.querySelector('#deck-delete').disabled = decks.list.length < 2;
    root.querySelector('#deck-count').textContent = deck.main.length;
    root.querySelector('#deck-extra-count').textContent = deck.extra.length;
    root.querySelector('#deck-bar').style.width = `${Math.min(100, (deck.main.length / MAIN_MIN) * 100)}%`;
    root.querySelector('#deck-problems').innerHTML = check.ok ? '<li class="ok">Deck pronto para duelar.</li>' : check.problems.slice(0, 3).map((problem) => `<li>${escape(problem)}</li>`).join('');
    root.querySelector('#deck-challenge').disabled = !check.ok;
    root.querySelector('#deck-jump').innerHTML = `<i>Principal <b>${deck.main.length}</b>/${MAIN_MIN}–${MAIN_MAX}</i><i>Adicional <b>${deck.extra.length}</b>/${EXTRA_MAX}</i><span>${check.ok ? 'Pronto ✓' : 'Ver deck ↓'}</span>`;
    drawStats(deck.main.map(byId));
  };
  const draw = () => { drawTabs(); drawGrid(); drawDeck(); };
  const changed = () => { persist(); draw(); };
  // Ao adicionar/remover só o contador da grade muda: redesenha sem voltar ao início da lista.
  draw();

  root.querySelector('#deck-tabs').addEventListener('click', (event) => {
    if (event.target.closest('#deck-new')) {
      const id = `d${Date.now().toString(36)}`;
      decks.list.push({ id, name: `Deck ${decks.list.length + 1}`, main: [], extra: [], updatedAt: Date.now() });
      editing = id;
      changed();
      root.querySelector('#deck-name').select();
      return;
    }
    const tab = event.target.closest('[data-deck]');
    if (tab) { editing = tab.dataset.deck; draw(); }
  });
  root.querySelector('#deck-name').addEventListener('input', (event) => {
    const name = event.target.value.trim();
    if (!name) return; // campo vazio mantém o nome anterior (o blur devolve o texto)
    current().name = name;
    persist();
    drawTabs();
  });
  root.querySelector('#deck-name').addEventListener('blur', drawDeck);
  const refilter = () => { gridLimit = PAGE; drawGrid(); };
  root.querySelector('#deck-search').addEventListener('input', debounce((event) => { filters.query = event.target.value.trim().toLowerCase(); refilter(); }));
  for (const key of ['archetype', 'level', 'sort']) root.querySelector(`#deck-${key}`).addEventListener('change', (event) => { filters[key] = event.target.value; refilter(); });
  root.querySelector('.chips').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-kind]');
    if (!chip) return;
    filters.kind = chip.dataset.kind;
    root.querySelectorAll('.chip').forEach((node) => { node.classList.toggle('on', node === chip); node.setAttribute('aria-checked', String(node === chip)); });
    refilter();
  });
  root.querySelector('#owned-grid').addEventListener('click', (event) => {
    if (event.target.closest('[data-more]')) { gridLimit += PAGE; drawGrid(); return; }
    const info = event.target.closest('[data-info]');
    if (info) { inspect(byId(info.dataset.info)); return; }
    const pick = event.target.closest('[data-add]');
    if (!pick) return;
    const card = byId(pick.dataset.add);
    const zone = isExtra(card) ? current().extra : current().main;
    if (zone.length >= (isExtra(card) ? EXTRA_MAX : MAIN_MAX)) { toast(isExtra(card) ? `O Deck Adicional aceita até ${EXTRA_MAX} cartas.` : `O Deck Principal aceita até ${MAIN_MAX} cartas.`); return; }
    if (countIn(card.id) >= 3) { toast('No máximo 3 cópias da mesma carta.'); return; }
    zone.push(card.id);
    persist();
    drawTabs(); drawDeck();
    // Atualiza só a contagem do botão tocado, sem recriar a grade.
    const left = (owned[card.id] || 0) - countIn(card.id);
    pick.classList.toggle('used', !left);
    pick.disabled = !left;
    pick.querySelector('.pick-count').textContent = `${left}/${owned[card.id]}`;
    pick.setAttribute('aria-label', `Adicionar ${card.name} (${left} disponível)`);
  });
  root.querySelector('.deck-pane').addEventListener('click', (event) => {
    const row = event.target.closest('[data-remove]');
    if (!row) return;
    const zone = current()[row.dataset.zone];
    zone.splice(zone.indexOf(Number(row.dataset.remove)), 1);
    changed();
  });
  root.querySelector('#deck-auto').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const before = current().main.length + current().extra.length;
    button.disabled = true;
    button.textContent = 'Completando…';
    await new Promise((resolve) => setTimeout(resolve, 30)); // deixa o botão se redesenhar antes da conta pesada
    const { main, extra } = await autoDeck(owned, [...current().main], [...current().extra]);
    Object.assign(current(), { main, extra });
    changed();
    button.disabled = false;
    button.textContent = 'Completar automático';
    const added = main.length + extra.length - before;
    const short = MAIN_MIN - main.length;
    toast(short > 0 ? `Sua coleção não tem cartas para chegar a ${MAIN_MIN}: faltam ${short}. Abra boosters vencendo o desafio do dia.`
      : added ? `Adicionei ${added} carta${added > 1 ? 's' : ''} da sua coleção.` : 'O deck já está completo.');
  });
  root.querySelector('#deck-clear').addEventListener('click', () => { Object.assign(current(), { main: [], extra: [] }); changed(); });
  root.querySelector('#deck-active').addEventListener('click', () => { decks.active = editing; decks.activeAt = Date.now(); changed(); toast(`${current().name} agora é o deck principal.`); });
  root.querySelector('#deck-copy').addEventListener('click', () => {
    const copy = { ...current(), id: `d${Date.now().toString(36)}`, name: `${current().name.slice(0, 16)} (cópia)`, main: [...current().main], extra: [...current().extra] };
    decks.list.push(copy);
    editing = copy.id;
    changed();
  });
  root.querySelector('#deck-delete').addEventListener('click', () => {
    if (decks.list.length < 2 || !confirm(`Apagar o deck "${current().name}"?`)) return;
    decks.list = decks.list.filter((item) => item.id !== editing);
    decks.deleted = { ...decks.deleted, [editing]: Date.now() }; // lápide: o outro aparelho não traz o deck de volta
    const wasActive = decks.active === editing;
    if (wasActive) { decks.active = decks.list[0].id; decks.activeAt = Date.now(); }
    editing = decks.active;
    writeDecks(playerKey, decks);
    draw();
    if (wasActive) toast(`${current().name} agora é o deck principal.`);
  });
  root.querySelector('#deck-challenge').addEventListener('click', async () => {
    if (challenge) { location.href = `arena.html?player=${playerKey}&vs=${encodeURIComponent(params.get('vs'))}&deck=${editing}`; return; }
    const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}arena.html?vs=${encodeDeck(playerKey, current())}`;
    try { await navigator.clipboard.writeText(url); toast(`Link do deck ${current().name} copiado. Mande para os amigos.`); } catch { toast(url); }
  });
}

function renderSettings() {
  const settings = settingsFor(playerKey);
  // updatedAt só quando muda a dificuldade (é o que sincroniza; "reduzir animações" é do aparelho).
  const save = (patch) => { writeJson(settingsKey, { ...settingsFor(playerKey), ...patch, ...('difficulty' in patch ? { updatedAt: Date.now() } : {}) }); toast('Ajuste salvo.'); };
  root.innerHTML = `${head('Ajustes')}
    <section class="set-block" aria-labelledby="tier-title">
      <h2 id="tier-title">Dificuldade padrão</h2>
      <div class="tiers" role="radiogroup" aria-labelledby="tier-title">${listDifficulties().map((item) => `
        <label class="tier-card">
          <input type="radio" name="difficulty" value="${item.id}" ${settings.difficulty === item.id ? 'checked' : ''}>
          ${glove(item.rating)}
          <span class="tier-title">${item.label}</span>
          <span class="tier-lp">${item.enemyLp.toLocaleString('pt-BR')}<small>PV do rival</small></span>
          <span class="tier-copy">${escape(item.modifier)}</span>
        </label>`).join('')}</div>
    </section>

    <div class="set-grid">
      <section class="set-block" aria-labelledby="key-title">
        <h2 id="key-title">Sua chave</h2>
        <p class="note">A chave escolhe o seu desafio do dia. Para levar coleção, decks e histórico a outro aparelho, use "Sincronizar aparelhos" abaixo.</p>
        <div class="ticket" aria-label="Chave ${playerKey}">${[...playerKey].map((char) => `<span>${char}</span>`).join('')}</div>
        <form class="key-swap" id="key-swap" novalidate>
          <label for="key-input">Entrar com outra chave</label>
          <div><input id="key-input" name="key" maxlength="6" autocomplete="off" spellcheck="false" placeholder="ABC123" pattern="[A-Za-z0-9]{6}"><button class="btn ghost" type="submit">Entrar</button></div>
        </form>
      </section>

      <section class="set-block" aria-labelledby="fx-title">
        <h2 id="fx-title">Efeitos</h2>
        <label class="switch">
          <input type="checkbox" role="switch" name="reducedMotion" ${settings.reducedMotion ? 'checked' : ''}>
          <span class="switch-track" aria-hidden="true"><i></i></span>
          <span><b>Reduzir animações</b><small>Desliga o 3D, os tremores e as faixas de turno.</small></span>
        </label>
      </section>
    </div>

    <section class="set-block" aria-labelledby="sync-title" id="sync-block"></section>

    <section class="set-block legal" aria-labelledby="legal-title" id="creditos">
      <h2 id="legal-title">Créditos e avisos</h2>
      <p>RushDaily é um <b>projeto de fã, sem fins lucrativos</b>. Não é afiliado, endossado nem patrocinado pela Konami, Shueisha, Kazuki Takahashi / Studio Dice ou 4Kids. Yu-Gi-Oh!, Rush Duel, nomes de cartas, artes, textos e marcas pertencem aos seus donos. Nada é vendido e não há anúncios.</p>
      <p>Artes e dados das cartas: YGOPRODeck e Yugipedia. Motor das regras clássicas: EDOPro (ygopro-core) e scripts ProjectIgnis/CardScripts, AGPL-3.0. Desenho das cartas clássicas: yugioh-card (kooriookami, MIT). 3D: Three.js (MIT). Enigma do Milênio: "Millennium Puzzle Remix", de TechSpiderbot (Printables), CC BY-NC-SA.</p>
      <p><b>Privacidade:</b> com a sincronização ligada, o servidor guarda a sua chave, o seu progresso e as datas de acesso — sem IP, nome ou e-mail. <i>Desligar e apagar do servidor</i> remove tudo isso.</p>
      <p><b>Código-fonte</b> (AGPL-3.0): <a href="https://github.com/clevim/RushDaily" target="_blank" rel="noopener noreferrer">github.com/clevim/RushDaily</a>. Para pedir a remoção de algum conteúdo: <a href="mailto:rushdaily@clevs.dev.br">rushdaily@clevs.dev.br</a>.</p>
    </section>

    <footer class="set-footer"><button class="text-danger" type="button" id="wipe">Apagar coleção, histórico e partidas deste aparelho</button></footer>`;
  root.querySelectorAll('input[name="difficulty"]').forEach((input) => input.addEventListener('change', () => save({ difficulty: input.value })));
  root.querySelector('input[name="reducedMotion"]').addEventListener('change', (event) => save({ reducedMotion: event.target.checked }));
  root.querySelector('#key-swap').addEventListener('submit', (event) => {
    event.preventDefault();
    const key = event.target.key.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(key)) { toast('A chave tem 6 letras ou números, como ABC123.'); return; }
    location.href = `index.html?player=${key}`;
  });
  root.querySelector('#wipe').addEventListener('click', () => {
    const synced = credOf(playerKey)?.status === 'on';
    if (!confirm(`Apagar coleção, decks, histórico e partidas salvas deste aparelho? Sua chave ${playerKey} e os ajustes continuam.${synced ? '\n\nA sincronização está ligada: o progresso volta do servidor na próxima abertura. Para apagar de vez, use antes "Desligar e apagar do servidor".' : ''}`)) return;
    // Mantém a chave, os ajustes e a ligação de sincronização deste aparelho.
    const keep = (key) => key === 'rushdaily-player-key' || key.startsWith('rushdaily-settings:') || key.startsWith('rushdaily-sync:');
    try { Object.keys(localStorage).filter((key) => key.startsWith('rushdaily') && !keep(key)).forEach((key) => localStorage.removeItem(key)); } catch { /* nada salvo */ }
    toast('Dados apagados.');
    setTimeout(() => { location.href = `index.html?player=${playerKey}`; }, 900);
  });
  renderSync(root.querySelector('#sync-block'));
}

/* ---------- Sincronizar aparelhos ---------- */

const SYNC_STATUS = {
  on: 'Ligada: coleção, decks, histórico, Enigma e boosters seguem iguais nos aparelhos ligados.',
  off: 'Desligada neste aparelho. O progresso fica só aqui.',
  taken: 'Esta chave já está ligada a outro aparelho (ou o segredo foi trocado nele).',
  none: 'Ainda não sincronizou: precisa de internet. Tenta sozinha a cada abertura.',
};
const ago = (at) => {
  const minutes = Math.round((Date.now() - at) / 60000);
  return minutes < 1 ? 'agora há pouco' : minutes < 60 ? `há ${minutes} min` : minutes < 1440 ? `há ${Math.round(minutes / 60)} h` : `em ${new Date(at).toLocaleDateString('pt-BR')}`;
};

/**
 * QR estilizado em SVG a partir da matriz do qrcode-generator (só números entram no SVG).
 * Tinta escura sobre marfim (contraste que qualquer câmera lê), pontos redondos, olhos dourados
 * e o selo do jogo no centro: correção H aguenta os ~30% de módulos escondidos pelo selo.
 */
async function qrSvg(text) {
  const { default: qrcode } = await import('../vendor/qrcode/qrcode.mjs');
  const qr = qrcode(0, 'H');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const pad = 4;
  const full = size + pad * 2;
  const eyes = [[0, 0], [size - 7, 0], [0, size - 7]];
  const inEye = (row, col) => eyes.some(([r, c]) => row >= r && row < r + 7 && col >= c && col < c + 7);
  // Selo central: ~1/5 do lado, sempre ímpar para ficar centrado na grade.
  const badge = Math.max(5, Math.round(size / 5) | 1);
  const from = (size - badge) / 2;
  const inBadge = (row, col) => row >= from - 0.5 && row < from + badge + 0.5 && col >= from - 0.5 && col < from + badge + 0.5;
  let dots = '';
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!qr.isDark(row, col) || inEye(row, col) || inBadge(row, col)) continue;
      dots += `M${col + pad + 0.5} ${row + pad + 0.08}a.42 .42 0 1 1 0 .84a.42 .42 0 1 1 0-.84z`;
    }
  }
  const eye = ([r, c]) => {
    const x = c + pad;
    const y = r + pad;
    return `<rect x="${x + 0.5}" y="${y + 0.5}" width="6" height="6" rx="1.6" fill="none" stroke="url(#qr-gold)" stroke-width="1"/>
      <rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="0.8" fill="#1a1208"/>`;
  };
  const b = from + pad;
  return `<svg viewBox="0 0 ${full} ${full}" role="img" aria-label="QR do link de ligação">
    <defs><linearGradient id="qr-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9a6a10"/><stop offset=".5" stop-color="#6e4606"/><stop offset="1" stop-color="#8a5a08"/></linearGradient></defs>
    <rect width="${full}" height="${full}" rx="0.6" fill="#f4ecdc"/>
    <path d="${dots}" fill="#1a1208"/>
    ${eyes.map(eye).join('')}
    <rect x="${b - 0.3}" y="${b - 0.3}" width="${badge + 0.6}" height="${badge + 0.6}" rx="1.4" fill="#0a0807" stroke="url(#qr-gold)" stroke-width="0.35"/>
    <image href="src/assets/logo-mark.png" x="${b + 0.6}" y="${b + 0.6}" width="${badge - 1.2}" height="${badge - 1.2}"/>
  </svg>`;
}

function renderSync(block) {
  const cred = credOf(playerKey);
  const status = cred?.status || 'none';
  const busy = (button, task) => async () => { button.disabled = true; try { await task(); } finally { button.disabled = false; } };
  block.innerHTML = `<h2 id="sync-title">Sincronizar aparelhos</h2>
    <p class="note sync-status ${status === 'taken' ? 'sync-warn' : ''}">${SYNC_STATUS[status] || SYNC_STATUS.none}${status === 'on' && cred.at ? ` Última sincronização ${ago(cred.at)}.` : ''}</p>
    ${status === 'taken' ? `<p class="note">Se o outro aparelho é seu, abra nele <b>Ajustes › Sincronizar aparelhos › Ligar outro aparelho</b> e abra aqui o link ou o QR. Se não é, gere uma chave nova: o progresso deste aparelho vai junto (o desafio do dia e os próximos boosters mudam com a chave).</p>` : ''}
    <div class="sync-actions">
      ${status === 'on' || status === 'none' ? '<button class="btn ghost" type="button" data-sync="now">Sincronizar agora</button>' : ''}
      ${status === 'off' ? '<button class="btn" type="button" data-sync="enable">Ligar sincronização</button>' : ''}
      ${status === 'taken' ? '<button class="btn" type="button" data-sync="new-key">Gerar nova chave</button><button class="btn ghost" type="button" data-sync="retry">Tentar de novo</button>' : ''}
    </div>
    ${status === 'on' ? `<details class="sync-link-box" id="sync-details">
      <summary class="btn">Ligar outro aparelho</summary>
      <div class="sync-reveal" id="sync-reveal"></div>
    </details>
    <div class="sync-actions sync-danger">
      <button class="text-danger" type="button" data-sync="rotate">Trocar o segredo</button>
      <button class="text-danger" type="button" data-sync="off">Desligar neste aparelho</button>
      <button class="text-danger" type="button" data-sync="wipe">Desligar e apagar do servidor</button>
    </div>` : ''}`;

  const on = (name, task) => { const button = block.querySelector(`[data-sync="${name}"]`); button?.addEventListener('click', busy(button, task)); };
  const report = (result) => {
    const text = { on: result.changed ? 'Progresso atualizado com o outro aparelho.' : 'Tudo sincronizado.', taken: 'Esta chave já tem dono em outro aparelho.', offline: 'Sem conexão com o servidor. Tento de novo mais tarde.', schema: 'Outro aparelho usa uma versão mais nova do jogo: recarregue a página.', error: 'O servidor recusou agora. Tente mais tarde.' }[result.status];
    if (text) toast(text);
    renderSync(block);
  };
  on('now', async () => report(await syncNow()));
  on('enable', async () => report(await enableSync(playerKey)));
  on('retry', async () => { writeJson(`rushdaily-sync:${playerKey}`, { ...cred, status: 'on' }); report(await syncNow()); });
  on('new-key', async () => {
    if (!confirm('Gerar uma chave nova e levar para ela o progresso deste aparelho?')) return;
    location.href = `screens.html?screen=settings&player=${moveToNewKey(playerKey)}`;
  });
  on('rotate', async () => {
    if (!confirm('Trocar o segredo? Os outros aparelhos ligados param de sincronizar até abrirem o link novo.')) return;
    toast(await rotateSecret(playerKey) ? 'Segredo trocado. Ligue de novo os outros aparelhos.' : 'Não consegui falar com o servidor.');
    renderSync(block);
  });
  on('off', async () => { await disableSync(playerKey); toast('Sincronização desligada neste aparelho.'); renderSync(block); });
  on('wipe', async () => {
    if (!confirm('Apagar a cópia do servidor e desligar aqui? O progresso deste aparelho continua. Desligue também os outros aparelhos, senão eles enviam tudo de novo.')) return;
    toast(await disableSync(playerKey, { wipeServer: true }) ? 'Cópia do servidor apagada.' : 'Não consegui falar com o servidor.');
    renderSync(block);
  });

  // QR e link só aparecem com a seção aberta; fechar (ou 2 min) apaga da tela.
  const details = block.querySelector('#sync-details');
  let hide = null;
  details?.addEventListener('toggle', async () => {
    const reveal = block.querySelector('#sync-reveal');
    clearTimeout(hide);
    reveal.replaceChildren();
    if (!details.open) return;
    const link = syncLink(playerKey);
    if (!link) return;
    hide = setTimeout(() => { details.open = false; }, 120e3);
    reveal.innerHTML = `<p class="sync-warn"><b>Não compartilhe:</b> este link e o QR dão acesso ao seu progresso. Abra só nos seus aparelhos.</p>
      <div class="sync-qr" aria-hidden="false">${await qrSvg(link)}</div>
      <p class="sync-link"><code></code></p>
      <div class="sync-actions"><button class="btn ghost" type="button" data-link="copy">Copiar link</button>${navigator.share ? '<button class="btn ghost" type="button" data-link="share">Enviar para o meu aparelho</button>' : ''}</div>`;
    reveal.querySelector('code').textContent = link;
    reveal.querySelector('[data-link="copy"]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copiado. Abra no outro aparelho.'); } catch { toast('Não consegui copiar: selecione o link acima.'); }
    });
    reveal.querySelector('[data-link="share"]')?.addEventListener('click', async () => {
      try { await navigator.share({ title: 'Ligar aparelho ao RushDaily', url: link }); } catch { /* cancelado */ }
    });
  });
}

({ collection: renderCollection, deck: renderDeck, history: renderHistory, reward: renderReward, puzzle: renderPuzzle, settings: renderSettings }[screen] || renderCollection)();
