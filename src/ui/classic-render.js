// Imagens das cartas clássicas, desenhadas no navegador só quando aparecem na tela. CONTRATO usado por arena, coleção, decks e booster:
//   classicImg(card, extraAttrs) -> HTML de um <img> da carta (começa com o verso; paintCards troca pela carta)
//   paintCards(root)             -> desenha (sob demanda) os <img data-classic-id> dentro de root
//   classicCardUrl(card)         -> Promise<string> com uma URL utilizável como textura (booster 3D)
// Desenho: yugioh-card (MIT) + Leafer em src/vendor/yugioh-card (bundle de tools/classic/render). Uma instância, uma carta por vez, as visíveis primeiro.
// Cache: memória (blob:) + Cache Storage. Se o desenho falhar ou demorar (ou for miniatura), usa a pré-desenhada (src/assets/classic-cards).
// Alta resolução (HD): imagens exibidas grandes (zoom) em telas densas ganham uma variante 2,5x (1045x1522), com cache próprio e pequeno; troca-se o src quando pronta.
import { SCALE, cardData, patchSpellTrapLabel } from './classic-card-data.js';

// Subir CACHE_VERSION ao mudar moldura/arte/dados das cartas: caches de versões antigas são apagados ao abrir.
const CACHE_PREFIX = 'rushdaily-classic-cards-';
const CACHE_VERSION = 5;
const CACHE_NAME = `${CACHE_PREFIX}v${CACHE_VERSION}`;
const CACHE_HD_NAME = `${CACHE_PREFIX}hd-v${CACHE_VERSION}`;
const CACHE_MAX = 800; // entradas no Cache Storage (~45 KB cada, ~36 MB); acima disso saem as mais antigas
const READY_MAX = 400; // blob: URLs vivas na memória; acima disso revoga as mais antigas
const HD_RATIO = 2.5; // 418x609 -> 1045x1522 (~150 KB cada, ~6 MB decodificada)
const CACHE_HD_MAX = 40; // ~6 MB no Cache Storage
const READY_HD_MAX = 10; // blob: HD vivas (as decodificadas só existem enquanto a imagem está na tela)
const HD_MIN_PX = 520; // largura real (css x devicePixelRatio) acima da qual vale a variante HD
const BACK = 'src/assets/card-back.svg';
// Fichas não têm arte: quadro escuro com um losango dourado no lugar do branco.
const TOKEN_ART = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><defs><radialGradient id="g" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="#2c3a36"/><stop offset="1" stop-color="#0b1210"/></radialGradient></defs><rect width="320" height="320" fill="url(#g)"/><path d="M160 70 250 160 160 250 70 160Z" fill="none" stroke="#d9a93a" stroke-width="6"/><path d="M160 110 210 160 160 210 110 160Z" fill="#d9a93a" opacity=".35"/></svg>')}`;
const prerendered = (id) => `src/assets/classic-cards/${id}.webp`;
const thumbnail = (id) => `src/assets/classic-cards-sm/${id}.webp`; // 140 px, ~10 KB: o que as miniaturas (< THUMB_PX) realmente precisam
const rel = (path) => new URL(`../../${path}`, import.meta.url).href;

const cards = new Map(); // id -> carta (registradas por classicImg/classicCardUrl ou lidas das temporadas)
const urls = new Map(); // id -> Promise<blob URL>
const ready = new Map(); // id -> blob URL já pronto (para trocar o src sem esperar)
const urlsHd = new Map(); // id -> Promise<blob URL HD>
const readyHd = new Map();
const preOk = new Map(); // id -> URL da pré-desenhada (ou miniatura) que já carregou (re-render não volta ao verso)
let chain = Promise.resolve(); // fila única
let renderer = null;
let pool = null;

function registerCard(card) {
  if (card && !cards.has(card.id)) cards.set(card.id, card);
}

async function findCard(id) {
  if (cards.has(id)) return cards.get(id);
  pool ||= (async () => {
    const seasons = await (await fetch(rel('src/data/classic/seasons.json'))).json();
    for (const { season, enabled } of seasons) {
      if (!enabled) continue;
      for (const card of await (await fetch(rel(`src/data/classic/s${season}.json`))).json()) registerCard(card);
    }
  })();
  await pool.catch(() => {});
  return cards.get(id);
}

let cachePromise = null;
let cacheHdPromise = null;
function openCache(hd = false) {
  cachePromise ||= (async () => {
    try {
      for (const name of await caches.keys()) if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME && name !== CACHE_HD_NAME) caches.delete(name);
      return await caches.open(CACHE_NAME);
    } catch { return null; }
  })();
  if (!hd) return cachePromise;
  cacheHdPromise ||= cachePromise.then((cache) => cache && caches.open(CACHE_HD_NAME)).catch(() => null);
  return cacheHdPromise;
}

// LRU simples por quantidade: keys() vem em ordem de inserção e put() de chave existente reinsere no fim (hit -> put de novo).
async function trimCache(cache, max = CACHE_MAX) {
  try {
    const keys = await cache.keys();
    for (const request of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(request);
  } catch { /* cache indisponível: segue sem */ }
}

// Guarda o blob: pronto e revoga os mais antigos além do teto (quem já exibe a imagem não perde; o próximo pedido redesenha do Cache).
function remember(id, url, hd = false) {
  const map = hd ? readyHd : ready;
  map.set(id, url);
  while (map.size > (hd ? READY_HD_MAX : READY_MAX)) {
    const [oldId, oldUrl] = map.entries().next().value;
    map.delete(oldId);
    (hd ? urlsHd : urls).delete(oldId);
    URL.revokeObjectURL(oldUrl);
  }
  return url;
}

async function createRenderer() {
  const { YugiohCard } = await import('../vendor/yugioh-card/yugioh-card.js');
  patchSpellTrapLabel(YugiohCard);
  const view = document.createElement('div');
  view.style.cssText = 'position:fixed;left:-9999px;top:0;width:418px;height:609px;pointer-events:none;';
  document.body.append(view);
  const card = new YugiohCard({ view, resourcePath: rel('src/vendor/yugioh-card/assets'), data: { scale: SCALE } });
  // As fontes vêm de font-list.json (só as latinas); espera carregarem para o primeiro desenho sair certo.
  const fonts = () => [...document.fonts].filter((font) => font.status === 'loaded' && font.family.startsWith('ygo-')).length;
  for (let i = 0; i < 100 && fonts() < 7; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return card;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
function preload(url) {
  const image = new Image();
  image.src = url;
  return image.decode().catch(() => {});
}

// Desenha uma carta e exporta. Tudo em série: o Leafer só desenha no próximo quadro e o export lê o canvas
// de forma assíncrona; sem esperar os dois, a carta seguinte entra antes e sai a imagem errada.
async function draw(card, hd = false) {
  renderer ||= createRenderer();
  const yg = await renderer;
  const art = card.type & 0x4000 ? TOKEN_ART : rel(`src/assets/classic-art/${card.id}.webp`);
  if (art) await preload(art);
  yg.setData(cardData(card, art));
  await nextFrame();
  await nextFrame();
  await new Promise((resolve) => yg.leafer.waitViewCompleted(resolve));
  const result = await yg.leafer.export('webp', { screenshot: true, quality: hd ? 0.85 : 0.82, blob: true, pixelRatio: (hd ? HD_RATIO : 1) * (window.devicePixelRatio || 1) });
  return { blob: Promise.resolve(result.data) };
}

// Cache Storage -> senão desenha. Devolve { url: Promise<string> }.
async function produce(card, hd = false) {
  const key = rel(`__classic-card${hd ? '-hd' : ''}/${card.id}.webp`);
  const cache = await openCache(hd);
  const hit = await cache?.match(key);
  if (hit) {
    return { url: hit.blob().then((blob) => {
      cache.put(key, new Response(blob, { headers: { 'Content-Type': 'image/webp' } })).catch(() => {}); // renova a posição no LRU
      return URL.createObjectURL(blob);
    }) };
  }
  const { blob } = await draw(card, hd);
  return {
    url: blob.then((data) => {
      cache?.put(key, new Response(data, { headers: { 'Content-Type': 'image/webp' } })).then(() => trimCache(cache, hd ? CACHE_HD_MAX : CACHE_MAX)).catch(() => {});
      return URL.createObjectURL(data);
    }),
  };
}

// Fila com prioridade: desenha primeiro a carta pedida por último que ainda está visível (ou pedida por
// classicCardUrl); as que saíram da tela ficam rebaixadas até voltarem. Uma carta por vez.
const pending = new Map(); // id -> { card, resolve, imgs: Set<img>, keep, seq }
const visible = new WeakSet();
let seq = 0;
let running = false;

const wanted = (job) => job.keep || [...job.imgs].some((img) => img.isConnected && visible.has(img));

async function pump() {
  if (running) return;
  running = true;
  for (;;) {
    let next = null;
    // As HD (zoom) só entram quando não há carta normal visível esperando.
    for (const job of pending.values()) if ((!next || job.hd < next.hd || (job.hd === next.hd && job.seq > next.seq)) && wanted(job)) next = job;
    // Sem nada na tela esperando: adianta as cartas aquecidas por warmCards (a mais antiga primeiro).
    if (!next) for (const job of pending.values()) if (job.idle && (!next || job.seq < next.seq)) next = job;
    if (!next) break;
    pending.delete(next.hd ? `h${next.card.id}` : next.card.id);
    let url;
    try { url = await (await produce(next.card, next.hd)).url; } catch (error) {
      console.warn('classic-render: usando imagem pré-desenhada', next.card.id, error);
      url = next.hd ? null : rel(prerendered(next.card.id)); // HD que falha: a imagem normal já está na tela
    }
    next.resolve(url);
    await new Promise((resolve) => setTimeout(resolve, next.idle ? 120 : 0)); // aquecidas: espaçadas, para não segurar a interface
  }
  running = false;
}

// Pede o desenho; img = quem precisa (prioridade enquanto visível); sem img = pedido explícito (sempre desenha).
function urlFor(card, img, hd = false) {
  registerCard(card);
  const map = hd ? urlsHd : urls;
  const key = hd ? `h${card.id}` : card.id;
  if (!map.has(card.id)) {
    let resolve;
    map.set(card.id, new Promise((done) => { resolve = done; }).then((url) => (url || !hd ? remember(card.id, url, hd) : (urlsHd.delete(card.id), null))));
    pending.set(key, { card, resolve, hd, imgs: new Set(), keep: false, seq: 0 });
  }
  const job = pending.get(key);
  if (job) {
    job.seq = ++seq;
    if (img) job.imgs.add(img); else job.keep = true;
    pump();
  }
  return map.get(card.id);
}

export function classicImg(card, extraAttrs = '') {
  registerCard(card);
  const src = ready.get(card.id) || (preOk.get(card.id) || BACK);
  return `<img data-classic-id="${card.id}" src="${src}" alt="" draggable="false" ${extraAttrs}>`;
}

const seen = new WeakSet();
let observer = null;
const SLOW_MS = 350; // desenho demorando: mostra a pré-desenhada enquanto isso
const THUMB_PX = 120; // miniaturas usam só a pré-desenhada (não vale desenhar 418x609 para 30px)

// Mostra a imagem pré-desenhada (small: a miniatura de 140 px das listas); se ela não existir (temporada sem pré-desenho), volta ao verso.
function usePrerendered(img, id, onMissing, small = false) {
  if (cards.get(id)?.type & 0x4000) { onMissing?.(); return; } // fichas não têm pré-desenhada: só o desenho
  if (img.dataset.pre) return;
  img.dataset.pre = '1';
  const url = rel(small ? thumbnail(id) : prerendered(id));
  img.addEventListener('error', () => {
    if (small && img.src === url) { img.src = rel(prerendered(id)); return; } // sem miniatura (setup antigo): usa a inteira
    img.src = BACK;
    onMissing?.();
  }, { once: !small });
  img.addEventListener('load', () => { if (img.src !== BACK) preOk.set(id, img.src); }, { once: true });
  img.src = url;
}

// Imagem exibida grande em tela densa: troca pela variante HD quando ela fica pronta.
const wantsHd = (img) => img.clientWidth * (window.devicePixelRatio || 1) > HD_MIN_PX;
function upgradeHd(img, id) {
  if (!wantsHd(img)) return;
  if (readyHd.has(id)) { img.src = readyHd.get(id); return; }
  findCard(id).then((card) => card && urlFor(card, img, true)).then((url) => {
    if (url && img.isConnected && wantsHd(img)) img.src = url;
  });
}

function show(img) {
  const id = Number(img.dataset.classicId);
  upgradeHd(img, id);
  if (ready.has(id)) { if (!readyHd.has(id) || !wantsHd(img)) img.src = ready.get(id); observer.unobserve(img); return; }
  const draw = () => findCard(id).then((card) => card && urlFor(card, img)).then((url) => {
    if (url && img.isConnected) { if (!readyHd.has(id) || !wantsHd(img)) img.src = url; observer.unobserve(img); }
  });
  if (img.clientWidth && img.clientWidth < THUMB_PX) { usePrerendered(img, id, draw, true); observer.unobserve(img); return; }
  draw();
  setTimeout(() => { if (img.isConnected && !ready.has(id) && visible.has(img)) usePrerendered(img, id); }, SLOW_MS);
}

export function paintCards(root = document) {
  observer ||= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) { visible.add(entry.target); show(entry.target); } else visible.delete(entry.target);
    }
    pump();
  }, { rootMargin: '150px' });
  for (const img of root.querySelectorAll('img[data-classic-id]')) {
    if (seen.has(img)) continue;
    seen.add(img);
    img.style.aspectRatio ||= '418 / 609'; // reserva a altura antes de o verso carregar (senão tudo parece visível)
    if (ready.has(Number(img.dataset.classicId))) img.src = ready.get(Number(img.dataset.classicId));
    else observer.observe(img);
  }
}

/**
 * Aquece cartas que o jogador provavelmente vai ver (mão, Adicional): desenha em segundo plano, só quando não há
 * nenhuma carta visível esperando, e deixa o resultado no Cache Storage e na memória.
 */
export function warmCards(list) {
  for (const card of list) {
    if (!card || urls.has(card.id) || card.type & 0x4000) continue; // fichas têm desenho fixo
    registerCard(card);
    let resolve;
    urls.set(card.id, new Promise((done) => { resolve = done; }).then((url) => remember(card.id, url)));
    pending.set(card.id, { card, resolve, imgs: new Set(), keep: false, idle: true, seq: ++seq - 1e9 });
  }
  pump();
}

// Booster 3D: devolve o desenho; se demorar, a pré-desenhada (se existir) para não segurar a cena.
// O plano B só baixa a pré-desenhada se o desenho ainda não terminou (antes baixava sempre, ~44 KB inúteis por carta).
export function classicCardUrl(card) {
  const drawn = urlFor(card);
  let finished = false;
  drawn.then(() => { finished = true; });
  const fallback = new Promise((resolve) => setTimeout(resolve, 1200)).then(() => {
    if (finished) return drawn;
    const url = rel(prerendered(card.id));
    const image = new Image();
    image.src = url;
    return image.decode().then(() => url);
  });
  return Promise.race([drawn, fallback.catch(() => drawn)]);
}
