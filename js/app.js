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
import { renderLibrary } from './views/library.js';
import { renderCalendar } from './views/calendar.js';
import { renderDay } from './views/day.js';
import { renderOrders } from './views/orders.js';
import { renderStats } from './views/stats.js';
import { renderSettings } from './views/settings.js';

const ROUTES = {
  calendar: { label: 'Calendar', render: renderCalendar },
  day: { label: 'Day', render: renderDay },
  library: { label: 'Library', render: renderLibrary },
  orders: { label: 'Orders', render: renderOrders },
  stats: { label: 'Stats', render: renderStats },
  settings: { label: 'Settings', render: renderSettings },
};

const DEFAULT_ROUTE = 'calendar';

function currentRoute() {
  const name = location.hash.replace(/^#\/?/, '') || DEFAULT_ROUTE;
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
  const label = failing
    ? 'Not saving'
    : sync.mode === 'syncing'
      ? 'Synced'
      : sync.mode === 'offline'
        ? 'Saved here, offline'
        : time
          ? `Saved ${time}`
          : 'Saved locally';

  slot.className = `save-status ${failing ? 'is-failing' : sync.mode === 'offline' ? 'is-waiting' : 'is-ok'}`;
  slot.title = failing
    ? 'Changes are not being written to this browser.'
    : `${status.books} books in this browser${time ? `, last written at ${time}` : ''}` +
      (sync.mode === 'syncing'
        ? ' \u00b7 shared with your other devices'
        : sync.mode === 'offline'
          ? ' \u00b7 waiting to reach the sync server'
          : ' \u00b7 this browser only');

  fill(slot, [
    el('span.save-status__dot', { 'aria-hidden': 'true' }),
    el('span', {}, label),
  ]);
}

async function start() {
  store.onPersistError((message) => toast(message, { variant: 'error' }));
  store.init();
  store.subscribe(render);
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
