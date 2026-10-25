// Imagens das cartas Rush (motor do EDOPro). CONTRATO (espelha classic-render.js; mudar exige atualizar os usuários):
//   rushImg(card, { small })  -> Promise<string> com a URL da frente da carta (small: miniatura de 140 px, se houver)
//   paintRushCards(root)      -> preenche os <img data-rush-card="<id>"> dentro de root, só quando aparecem na tela
//   rushCardUrl(id)           -> URL da melhor imagem já disponível (desenhada ou pré-desenhada), ou null (síncrono)
//   warmRushCards(ids)        -> pré-aquece (ids ou cartas) em segundo plano
//   RUSH_BACK                 -> verso
// Origem da imagem, nesta ordem: pré-desenhada (etapa rush-cartas, src/assets/rush-cards) -> desenho no navegador
// com RushDuelCard (yugioh-card, MIT) e a arte de src/assets/rush-art (etapa rush-art); sem arte, um quadro no tom do atributo.
// As frentes antigas (src/assets/cards, ids da Konami) não são usadas: todas as 3.232 cartas saem no mesmo desenho.
// Cache: memória (blob:) + Cache Storage, uma fila só, as visíveis primeiro.
import { SCALE, patchRushCard, rushCardData } from './rush-card-data.js';

export const RUSH_BACK = 'src/assets/card-back.svg';

// Subir CACHE_VERSION ao mudar moldura/estilo/dados das cartas: caches de versões antigas são apagados ao abrir.
const CACHE_PREFIX = 'rushdaily-rush-cards-';
const CACHE_VERSION = 2;
const CACHE_NAME = `${CACHE_PREFIX}v${CACHE_VERSION}`;
const CACHE_MAX = 800;
const READY_MAX = 400;
const THUMB_PX = 120; // abaixo disso usa a miniatura pré-desenhada, quando existe
const FONTS = ['rd-atk-def', 'ygo-en', 'ygo-en-name', 'ygo-en-race'];
const rel = (path) => new URL(`../../${path}`, import.meta.url).href;
const artUrl = (id) => rel(`src/assets/rush-art/${id}.webp`);
const prerendered = (id, small) => rel(`src/assets/${small ? 'rush-cards-sm' : 'rush-cards'}/${id}.webp`);

// Quais cartas têm arte e pré-desenhada: listas gravadas pelas etapas do setup (ausentes = nenhuma).
const readIds = (path) => fetch(rel(path)).then((r) => (r.ok ? r.json() : [])).then((ids) => new Set(ids)).catch(() => new Set());
const manifest = { art: null, pre: null };
const manifests = Promise.all([readIds('src/assets/rush-art/index.json'), readIds('src/assets/rush-cards/index.json')])
  .then(([art, pre]) => { manifest.art = art; manifest.pre = pre; });
const hasPre = (id) => !!manifest.pre?.has(id);

const cards = new Map(); // id -> carta
const urls = new Map(); // id -> Promise<URL>
const ready = new Map(); // id -> URL já pronta
let pool = null;
let renderer = null;

function registerCard(card) {
  if (card?.id && !cards.has(card.id)) cards.set(card.id, card);
}

async function findCard(id) {
  if (cards.has(id)) return cards.get(id);
  pool ||= fetch(rel('src/data/rush/cards.json')).then((r) => r.json()).then((list) => list.forEach(registerCard));
  await pool.catch(() => {});
  return cards.get(id);
}

let cachePromise = null;
function openCache() {
  cachePromise ||= (async () => {
    try {
      for (const name of await caches.keys()) if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) caches.delete(name);
      return await caches.open(CACHE_NAME);
    } catch { return null; }
  })();
  return cachePromise;
}

async function trimCache(cache) {
  try {
    const keys = await cache.keys();
    for (const request of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) await cache.delete(request);
  } catch { /* sem cache: segue */ }
}

// Guarda a URL pronta; blob: além do teto é revogado (o próximo pedido redesenha a partir do Cache Storage).
function remember(id, url) {
  ready.set(id, url);
  while (ready.size > READY_MAX) {
    const [oldId, oldUrl] = ready.entries().next().value;
    ready.delete(oldId);
    urls.delete(oldId);
    if (oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
  }
  return url;
}

async function createRenderer() {
  const { RushDuelCard } = await import('../vendor/yugioh-card/yugioh-card.js');
  patchRushCard(RushDuelCard);
  const view = document.createElement('div');
  view.style.cssText = 'position:fixed;left:-9999px;top:0;width:418px;height:609px;pointer-events:none;';
  document.body.append(view);
  const card = new RushDuelCard({ view, resourcePath: rel('src/vendor/yugioh-card/assets'), data: { scale: SCALE } });
  // Fontes de rush-duel/font/font-list.json: espera carregarem para o primeiro desenho sair certo.
  const loaded = () => FONTS.filter((family) => [...document.fonts].some((font) => font.family.replace(/"/g, '') === family && font.status === 'loaded')).length;
  for (let i = 0; i < 100 && loaded() < FONTS.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return card;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
function preload(url) {
  const image = new Image();
  image.src = url;
  return image.decode().then(() => true, () => false);
}

// Desenha e exporta, em série (o Leafer só desenha no próximo quadro e o export é assíncrono).
async function draw(card, art) {
  renderer ||= createRenderer();
  const yg = await renderer;
  const image = art && (await preload(art)) ? art : null;
  yg.setData(rushCardData(card, image));
  await nextFrame();
  await nextFrame();
  await new Promise((resolve) => yg.leafer.waitViewCompleted(resolve));
  const result = await yg.leafer.export('webp', { screenshot: true, quality: 0.82, blob: true });
  return result.data;
}

// Cache Storage -> senão desenha. A chave muda quando a arte chega (sem arte = quadro provisório).
async function produce(card) {
  await manifests;
  const art = manifest.art.has(card.id) ? artUrl(card.id) : null;
  const key = rel(`__rush-card/${card.id}-${art ? 'a' : 'p'}.webp`);
  const cache = await openCache();
  const hit = await cache?.match(key);
  if (hit) {
    const blob = await hit.blob();
    cache.put(key, new Response(blob, { headers: { 'Content-Type': 'image/webp' } })).catch(() => {}); // renova no LRU
    return URL.createObjectURL(blob);
  }
  const blob = await draw(card, art);
  cache?.put(key, new Response(blob, { headers: { 'Content-Type': 'image/webp' } })).then(() => trimCache(cache)).catch(() => {});
  return URL.createObjectURL(blob);
}

// Fila com prioridade: a pedida por último que ainda está na tela (ou pedida por rushImg); aquecidas só sem nada esperando.
const pending = new Map(); // id -> { card, resolve, imgs, keep, idle, seq }
const visible = new WeakSet();
let seq = 0;
let running = false;
const wanted = (job) => job.keep || [...job.imgs].some((img) => img.isConnected && visible.has(img));

async function pump() {
  if (running) return;
  running = true;
  for (;;) {
    let next = null;
    for (const job of pending.values()) if ((!next || job.seq > next.seq) && wanted(job)) next = job;
    if (!next) for (const job of pending.values()) if (job.idle && (!next || job.seq < next.seq)) next = job;
    if (!next) break;
    pending.delete(next.card.id);
    let url;
    try { url = await produce(next.card); } catch (error) {
      console.warn('rush-render: desenho falhou', next.card.id, error);
      url = rel(RUSH_BACK);
    }
    next.resolve(url);
    await new Promise((resolve) => setTimeout(resolve, next.idle ? 120 : 0));
  }
  running = false;
}

function enqueue(card, { img, idle = false } = {}) {
  registerCard(card);
  if (!urls.has(card.id)) {
    let resolve;
    urls.set(card.id, new Promise((done) => { resolve = done; }).then((url) => remember(card.id, url)));
    pending.set(card.id, { card, resolve, imgs: new Set(), keep: false, idle, seq: idle ? ++seq - 1e9 : 0 });
  }
  const job = pending.get(card.id);
  if (job && !idle) {
    job.seq = ++seq;
    job.idle = false;
    if (img) job.imgs.add(img); else job.keep = true;
  }
  pump();
  return urls.get(card.id);
}

/** URL da frente da carta: a pré-desenhada se existir; senão desenha (e guarda no cache). */
export async function rushImg(card, { small = false } = {}) {
  registerCard(card);
  await manifests;
  if (hasPre(card.id)) return prerendered(card.id, small);
  return enqueue(card);
}

const seen = new WeakSet();
let observer = null;

function show(img) {
  const id = Number(img.dataset.rushCard);
  observer.unobserve(img);
  if (ready.has(id)) { img.src = ready.get(id); return; }
  manifests.then(async () => {
    if (hasPre(id)) {
      const small = img.clientWidth > 0 && img.clientWidth < THUMB_PX;
      const full = prerendered(id, false);
      // Sem miniatura (etapa antiga): cai na inteira; sem a inteira: desenha.
      img.addEventListener('error', () => {
        if (img.src !== full) { img.src = full; return; }
        findCard(id).then((card) => card && enqueue(card, { img })).then((url) => { if (url && img.isConnected) img.src = url; });
      });
      img.src = prerendered(id, small);
      return;
    }
    const card = await findCard(id);
    if (!card) return;
    const url = await enqueue(card, { img });
    if (img.isConnected) img.src = url;
  });
}

export function paintRushCards(root = document) {
  observer ||= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) { visible.add(entry.target); show(entry.target); } else visible.delete(entry.target);
    }
    pump();
  }, { rootMargin: '150px' });
  for (const img of root.querySelectorAll('img[data-rush-card]')) {
    if (seen.has(img)) continue;
    seen.add(img);
    img.style.aspectRatio ||= '418 / 609'; // reserva a altura antes da imagem chegar
    const id = Number(img.dataset.rushCard);
    if (ready.has(id)) { img.src = ready.get(id); continue; }
    if (!img.getAttribute('src')) img.src = rel(RUSH_BACK);
    observer.observe(img);
  }
}

export function rushCardUrl(id) {
  const key = Number(id);
  return ready.get(key) || (hasPre(key) ? prerendered(key, false) : null);
}

/** Aquece cartas que o jogador vai ver (mão, deck): desenha em segundo plano, só quando nada visível espera. */
export function warmRushCards(ids) {
  manifests.then(async () => {
    for (const item of ids || []) {
      const id = Number(typeof item === 'object' ? item?.id : item);
      if (!id || urls.has(id)) continue;
      if (typeof item === 'object') registerCard(item);
      if (hasPre(id)) { remember(id, prerendered(id, false)); urls.set(id, Promise.resolve(ready.get(id))); continue; }
      const card = await findCard(id);
      if (card) enqueue(card, { idle: true });
    }
  });
}
