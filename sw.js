// Service worker: o shell (páginas, código, estilos, fontes, logos) fica pré-cacheado; sobe VERSION a cada deploy que mude a lista.
const VERSION = 'v1';
const CACHE = `rushdaily-${VERSION}`;
const SHELL = [
  '/index.html',
  '/duel.html',
  '/screens.html',
  '/arena.html',
  '/manifest.webmanifest',
  '/src/assets/logo.png',
  '/src/assets/logo-mark.png',
  '/src/assets/card-back.svg',
  '/src/assets/icons/icon-192.png',
  '/src/assets/icons/icon-512.png',
  '/src/assets/fonts/archivo-italic-latin-ext.woff2',
  '/src/assets/fonts/archivo-italic-latin.woff2',
  '/src/assets/fonts/archivo-latin-ext.woff2',
  '/src/assets/fonts/archivo-latin.woff2',
  '/src/assets/fonts/dela-gothic-one-latin-ext.woff2',
  '/src/assets/fonts/dela-gothic-one-latin.woff2',
  '/src/styles/arena.css',
  '/src/styles/duel.css',
  '/src/styles/fonts.css',
  '/src/styles/home.css',
  '/src/styles/rush-arena.css',
  '/src/styles/rush.css',
  '/src/styles/screens.css',
  '/src/ui/arena.js',
  '/src/ui/card-gestures.js',
  '/src/ui/classic-card-data.js',
  '/src/ui/classic-card.js',
  '/src/ui/classic-render.js',
  '/src/ui/classic-store.js',
  '/src/ui/common.js',
  '/src/ui/duel.js',
  '/src/ui/duel-save.js',
  '/src/ui/entering.js',
  '/src/ui/home.js',
  '/src/ui/maximum.js',
  '/src/ui/ocg-ask.js',
  '/src/ui/rush-card-data.js',
  '/src/ui/rush-info.js',
  '/src/ui/rush-render.js',
  '/src/ui/scene.js',
  '/src/ui/screens.js',
  '/src/ui/share.js',
  '/src/ui/sync.js',
  '/src/ui/sync-merge.js',
  '/src/engine/booster.mjs',
  '/src/engine/classic-deck.mjs',
  '/src/engine/daily-generator.mjs',
  '/src/engine/heart.mjs',
  '/src/engine/ocg-ai.mjs',
  '/src/engine/ocg.mjs',
  '/src/engine/rush-ai.mjs',
  '/src/engine/rush-deck.mjs',
  '/src/data/classic/strings-pt.mjs',
];

self.addEventListener('install', (event) => {
  // add() um a um: um arquivo ausente não derruba a instalação inteira.
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('rushdaily-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Pesado e de nome estável: cache-first. Todo o resto (HTML, JS, CSS, cards.json, outros JSON) é network-first.
const STATIC = /\.(?:wasm|lua|png|jpe?g|webp|avif|svg|ico|woff2|bin)$/i;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Nunca intercepta: não-GET, outra origem e a API de sincronização.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(STATIC.test(url.pathname) ? cacheFirst(request) : networkFirst(request));
});

async function store(request, response) {
  if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
  return response;
}

async function cacheFirst(request) {
  return (await caches.match(request)) || store(request, await fetch(request));
}

// cards.json precisa estar fresco (o deck do dia sai dele): rede primeiro, cache só sem rede.
async function networkFirst(request) {
  try {
    return await store(request, await fetch(request));
  } catch (error) {
    const hit = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
    const hit2 = hit || (request.mode === 'navigate' && (await caches.match('/index.html')));
    if (hit2) return hit2;
    throw error;
  }
}
