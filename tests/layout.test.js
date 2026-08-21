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
  assert.match(board, /overflow:\s*hidden/, 'the board must clip, not scroll sideways');
  // Cards wrap into a grid; a single row is what squeezed a busy day into
  // slivers behind a horizontal scrollbar.
  assert.match(board, /grid-template-columns:\s*repeat\(var\(--day-cols/);
  assert.match(board, /grid-template-rows:\s*repeat\(var\(--day-rows/);
  assert.doesNotMatch(board, /overflow-x:\s*auto/, 'the day view must not scroll sideways');

  const card = rule(stats, '.day-card');
  assert.match(card, /overflow:\s*hidden/);
  assert.match(card, /min-height:\s*0/);
});

test('the day board never asks repeat() to do arithmetic', () => {
  // `repeat()` takes an integer, not a math function. `repeat(min(var(--x),2))`
  // parses as invalid and is dropped whole — silently — so the clamp that was
  // supposed to hold a phone to two columns did nothing, and a busy day was
  // five thumbnails across. The cap lives in day.js now.
  assert.doesNotMatch(stats, /repeat\(\s*(min|max|calc|clamp)\(/,
    'a column count has to be an integer');

  const day = read('js/views/day.js');
  assert.match(day, /function columnCap\(\)/, 'the cap has to be counted somewhere');
});

test('a form field can shrink below the width of its own contents', () => {
  // A control's intrinsic width is about twenty characters and a grid item
  // will not shrink below its content by default, so a row of three fields
  // pushed the dialog wider than a phone and the page scrolled sideways.
  const components = read('css/components.css');
  assert.match(rule(components, '.field'), /min-width:\s*0/);
  assert.match(rule(components, '.field-row > *'), /min-width:\s*0/);
  assert.match(components, /\.input,\s*\.select,\s*\.textarea\s*\{[^}]*min-width:\s*0/);
});

test('narrow screens get one field per line and an edge-to-edge dialog', () => {
  const components = read('css/components.css');
  const narrow = components.match(/@media \(max-width: 560px\)\s*\{[\s\S]*?\n\}/g) ?? [];
  const text = narrow.join('\n');

  assert.match(text, /\.field-row\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.match(text, /\.modal__panel[^{]*\{[^}]*width:\s*100%/);
});

test('page-level grids shrink below their track floor rather than overflowing', () => {
  // `minmax(320px, 1fr)` on a 300px-wide phone is a 320px column in a 300px
  // container: the panel hangs off the side. `min(320px, 100%)` cannot.
  for (const [name, css] of [['stats', stats], ['calendar', calendar]]) {
    // Columns only: a row track of 220px is a height, and heights are free to
    // exceed the width of the screen.
    const columns = [...css.matchAll(/grid-template-columns:[^;]*minmax\((\d+)px/g)]
      .map((match) => Number(match[1]));

    assert.deepEqual(columns.filter((px) => px > 100), [],
      `${name}.css has a fixed track floor wide enough to overflow a phone`);
  }
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

test('a day card cover keeps its proportions instead of being cropped', () => {
  const cover = rule(stats, '.day-card__art .cover');
  assert.match(cover, /height:\s*100%/);
  assert.match(cover, /width:\s*auto/);
  assert.match(cover, /aspect-ratio:\s*var\(--cover-ratio\)/);
  assert.match(cover, /max-width:\s*100%/, 'the art must not overflow its column');
});

test('the year grid lays months out responsively without fixed columns', () => {
  const calendar = read('css/calendar.css');
  assert.match(rule(calendar, '.year-grid'), /grid-template-columns:\s*repeat\(auto-fit/);
  assert.match(rule(calendar, '.year-day'), /aspect-ratio:\s*1/, 'day squares must stay square');
});

test('the element helper sets CSS custom properties, not just plain ones', async () => {
  // Object.assign on a style declaration silently drops anything beginning
  // with `--`, which lost every CSS variable a view tried to set.
  const source = read('js/lib/dom.js');
  assert.match(source, /setProperty\(property/, 'custom properties need setProperty');
  assert.doesNotMatch(source, /Object\.assign\(node\.style/, 'Object.assign drops CSS variables');
});
