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

const ROUTES = {
  calendar: { label: 'Calendar', render: renderCalendar },
  library: { label: 'Library', render: renderLibrary },
};

const DEFAULT_ROUTE = 'calendar';

function currentRoute() {
  const name = location.hash.replace(/^#\/?/, '') || DEFAULT_ROUTE;
  return ROUTES[name] ? name : DEFAULT_ROUTE;
}

function render() {
  const name = currentRoute();
  const mount = $('#view');

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
}

document.addEventListener('DOMContentLoaded', start);
