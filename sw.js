// Service worker: once Dungeon Run has loaded with a network, it plays with none (SPEC: PWA).
//
// Every file of the game is cached when the worker installs. While online, each file still comes from the
// network first (so an edited /data file or a new deploy shows up on the next load) and the cached copy is
// refreshed; when the network fails or stalls, the cached copy is served. The Google Fonts are cached too,
// so the dungeon keeps its lettering offline.
//
// FILES must list every file the game loads. The test suite checks it against the folders.

const VERSION = 'dungeon-run-v1'; // a new name drops every older cache on the next visit

const FILES = [
  './',
  'index.html',
  'manifest.json',
  'styles/tokens.css',
  'styles/main.css',
  'src/main.js',
  'src/state.js',
  'src/combat.js',
  'src/summons.js',
  'src/cards.js',
  'src/map.js',
  'src/shop.js',
  'src/events.js',
  'src/render.js',
  'src/log.js',
  'data/config.json',
  'data/cards.json',
  'data/enemies.json',
  'data/companions.json',
  'data/events.json',
  'data/relics.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

// The same stylesheet index.html links. Its font files are fetched and cached along with it.
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;700;800&family=Grenze+Gotisch:wght@600;800&display=swap';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// How long to wait on a slow network before falling back to the cached copy (a dungeon has bad signal).
const NETWORK_PATIENCE_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(FILES);
    await cacheFonts(cache).catch(() => {}); // no fonts offline is a fallback typeface, not a failure
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== VERSION) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (FONT_HOSTS.includes(url.hostname)) event.respondWith(cacheFirst(request));
  else if (url.origin === self.location.origin) event.respondWith(networkFirst(request));
});

async function cacheFonts(cache) {
  const response = await fetch(FONT_CSS, { mode: 'cors' });
  if (!response.ok) return;
  await cache.put(FONT_CSS, response.clone());
  const css = await response.text();
  const files = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((match) => match[1]);
  await Promise.all(files.map(async (file) => {
    const font = await fetch(file, { mode: 'cors' });
    if (font.ok) await cache.put(file, font);
  }));
}

// Fonts never change at a given address: the cached copy wins, the network fills gaps.
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') (await caches.open(VERSION)).put(request, response.clone());
  return response;
}

// The game's own files: the network when it answers in time, the cache when it doesn't.
async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  const fromNetwork = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  fromNetwork.catch(() => {}); // a failure after the cache already answered is nobody's problem
  const fallback = async () => (await cache.match(request, { ignoreSearch: true }))
    ?? (request.mode === 'navigate' ? cache.match('index.html') : undefined);
  const slow = new Promise((resolve) => setTimeout(resolve, NETWORK_PATIENCE_MS));
  try {
    const first = await Promise.race([fromNetwork, slow.then(fallback)]);
    return first ?? await fromNetwork;
  } catch {
    return (await fallback()) ?? Response.error();
  }
}
