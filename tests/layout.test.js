/**
 * Layout invariants.
 *
 * jsdom does no layout, so the render tests cannot catch a sizing bug — and one
 * got through: cover tiles derived their width from `height: 100%` inside a
 * chain of flex parents with no definite height, so the browser fell back to
 * content sizing and every day column grew to fit stacked covers.
 *
 * These assert the CSS rules that make the sizing chain resolvable. They are
 * blunt, but they fail loudly if someone reintroduces the shape of that bug.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const calendar = read('css/calendar.css');
const tokens = read('css/tokens.css');
const stats = read('css/stats.css');

/** Pull one rule block out of a stylesheet by selector. */
function rule(css, selector) {
  const match = css.match(
    new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm')
  );
  assert.ok(match, `no rule found for ${selector}`);
  return match[2];
}

test('the board height is a definite length, not inherited from flex', () => {
  assert.match(tokens, /--board-height:\s*clamp\(/, 'board height token missing');
  assert.match(rule(calendar, '.cal'), /height:\s*var\(--board-height\)/);
  // A flex chain with only min-height is what broke; it must not come back.
  assert.doesNotMatch(rule(calendar, '.cal__grid'), /min-height:\s*clamp/);
});

test('the grid is six rows by seven columns and cannot overflow', () => {
  const grid = rule(calendar, '.cal__grid');
  assert.match(grid, /grid-template-columns:\s*repeat\(7,/);
  assert.match(grid, /grid-template-rows:\s*repeat\(6,/);
  assert.match(grid, /overflow:\s*hidden/);
});

test('a day cell clips its contents so no book can stretch the row', () => {
  const day = rule(calendar, '.cal__day');
  assert.match(day, /overflow:\s*hidden/);
  assert.match(day, /min-height:\s*0/);
});

test('tile rows are grid tracks, which resolve to a definite height', () => {
  const tiles = rule(calendar, '.cal__tiles');
  assert.match(tiles, /display:\s*grid/, 'flex rows cannot resolve percentage heights here');
  assert.match(tiles, /grid-auto-rows:\s*1fr/);
  assert.match(tiles, /min-height:\s*0/);
});

test('a tile takes its width from its height, and the cover fills the tile', () => {
  const tile = rule(calendar, '.cal__tile');
  assert.match(tile, /height:\s*100%/);
  assert.match(tile, /width:\s*auto/);
  assert.match(tile, /aspect-ratio:\s*var\(--cover-ratio\)/);

  // The nested cover must not impose a second, conflicting ratio.
  const cover = rule(calendar, '.cal__tile > .cover');
  assert.match(cover, /aspect-ratio:\s*auto/);
  assert.match(cover, /height:\s*100%/);
});

test('the day view is one fixed rectangle, matching the calendar board', () => {
  const board = rule(stats, '.day-board');
  assert.match(board, /height:\s*var\(--board-height\)/);
  assert.match(board, /overflow-y:\s*hidden/);

  const card = rule(stats, '.day-card');
  assert.match(card, /overflow:\s*hidden/);
  assert.match(card, /min-height:\s*0/);
});

test('the navigation wraps rather than scrolling its tabs out of sight', () => {
  const base = read('css/base.css');
  assert.match(rule(base, '.app-nav'), /flex-wrap:\s*wrap/);
  assert.doesNotMatch(base, /\.app-nav\s*\{[^}]*overflow-x:\s*auto/);
});

test('every stylesheet the page loads actually exists', () => {
  const html = read('index.html');
  const hrefs = [...html.matchAll(/href="(css\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 8, `only ${hrefs.length} stylesheets linked`);
  for (const href of hrefs) {
    assert.ok(read(href).length > 0, `${href} is linked but empty or missing`);
  }
});

test('every route in the shell has a matching nav button', () => {
  const html = read('index.html');
  const app = read('js/app.js');
  const routes = [...app.matchAll(/^\s{2}(\w+): \{ label:/gm)].map((m) => m[1]);
  assert.ok(routes.length >= 5, `found routes: ${routes.join(', ')}`);
  for (const route of routes) {
    assert.match(html, new RegExp(`data-route="${route}"`), `no nav button for ${route}`);
  }
});

test('the service worker precaches every module the app imports', () => {
  const sw = read('sw.js');
  const app = read('js/app.js');
  const imports = [...app.matchAll(/from '\.\/([^']+)'/g)].map((m) => m[1]);
  for (const path of imports) {
    assert.match(sw, new RegExp(`'\\./js/${path.replace(/[.]/g, '\\.')}'`), `sw.js misses js/${path}`);
  }
});
