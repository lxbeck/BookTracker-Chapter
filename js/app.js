/**
 * Chapter — app bootstrap.
 *
 * A hash router and a re-render on every store change. The library is small
 * enough (hundreds of books, not millions) that a full re-render per change is
 * both correct and instant; introducing diffing here would buy nothing and
 * cost clarity.
 */

import { $, el, fill, toast } from './lib/dom.js';
import * as store from './data/store.js';
import { initSync, onSyncChange, syncStatus } from './data/sync.js';
import { warmCoverCache, setServerCovers, evacuateDataUrls } from './data/coverCache.js';
import { configureSources } from './data/covers.js';
import { applyTheme } from './data/theme.js';
import { configureKinds } from './data/kinds.js';
import { configureSourceList } from './data/sources.js';
import { guardStrayDrops } from './views/coverDrop.js';
import { installShortcuts } from './views/shortcuts.js';
import { renderLibrary } from './views/library.js';
import { renderCalendar } from './views/calendar.js';
import { renderDay } from './views/day.js';
import { renderYear } from './views/year.js';
import { renderOrders } from './views/orders.js';
import { renderStats } from './views/stats.js';
import { renderSettings } from './views/settings.js';

const ROUTES = {
  calendar: { label: 'Calendar', render: renderCalendar },
  day: { label: 'Day', render: renderDay },
  year: { label: 'Year', render: renderYear },
  library: { label: 'Library', render: renderLibrary },
  orders: { label: 'Orders', render: renderOrders },
  stats: { label: 'Stats', render: renderStats },
  settings: { label: 'Settings', render: renderSettings },
};

const DEFAULT_ROUTE = 'calendar';

function currentRoute() {
  // Views may hang state off the hash — `#/calendar?mode=log&kinds=comic` —
  // so the route is only the part before the query.
  const name = location.hash.replace(/^#\/?/, '').split('?')[0] || DEFAULT_ROUTE;
  return ROUTES[name] ? name : DEFAULT_ROUTE;
}

function render() {
  const name = currentRoute();
  const mount = $('#view');
  // The calendar and day views need the full width; CSS keys off this.
  document.body.dataset.route = name;

  for (const link of document.querySelectorAll('.app-nav__link')) {
    const isCurrent = link.dataset.route === name;
    link.toggleAttribute('aria-current', isCurrent);
    if (isCurrent) link.setAttribute('aria-current', 'page');
  }

  ROUTES[name].render(mount);
  paintSaveStatus();
  announceRoute(name);
}

/**
 * Say which view this is, once, when it changes.
 *
 * `render` runs on every store change, so anything announced here that isn't
 * guarded repeats itself all day — which is exactly what the old live region
 * around the whole of #view did.
 */
let announcedRoute = null;

function announceRoute(name) {
  if (name === announcedRoute) return;
  announcedRoute = name;

  const slot = $('#announcer');
  if (slot) slot.textContent = `${ROUTES[name].label} view`;
}

/**
 * A standing answer to "is this actually saved?".
 *
 * Local-only storage asks people to trust an invisible mechanism, so the state
 * of that mechanism is on screen rather than assumed. Green is not decoration:
 * it flips the moment a write fails, which is the only time it matters.
 */
function paintSaveStatus() {
  const slot = $('#save-status');
  if (!slot) return;

  const status = store.storageStatus();
  const sync = syncStatus();
  const time = status.lastSavedAt
    ? status.lastSavedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  // Two different questions, one indicator: is it written down, and is it
  // shared. Sync failing while the local write succeeds is a warning, not an
  // error — nothing has been lost.
  const failing = !status.saving;
  // Which library, when it isn't the only one: the indicator is the one thing
  // on screen that can say "these books, in this browser" without being asked.
  const libraries = store.allLibraries();
  const named = libraries.libraries.length > 1 ? ` \u00b7 ${store.activeLibrary().name}` : '';

  const label = failing
    ? 'Not saving'
    : sync.mode === 'syncing'
      ? `Synced${named}`
      : sync.mode === 'offline'
        ? `Saved here, offline${named}`
        : time
          ? `Saved ${time}${named}`
          : `Saved locally${named}`;

  slot.className = `save-status ${failing ? 'is-failing' : sync.mode === 'offline' ? 'is-waiting' : 'is-ok'}`;
  slot.title = failing
    ? 'Changes are not being written to this browser.'
    : `${status.books} books in this browser${time ? `, last written at ${time}` : ''}` +
      (sync.mode === 'syncing'
        ? ' \u00b7 shared with your other devices'
        : sync.mode === 'offline'
          ? ' \u00b7 waiting to reach the sync server'
          : ' \u00b7 this browser only');

  // The label is a live region, and "Saved 8:46 PM" re-read after every
  // keystroke is noise rather than information. The dot and the tooltip are
  // repainted regardless; only the spoken part is held still.
  if (slot.dataset.label === label) return;
  slot.dataset.label = label;

  fill(slot, [
    el('span.save-status__dot', { 'aria-hidden': 'true' }),
    el('span', {}, label),
  ]);
}

/**
 * Everything a setting changes outside the view being rendered.
 *
 * Applied on every store change rather than only at boot, because settings
 * arrive from other devices through sync as well as from this one's Settings
 * page — and a colour scheme that only takes effect after a reload is a colour
 * scheme that looks broken.
 */
function applySettings(settings) {
  configureSources(settings.sources);
  configureKinds(settings.kinds);
  // `sources` is the lookup catalogues; `bookSources` is where a copy came
  // from. Two different settings, and the older one had the better name first.
  configureSourceList(settings.bookSources);
  applyTheme(settings.theme, settings);

  const name = String(settings.libraryName ?? '').trim();
  document.title = name ? `${name} \u2014 Chapter` : 'Chapter \u2014 reading tracker';

  const wordmark = document.querySelector('.wordmark span');
  if (wordmark) wordmark.textContent = name || 'Reading log';
}

async function start() {
  store.onPersistError((message) => toast(message, { variant: 'error' }));
  store.init();
  // Lookups, kinds and colours all come from settings, and the setting can
  // arrive later from another device, so they are applied on every change
  // rather than only at boot.
  applySettings(store.getSettings());
  store.subscribe(() => applySettings(store.getSettings()));
  store.subscribe(render);

  // Ask, once, for the data not to be evicted under storage pressure.
  //
  // Settings has a button for this, and a button nobody knows to press is not
  // a safeguard: an offline-first app that keeps a year of reading in
  // localStorage and an IndexedDB full of cover art has something to lose.
  // Browsers decline this unless the site is installed or used often, and the
  // asking is silent either way — there is nothing here for anyone to answer.
  store.requestPersistentStorage().catch(() => null);

  // An image dropped next to a book rather than on it should do nothing, not
  // replace the app with a JPEG.
  guardStrayDrops();
  installShortcuts();
  onSyncChange(paintSaveStatus);
  window.addEventListener('hashchange', render);

  // Paint from the local copy immediately. Waiting on the network before the
  // first render would make an offline-first app feel like an online one.
  render();
  registerServiceWorker();

  // Covers come from storage before anything is requested over the network,
  // which is what makes them appear when there is no network at all.
  // Anyone whose storage filled up got there by keeping base64 images in the
  // library record. Move them somewhere they fit before anything else fails.
  evacuateDataUrls(store.allBooks()).then(({ moved, freedBytes, ids }) => {
    if (!moved) return;
    for (const id of ids) {
      const book = store.getBook(id);
      if (book) store.updateBook(id, { cover: { url: 'local:cover', source: 'upload' } });
    }
    toast(`Moved ${moved} uploaded ${moved === 1 ? 'cover' : 'covers'} out of browser storage, freeing ${Math.round(freedBytes / 1024)} KB.`);
  }).catch(() => null);

  warmCoverCache(store.allBooks().map((book) => book.id)).then(render);

  await initSync();

  // Order matters: coverThumb reads this flag as it builds each image, so
  // setting it after the first paint leaves every cover pointing at the
  // network copy — or at nothing, for books whose art only exists on the
  // server. Set it, then repaint.
  const hadServer = setServerCovers(syncStatus().mode !== 'local');
  if (hadServer) render();
}

document.addEventListener('DOMContentLoaded', start);

/**
 * Register the service worker so the app shell loads without a network.
 *
 * Failure here is not worth surfacing: the app works fine online without it,
 * and it never registers at all from a file:// URL, which is a normal way to
 * poke at the source.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;

  navigator.serviceWorker
    .register('sw.js')
    .then((registration) => {
      // A worker that installs while a page is open would otherwise sit idle
      // until every tab closed — which is how people end up staring at a stale
      // build wondering why their changes did nothing.
      registration.addEventListener('updatefound', () => {
        const incoming = registration.installing;
        incoming?.addEventListener('statechange', () => {
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
            toast('An update is ready. Reload to pick it up.');
          }
        });
      });
      registration.update().catch(() => null);
    })
    .catch(() => {
      console.info('[chapter] Offline support unavailable in this context.');
    });
}
