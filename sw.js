/**
 * Service worker: makes the app itself work offline.
 *
 * The shell is precached on install so the app opens with no network, but it
 * is served *network-first*: cache-first means the first load after any change
 * serves the previous version, which during development looks exactly like the
 * update didn't happen. Correctness beats the few milliseconds cache-first
 * would save on an app this size.
 *
 * Cover art is the opposite case — immutable once fetched, and expensive to
 * refetch — so images stay cache-first. That also picks up images IndexedDB
 * couldn't store because the host sent no CORS headers.
 *
 * Bump CACHE_VERSION to ship an update; old caches are dropped on activate.
 */

const CACHE_VERSION = 'chapter-v6';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const IMAGE_CACHE = `${CACHE_VERSION}-images`;

const SHELL = [
  './',
  './index.html',
  './css/tokens.css',
  './css/base.css',
  './css/components.css',
  './css/covers.css',
  './css/library.css',
  './css/calendar.css',
  './css/dayview.css',
  './css/sessions.css',
  './css/stats.css',
  './js/app.js',
  './js/lib/dom.js',
  './js/lib/dates.js',
  './js/lib/charts.js',
  './js/data/schema.js',
  './js/data/store.js',
  './js/data/covers.js',
  './js/data/coverCache.js',
  './js/data/seed.js',
  './js/data/transfer.js',
  './js/data/merge.js',
  './js/data/sync.js',
  './js/data/goodreads.js',
  './js/data/calibre.js',
  './js/data/enrich.js',
  './js/data/snapshot.js',
  './js/data/merge.js',
  './js/lib/csv.js',
  './js/logic/schedule.js',
  './js/logic/pacing.js',
  './js/logic/sessions.js',
  './js/logic/stats.js',
  './js/views/modal.js',
  './js/views/cover.js',
  './js/views/coverPicker.js',
  './js/views/bookForm.js',
  './js/views/library.js',
  './js/views/calendar.js',
  './js/views/hoverCard.js',
  './js/views/dayRow.js',
  './js/views/dayPopup.js',
  './js/views/day.js',
  './js/views/sessionLog.js',
  './js/views/orders.js',
  './js/views/year.js',
  './js/views/stats.js',
  './js/views/settings.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll fails the whole install if any one file 404s, which would leave
      // the app with no offline support at all. Cache what we can.
      Promise.all(SHELL.map((path) => cache.add(path).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => !key.startsWith(CACHE_VERSION)).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // The sync API must never be served from cache: a stale library is worse
  // than no library, and the event stream cannot be cached at all.
  if (url.pathname.startsWith('/api/library') || url.pathname.startsWith('/api/events')
      || url.pathname.startsWith('/api/status')) {
    return;
  }

  const isImage =
    request.destination === 'image' || /\.(png|jpe?g|webp|gif|svg)$/i.test(url.pathname);

  if (isImage) {
    event.respondWith(cacheFirstThenNetwork(request, IMAGE_CACHE));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirstThenCache(request, SHELL_CACHE));
  }
});

/** Fresh if the network answers, cached if it doesn't. */
async function networkFirstThenCache(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()).catch(() => null);
    return response;
  } catch {
    const hit = await cache.match(request);
    if (hit) return hit;
    return new Response('Offline and not cached.', { status: 503, statusText: 'Offline' });
  }
}

async function cacheFirstThenNetwork(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      // Opaque cross-origin responses are still worth keeping — they render.
      if (response.ok || response.type === 'opaque') {
        cache.put(request, response.clone()).catch(() => null);
      }
      return response;
    })
    .catch(() => null);

  if (hit) {
    // Serve from cache immediately, refresh in the background.
    network.catch(() => null);
    return hit;
  }

  const response = await network;
  if (response) return response;

  return new Response('Offline and not cached.', { status: 503, statusText: 'Offline' });
}
