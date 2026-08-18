/**
 * Chapter — app bootstrap.
 *
 * A hash router and a re-render on every store change. The library is small
 * enough (hundreds of books, not millions) that a full re-render per change is
 * both correct and instant; introducing diffing here would buy nothing and
 * cost clarity.
 */

import { $, toast } from './lib/dom.js';
import * as store from './data/store.js';
import { renderLibrary } from './views/library.js';
import { renderCalendar } from './views/calendar.js';
import { renderDay } from './views/day.js';
import { renderStats } from './views/stats.js';
import { renderSettings } from './views/settings.js';

const ROUTES = {
  calendar: { label: 'Calendar', render: renderCalendar },
  day: { label: 'Day', render: renderDay },
  library: { label: 'Library', render: renderLibrary },
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
}

function start() {
  store.onPersistError((message) => toast(message, { variant: 'error' }));
  store.init();
  store.subscribe(render);
  window.addEventListener('hashchange', render);
  render();
  registerServiceWorker();
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
  navigator.serviceWorker.register('sw.js').catch(() => {
    console.info('[chapter] Offline support unavailable in this context.');
  });
}
