// Utilidades compartilhadas pelas páginas.
const KEY_PATTERN = /^[A-Z0-9]{6}$/;

let keepKey = null; // perfil mantido depois de recusar o ?player= (pergunta uma vez por página)

export function getPlayerKey() {
  const fromUrl = new URLSearchParams(location.search).get('player')?.toUpperCase();
  if (fromUrl && KEY_PATTERN.test(fromUrl)) {
    const current = safeGet('rushdaily-player-key');
    // Um link não troca o perfil salvo em silêncio.
    if (current && current !== fromUrl && KEY_PATTERN.test(current)) {
      keepKey ??= !confirm(`Trocar para o perfil ${fromUrl}? Seu perfil atual é ${current}.`);
      if (keepKey) return current;
    }
    safeSet('rushdaily-player-key', fromUrl);
    takeSyncLink(fromUrl);
    return fromUrl;
  }
  const saved = safeGet('rushdaily-player-key');
  if (saved && KEY_PATTERN.test(saved)) return saved;
  const generated = newPlayerKey();
  safeSet('rushdaily-player-key', generated);
  return generated;
}
// getRandomValues e não randomUUID: este só existe em contexto seguro, e por http (ex.: http://ip-da-lan:4173) a página quebrava.
export const newPlayerKey = () => Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

// Link de ligação de aparelho: index.html?player=K#sync=SEGREDO. O segredo sai da barra de endereço na hora.
function takeSyncLink(playerKey) {
  const secret = new URLSearchParams(location.hash.slice(1)).get('sync');
  if (secret === null) return;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (/^[A-Za-z0-9_-]{22,128}$/.test(secret)) safeSet(`rushdaily-sync:${playerKey}`, JSON.stringify({ secret, rev: 0, status: 'on', linkedAt: Date.now() }));
}

// Data local (não UTC): o desafio vira à meia-noite de quem joga.
export function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function longDate(iso = today()) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
}

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* armazenamento indisponível: segue sem salvar */ }
}

// BigInt (respostas do motor, como as raças declaradas) vai como "__big:N" e volta como BigInt.
const bigOut = (key, value) => (typeof value === 'bigint' ? `__big:${value}` : value);
const bigIn = (key, value) => (typeof value === 'string' && /^__big:\d{1,20}$/.test(value) ? BigInt(value.slice(6)) : value);

export function readJson(key, fallback) {
  try { return JSON.parse(safeGet(key), bigIn) ?? fallback; } catch { return fallback; }
}
let writeHook = null;
/** sync.js registra aqui: gravar progresso agenda um sync. */
export const setWriteHook = (fn) => { writeHook = fn; };
export function writeJson(key, value) { safeSet(key, JSON.stringify(value, bigOut)); writeHook?.(key); }
export function removeKey(key) { try { localStorage.removeItem(key); } catch { /* idem */ } }

/** Acabamento foil por carta (Rush do cards.json): LENDA ouro, monstros fortes prisma, demais estrelas, magia/armadilha gravado. */
export function foil(card, variant) {
  if (variant && /^[a-z0-9-]+$/i.test(String(variant))) return `foil-${variant}`;
  if (card.legend) return 'foil-gold';
  if (!(card.type & 1)) return 'foil-etched';
  return card.atk >= 2000 ? 'foil-prism' : 'foil-star';
}

export function escape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || readJson(`rushdaily-settings:${getPlayerKey()}`, {}).reducedMotion === true;

export function settingsFor(playerKey) {
  return { difficulty: 'duelist', reducedMotion: false, ...readJson(`rushdaily-settings:${playerKey}`, {}) };
}

/** [{ id, count }] na ordem em que cada id aparece primeiro. */
export function uniqueCards(ids) {
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  return [...counts].map(([id, count]) => ({ id, count }));
}

export function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    node.setAttribute('role', 'status');
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(node.timer);
  node.timer = setTimeout(() => node.classList.remove('show'), 2400);
}

// Ícones da barra inferior do celular (traço simples, herdam a cor do texto).
const ICONS = {
  today: '<path d="M12 3 21 19H3Z"/><path d="M12 10v4"/>',
  collection: '<rect x="5" y="3" width="14" height="18"/><path d="M9 3v18M12 8h4M12 12h4"/>',
  deck: '<rect x="4" y="7" width="12" height="14"/><path d="M8 4h12v14"/>',
  reward: '<path d="M7 3h10l2 4v14H5V7Z"/><path d="M5 7h14M12 11l1.5 3 3 .5-2.2 2 .6 3-2.9-1.6-2.9 1.6.6-3-2.2-2 3-.5Z"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3.5"/>',
};

export function nav(active, playerKey) {
  const links = [['index.html', 'today', 'Hoje'], ['screens.html?screen=collection', 'collection', 'Coleção'], ['screens.html?screen=deck', 'deck', 'Deck'], ['screens.html?screen=history', 'history', 'Histórico'], ['screens.html?screen=reward', 'reward', 'Booster'], ['screens.html?screen=puzzle', 'puzzle', 'Enigma'], ['screens.html?screen=settings', 'settings', 'Ajustes']];
  const href = (url) => `${url}${url.includes('?') ? '&' : '?'}player=${playerKey}`;
  const main = ['today', 'collection', 'deck', 'reward'];
  const icon = (id) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${ICONS[id]}</svg>`;
  const rest = links.filter(([, id]) => !main.includes(id));
  return `<header class="topbar">
    <a class="brand" href="index.html" aria-label="RushDaily, início"><img src="src/assets/logo-mark.png" alt="" width="40" height="42"><span>RushDaily</span></a>
    <nav class="tabs" aria-label="Navegação principal">${links.map(([url, id, label]) => `<a href="${href(url)}" ${id === active ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <button class="key-chip" type="button" data-copy-key title="Copiar link com sua chave">Chave <b>${playerKey}</b></button>
    <nav class="bar-nav" aria-label="Navegação no celular">
      ${links.filter(([, id]) => main.includes(id)).map(([url, id, label]) => `<a href="${href(url)}" ${id === active ? 'aria-current="page"' : ''}>${icon(id)}<span>${label}</span></a>`).join('')}
      <button type="button" class="bar-more" aria-expanded="false" aria-controls="bar-menu" ${rest.some(([, id]) => id === active) ? 'aria-current="page"' : ''}>${icon('more')}<span>Mais</span></button>
      <div class="bar-menu plate" id="bar-menu" hidden>${rest.map(([url, id, label]) => `<a href="${href(url)}" ${id === active ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</div>
    </nav>
  </header>`;
}

export function bindKeyChip(playerKey) {
  // Menu no celular: rola até a aba atual e esmaece a borda que ainda tem abas escondidas.
  const tabs = document.querySelector('.tabs');
  const current = tabs?.querySelector('[aria-current]');
  if (tabs) {
    if (current) {
      const [box, item] = [tabs.getBoundingClientRect(), current.getBoundingClientRect()];
      tabs.scrollLeft += item.left - box.left - (box.width - item.width) / 2;
    }
    const edges = () => {
      tabs.classList.toggle('more-left', tabs.scrollLeft > 4);
      tabs.classList.toggle('more-right', tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 4);
    };
    tabs.addEventListener('scroll', edges, { passive: true });
    addEventListener('resize', edges);
    edges();
  }
  const more = document.querySelector('.bar-more');
  const menu = document.querySelector('#bar-menu');
  const setMenu = (open) => { menu.hidden = !open; more.setAttribute('aria-expanded', String(open)); };
  more?.addEventListener('click', () => setMenu(menu.hidden));
  document.addEventListener('click', (event) => { if (menu && !menu.hidden && !event.target.closest('.bar-nav')) setMenu(false); });
  document.querySelector('[data-copy-key]')?.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}index.html?player=${playerKey}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copiado. Abra no outro aparelho para jogar com a mesma chave.');
    } catch {
      toast(`Sua chave é ${playerKey}`);
    }
  });
}

// Inclinação 3D + reflexo holográfico seguindo o ponteiro, com mola (suave na entrada, no movimento e na volta).
export function tilt(node, strength = 14) {
  if (reducedMotion()) return;
  const target = { x: 0.5, y: 0.5, lift: 0 };
  const now = { x: 0.5, y: 0.5, lift: 0 };
  let frame = null;
  const step = () => {
    for (const key of ['x', 'y', 'lift']) now[key] += (target[key] - now[key]) * 0.16;
    node.style.setProperty('--mx', `${now.x * 100}%`);
    node.style.setProperty('--my', `${now.y * 100}%`);
    node.style.transform = `perspective(800px) translateZ(${now.lift * 18}px) rotateY(${(now.x - 0.5) * strength * now.lift}deg) rotateX(${(0.5 - now.y) * strength * now.lift}deg)`;
    const settled = Math.abs(target.x - now.x) + Math.abs(target.y - now.y) + Math.abs(target.lift - now.lift) < 0.002;
    if (settled && !target.lift) { node.style.transform = ''; frame = null; return; }
    frame = requestAnimationFrame(step);
  };
  const wake = () => { if (!frame) frame = requestAnimationFrame(step); };
  node.addEventListener('pointermove', (event) => {
    const rect = node.getBoundingClientRect();
    target.x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    target.y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    target.lift = 1;
    wake();
  });
  node.addEventListener('pointerleave', () => { Object.assign(target, { x: 0.5, y: 0.5, lift: 0 }); wake(); });
}

/** Leitura de uma carta em diálogo: { name, stats, desc, html (a frente), className }. paint(dialog) preenche a imagem. */
export function inspect({ name, stats = '', desc = '', html, className = '' }, paint = () => {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'inspect';
  dialog.setAttribute('aria-label', name);
  dialog.innerHTML = `<div class="card ${className} inspect-card">${html}</div>
    <div class="inspect-copy"><h2>${escape(name)}</h2><p class="inspect-stats">${escape(stats)}</p><p>${escape(desc)}</p>
    <button class="btn ghost" type="button" data-close>Fechar</button></div>`;
  document.body.append(dialog);
  tilt(dialog.querySelector('.inspect-card'), 18);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => { if (event.target === dialog || event.target.closest('[data-close]')) dialog.close(); });
  dialog.showModal();
  paint(dialog);
}

/* ---------- Enigma do Milênio: o calendário do mês ---------- */
// Uma peça por dia do mês. Vencer o desafio do dia encaixa a peça daquele dia (vem direto do histórico).
// Dia perdido do mês atual pode ser recuperado vencendo o puzzle "vença neste turno" daquele dia (arena.html?dia=).
// Vencer (ou recuperar) todos os dias de um mês rende uma carga do Coração das Cartas, guardada até ser usada.

export const foilsKey = (playerKey) => `rushdaily-foils:${playerKey}`;
const heartUsedKey = (playerKey) => `rushdaily-heart-used:${playerKey}`;
/** { "AAAA-MM-DD": id do puzzle vencido } */
export const recoverKey = (playerKey) => `rushdaily-enigma-recover:${playerKey}`;
export const monthOf = (iso = today()) => iso.slice(0, 7);
export function daysInMonth(month = monthOf()) {
  const [year, number] = month.split('-').map(Number);
  return new Date(year, number, 0).getDate();
}
export function monthName(month = monthOf()) {
  const [year, number] = month.split('-').map(Number);
  return new Date(year, number - 1, 1).toLocaleDateString('pt-BR', { month: 'long' });
}
const isDay = (day) => /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(day) && Number(day.slice(8)) >= 1 && Number(day.slice(8)) <= daysInMonth(monthOf(day));

function wins(playerKey) {
  return Object.entries(readJson('rushdaily-history', {})[playerKey] || {}).filter(([, result]) => result === 'win').map(([day]) => day);
}
/** Dias recuperados por puzzle (só datas válidas). */
export function recoveredDays(playerKey) {
  const saved = readJson(recoverKey(playerKey), {});
  return saved && typeof saved === 'object' ? Object.keys(saved).filter(isDay) : [];
}
/** Dá para recuperar: dia do mês atual, antes de hoje, sem vitória no desafio. */
export function canRecover(playerKey, day, now = today()) {
  return typeof day === 'string' && isDay(day) && monthOf(day) === monthOf(now) && day < now && !wins(playerKey).includes(day);
}
export function recoverDay(playerKey, day, puzzleId) {
  if (!canRecover(playerKey, day)) return false;
  writeJson(recoverKey(playerKey), { ...readJson(recoverKey(playerKey), {}), [day]: puzzleId });
  return true;
}
/** Puzzle do dia: o mesmo para todos, escolhido pela data. */
export function puzzleFor(day, ids) {
  let hash = 2166136261;
  for (const char of `puzzle:${day}`) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return ids[(hash >>> 0) % ids.length];
}
const pieceDays = (playerKey) => [...new Set([...wins(playerKey), ...recoveredDays(playerKey)])];

/** Índices das peças do mês (dia 1 = peça 0, a ponta): vitórias e dias recuperados. */
export function monthPieces(playerKey, month = monthOf()) {
  return pieceDays(playerKey).filter((day) => day.startsWith(`${month}-`)).map((day) => Number(day.slice(8)) - 1).sort((a, b) => a - b);
}

/** Meses completos (vencidos ou recuperados) que ainda não viraram poder usado. */
export function heartCharges(playerKey) {
  const byMonth = {};
  for (const day of pieceDays(playerKey)) (byMonth[monthOf(day)] ||= new Set()).add(day);
  const used = readJson(heartUsedKey(playerKey), []);
  return Object.keys(byMonth).filter((month) => byMonth[month].size >= daysInMonth(month) && !used.includes(month)).sort();
}
export function heartUnlocked(playerKey) { return heartCharges(playerKey).length > 0; }
/** Gasta a carga mais antiga. */
export function useHeart(playerKey) {
  const [oldest] = heartCharges(playerKey);
  if (oldest) writeJson(heartUsedKey(playerKey), [...readJson(heartUsedKey(playerKey), []), oldest]);
  return oldest;
}

const FOIL_RANK = ['star', 'etched', 'prism', 'gold', 'galaxy'];
/** O acabamento mais raro que o jogador tem dessa carta (ou nenhum). */
export function bestFoil(playerKey, id) {
  const owned = readJson(foilsKey(playerKey), {})[id] || [];
  return [...owned].sort((a, b) => FOIL_RANK.indexOf(b) - FOIL_RANK.indexOf(a))[0];
}

/** Punho da luva de duelista (Reino dos Duelistas): chips-estrela encaixados marcam a dificuldade. */
let gloveId = 0;
export function glove(rating, max = 4) {
  const id = `g${gloveId += 1}`; // ids únicos: várias luvas na mesma página
  const star = (r) => Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI / 5;
    const radius = index % 2 ? r * 0.45 : r;
    return `${(Math.cos(angle) * radius).toFixed(2)},${(Math.sin(angle) * radius).toFixed(2)}`;
  }).join(' ');
  const slots = Array.from({ length: max }, (_, index) => {
    const x = 40 + index * 40;
    const lit = index < rating;
    return `<g transform="translate(${x} 33)">
      <circle r="13.5" fill="url(#${id}-socket)" stroke="#6b4a1c" stroke-width="1.2"/>
      <circle r="13.5" fill="none" stroke="#000" stroke-opacity=".6" stroke-width="2" transform="translate(0.6 0.8)"/>
      ${lit ? `<polygon points="${star(11)}" fill="url(#${id}-chip)" stroke="#5a3605" stroke-width=".8"/>
      <polygon points="${star(11)}" fill="url(#${id}-shine)" transform="scale(.82)"/>` : `<polygon points="${star(9)}" fill="none" stroke="#3a2a14" stroke-width="1"/>`}
    </g>`;
  }).join('');
  return `<svg class="glove" viewBox="0 0 200 66" role="img" aria-label="${rating} de ${max} chips-estrela">
    <defs>
      <linearGradient id="${id}-leather" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a3424"/><stop offset=".5" stop-color="#2a1c12"/><stop offset="1" stop-color="#140d08"/></linearGradient>
      <radialGradient id="${id}-socket" cx=".4" cy=".35" r=".7"><stop offset="0" stop-color="#1c140d"/><stop offset="1" stop-color="#050302"/></radialGradient>
      <linearGradient id="${id}-chip" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3bd"/><stop offset=".45" stop-color="#f5b21a"/><stop offset="1" stop-color="#8a4f08"/></linearGradient>
      <linearGradient id="${id}-shine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient>
    </defs>
    <path d="M6 14 Q100 2 194 14 V52 Q100 64 6 52 Z" fill="url(#${id}-leather)" stroke="#0a0604" stroke-width="1.5"/>
    <path d="M12 18 Q100 7 188 18 M12 48 Q100 59 188 48" fill="none" stroke="#c98d2a" stroke-opacity=".75" stroke-width="1.1" stroke-dasharray="4 3"/>
    <path d="M6 14 Q100 2 194 14" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width="1"/>
    ${slots}
  </svg>`;
}
