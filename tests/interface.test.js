/**
 * Contracts the interface has to keep, checked against the source.
 *
 * These are the same shape as the layout tests: blunt source assertions,
 * standing in for a browser nobody wants to install to run `npm test`. Each
 * one is here because the thing it checks was wrong at some point and looked
 * fine — a live region that read the whole page aloud, a native `confirm()`
 * that no theme could reach, a column count that only counted at load.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const VIEWS = readdirSync(join(ROOT, 'js/views'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => [`js/views/${name}`, read(`js/views/${name}`)]);

/* --- Live regions ---------------------------------------------------------- */

test('the main view is not itself a live region', () => {
  // `aria-live` on #view meant every store change re-read the entire page: a
  // ticked checkbox, a logged sitting, every keystroke in the search field.
  const html = read('index.html');
  const view = html.match(/<main[^>]*id="view"[^>]*>/)?.[0];

  assert.ok(view, 'the main view is missing');
  assert.doesNotMatch(view, /aria-live/);
});

test('there is one small live region, and something announces into it', () => {
  const html = read('index.html');
  assert.match(html, /id="announcer"[^>]*aria-live="polite"|aria-live="polite"[^>]*id="announcer"/);
  assert.match(read('js/app.js'), /#announcer/, 'nothing writes to the announcer');
});

/* --- Dialogs --------------------------------------------------------------- */

test('no view asks the browser to confirm anything', () => {
  // The native dialog ignores the theme, cannot mark the dangerous button as
  // dangerous, and is suppressed outright in some embedded contexts — where it
  // returns false and the action silently never happens.
  const offenders = VIEWS
    .filter(([, code]) => /(^|[^.\w])confirm\s*\(/m.test(code.replace(/confirmAction\s*\(/g, '')))
    .filter(([path]) => path !== 'js/views/modal.js')
    .map(([path]) => path);

  assert.deepEqual(offenders, []);
});

test('the app supplies its own confirmation dialog', () => {
  assert.match(read('js/views/modal.js'), /export function confirmAction/);
});

test('an open dialog owns a history entry, so Back closes it', () => {
  // Without one, Back on a phone leaves the app and takes the half-typed form
  // with it.
  const modal = read('js/views/modal.js');
  assert.match(modal, /history\.pushState/);
  assert.match(modal, /popstate/);
});

/* --- Breakpoints counted in JavaScript ------------------------------------- */

test('a view that counts columns itself repaints when the window changes', () => {
  // The count is only right until the window changes, and turning a phone on
  // its side is the ordinary way to find that out.
  for (const view of ['js/views/day.js', 'js/views/calendar.js']) {
    const code = read(view);
    assert.match(code, /globalThis\.addEventListener\?\.\('resize'/, `${view} never listens for a resize`);
  }
});

/* --- Search ---------------------------------------------------------------- */

test('typing in the library search does not rebuild the field being typed in', () => {
  // Rebuilding it forced the caret to the end of the term, so it could not be
  // corrected in the middle, and interrupted any input method that composes
  // characters before committing them.
  const library = read('js/views/library.js');
  const handler = library.match(/onInput:[\s\S]{0,400}?\n {4}\},/)?.[0] ?? '';

  assert.match(handler, /paintResults\(\)/, 'the search should repaint only the results');
  assert.doesNotMatch(handler, /setSelectionRange|\.focus\(\)/, 'the caret should not need putting back');
});

/* --- Rescheduling without a mouse ------------------------------------------ */

test('a plan can be moved without dragging', () => {
  // HTML5 drag-and-drop does not fire for touch at all, so the calendar's only
  // way to move a book was unavailable on every phone.
  assert.match(read('js/views/dayRow.js'), /export function openMovePlan/);
  assert.match(read('js/views/day.js'), /openMovePlan/, 'the day view should offer it too');
});

/* --- Undo ------------------------------------------------------------------ */

test('a toast can carry a way back', () => {
  const dom = read('js/lib/dom.js');
  assert.match(dom, /action\s*=\s*null/, 'toast should take an action');
  assert.match(dom, /toast__action/);
});

test('every destructive action outside a form offers undo', () => {
  // Deleting a book has offered it for a while. Deleting a list, a sitting or
  // a whole log did not, and those are the ones taken quickly.
  const cases = [
    ['js/views/sessionLog.js', /Session deleted\./, 3],
    ['js/views/orders.js', /List deleted\./, 1],
    ['js/views/settings.js', /List deleted\./, 1],
  ];

  for (const [path, message, atLeast] of cases) {
    const code = read(path);
    const undos = code.match(/label: 'Undo'/g) ?? [];
    assert.match(code, message, `${path} should still say what it did`);
    assert.ok(undos.length >= atLeast, `${path} offers ${undos.length} undos, wanted ${atLeast}`);
  }
});

/* --- A library that has been imported into -------------------------------- */

test('the shelf builds a page at a time rather than the whole catalogue', () => {
  // Nine hundred cards is a second of work per keystroke in the search field.
  const library = read('js/views/library.js');
  assert.match(library, /const PAGE = \d+/);
  assert.match(library, /visible\.slice\(0, shown\)/);
  assert.match(library, /shelf-more/, 'and says how much is left');
});

/* --- Touch ----------------------------------------------------------------- */

test('a cover can be held to open the day, since touch cannot hover', () => {
  const calendar = read('js/views/calendar.js');
  assert.match(calendar, /pointerdown/);
  assert.match(calendar, /pointerType !== 'touch'/, 'a mouse already has hover');
  assert.match(calendar, /LONG_PRESS_SLOP/, 'a finger is never perfectly still');
});

/* --- First run and storage -------------------------------------------------- */

test('the introduction is shown once and then dismissed for good', () => {
  const calendar = read('js/views/calendar.js');
  assert.match(calendar, /introDismissed/);
  assert.match(calendar, /updateSettings\(\{ introDismissed: true \}\)/);
});

test('the app asks for persistent storage without being told to', () => {
  // Settings has a button, and a button nobody knows to press is not a
  // safeguard for a year of reading kept in localStorage.
  assert.match(read('js/app.js'), /requestPersistentStorage\(\)/);
});

/* --- Added features -------------------------------------------------------- */

test('the log offers to time a sitting rather than only to remember one', () => {
  const log = read('js/views/sessionLog.js');
  assert.match(log, /Start a timer/);
  // In storage, not in a closure: the app re-renders on every store change, and
  // a reader closes the tab and comes back.
  assert.match(log, /chapter\.timer/);
});

test('the search reaches the things people actually wrote', () => {
  const library = read('js/views/library.js');
  const searched = library.match(/const SEARCHED = \[[\s\S]*?\];/)?.[0] ?? '';

  assert.match(searched, /quotes/, 'quotes are the most specific thing anyone writes down');
  assert.match(searched, /sessions/, 'and the notes on a sitting');
  assert.match(searched, /review/);
});

test('a set of plans can be moved together', () => {
  // The commonest planning event there is: a week away, and everything after
  // it needs to move by the same amount, keeping its length and its order.
  const library = read('js/views/library.js');
  assert.match(library, /function openShiftDialog/);
  assert.match(library, /Shift plans/);
  assert.match(library, /label: 'Undo'/, 'and it can be taken back');
});

test('a record shows its own history against its plan', () => {
  assert.match(read('js/views/bookForm.js'), /historyPanel/);
  assert.match(read('js/lib/charts.js'), /export function trailChart/);
  assert.match(read('js/logic/pacing.js'), /export function progressTrail/);
});

test('the year can be taken away as text', () => {
  // A summary you can only look at is a summary that stays in the app.
  const stats = read('js/views/stats.js');
  assert.match(stats, /clipboard\.writeText/);
  assert.match(stats, /openReviewText/, 'with a fallback when the clipboard is refused');
});
