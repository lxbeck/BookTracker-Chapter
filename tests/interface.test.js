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

test('selecting a book past the fold does not collapse the page it was on', () => {
  // The bug this guards: the checkbox and the bulk bar's Select all / Clear
  // called the full renderLibrary, which unconditionally resets `shown` back
  // to one page. Selecting a book only reachable through "Show more" made it
  // — and everything past it — disappear the instant it was clicked.
  const library = read('js/views/library.js');

  const card = library.slice(library.indexOf("el('li.shelf-card"));
  const pick = card.slice(0, card.indexOf('shelf-card__hit'));
  assert.doesNotMatch(pick, /renderLibrary\(/,
    'ticking a box does not change the shelf, sort or filter, so it must not rebuild the toolbar');
  assert.match(pick, /paintResults\(\)/g);

  const barStart = library.indexOf('function bulkBar');
  const bar = library.slice(barStart, library.indexOf("'Clear'", barStart));
  assert.match(bar, /const repaint = \(\) => paintResults\(\);/);
  assert.match(bar, /repaint\(\);/g,
    'Select all and Clear only touch the selection, unlike every edit action beside them');
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

/* --- Planning ---------------------------------------------------------------- */

test('the three day surfaces ask for the same number', () => {
  // They used to build the sentence themselves and had already drifted by a
  // word; now a missed evening has to change all three or none.
  for (const view of ['js/views/day.js', 'js/views/dayRow.js', 'js/views/hoverCard.js']) {
    assert.match(read(view), /dayDemand\(/, `${view} builds its own day sentence`);
  }
  assert.match(read('js/logic/pacing.js'), /export function dayDemand/);
});

test('the plan a day was lived under is the one it is judged by', () => {
  const pacing = read('js/logic/pacing.js');
  assert.match(pacing, /function plannedPageOn/);
  assert.match(pacing, /schedule\.history/);
});

test('moving a plan keeps the plan it replaced', () => {
  const store = read('js/data/store.js');
  assert.match(store, /function recordPlanChange/);
  // Through updateBook, so every route that moves a plan is covered: dragging,
  // the Move dialog, a bulk shift, catching up, editing the dates by hand.
  assert.match(store, /schedule: recordPlanChange\(existing/);
});

test('a much-moved book is told about, not acted on', () => {
  const form = read('js/views/bookForm.js');
  assert.match(form, /function replanNote/);
  assert.match(form, /Put it on hold/);
  assert.doesNotMatch(form, /setStatus\([^)]*'on-hold'\s*\)\s*;?\s*\/\/ automatic/);
});

/* --- Settings --------------------------------------------------------------- */

test('where books come from sits under kinds of book', () => {
  const settings = read('js/views/settings.js');
  const order = [...settings.matchAll(/(kindsBlock|bookSourcesBlock|filterRowsBlock|hiddenNeedsBlock)\(/g)]
    .map((match) => match[1]);

  const called = order.filter((name, index) => order.indexOf(name) === index);
  assert.deepEqual(
    called.slice(0, 2),
    ['kindsBlock', 'bookSourcesBlock'],
    `blocks are called in this order: ${called.join(', ')}`
  );
});

test('the needs-work editor sits above the keyboard block', () => {
  const settings = read('js/views/settings.js');
  const section = settings.slice(settings.indexOf("return section('This library'"));
  const body = section.slice(0, section.indexOf('\n}'));

  assert.ok(body.indexOf('hiddenNeedsBlock') > -1, 'the needs-work editor is in this section');
  assert.ok(
    body.indexOf('hiddenNeedsBlock') < body.indexOf("'Keyboard'"),
    'it should come before the keyboard block, not after the reading lists'
  );
});

/* --- Libraries ---------------------------------------------------------------- */

test('a second library cannot be pushed at a server that holds one', () => {
  assert.match(read('js/data/sync.js'), /isDefaultLibrary\(\)/);
});

test('the first library keeps the key it has always had', () => {
  const store = read('js/data/store.js');
  assert.match(store, /const BASE_KEY = 'chapter\.library\.v1'/);
  assert.match(store, /id === DEFAULT_LIBRARY\.id \? BASE_KEY/);
});

test('progress is asked for on its own, not inside the dates', () => {
  // Saying "I am eighty per cent through" should not look like it needs a
  // start date for a book that was never given one.
  const form = read('js/views/bookForm.js');
  const block = form.slice(form.indexOf("'How far in you are'"));

  assert.ok(block.length > 0, 'progress should have its own block');
  assert.ok(
    block.indexOf('progressInput') < block.indexOf("'Reading plan'"),
    'and it should sit above the plan that depends on it'
  );
});

test('the library can filter by where a copy came from', () => {
  const library = read('js/views/library.js');
  assert.match(library, /function sourceBar/);
  assert.match(library, /Not stated/, 'including the books with nothing stated');
  assert.match(read('js/views/settings.js'), /\['sources', 'Where from'\]/,
    'and the row can be switched off with the others');
});

test('an audiobook is never given an hourly page rate', () => {
  const sessions = read('js/logic/sessions.js');
  assert.match(sessions, /listenedAt/);
  assert.match(sessions, /timedMinutes/, 'speed comes from the sittings that were timed');
});

test('"by plan date" leads with active books rather than hiding the rest', () => {
  const library = read('js/views/library.js');
  const block = library.slice(library.indexOf("label: 'By plan date'"), library.indexOf("added:"));

  assert.match(block, /reading.*planned|planned.*reading/is, 'reading and planned should be the active bucket');
  assert.doesNotMatch(block, /\.filter\(/, 'sorting must not also filter books out of Everything');
});

test('sources can be set on a batch of books, the same as status or kind', () => {
  const library = read('js/views/library.js');
  assert.match(library, /Set where these books came from|where these books came from/i);
  assert.match(library, /Not stated/);
});

/* --- Pacing stops once a book is not being actively read ------------------- */

test('observedPace and neededPerDay are gated on actually being read', () => {
  const sessions = read('js/logic/sessions.js');
  assert.match(sessions, /if \(book\.status !== 'reading'\) return \{ ok: false/);

  const pacing = read('js/logic/pacing.js');
  assert.match(pacing, /if \(book\.status !== 'reading'\) return null;/);
  assert.match(pacing, /INACTIVE_STATUSES/);
});

test('a finished record no longer shows the redundant, misleading progress strip', () => {
  const form = read('js/views/bookForm.js');
  assert.match(form, /draft\.status !== 'finished' \? progressStrip/);
});

/* --- Mass-editing a genre ---------------------------------------------------- */

test('genre can be set on a batch of books, the same as status or kind', () => {
  const library = read('js/views/library.js');
  assert.match(library, /function openGenreDialog/);
  assert.match(library, /Set genre/);
});

/* --- Hiding the calendar's filter rows ------------------------------------- */

test('the calendar filter rows can be switched off in settings', () => {
  const calendar = read('js/views/calendar.js');
  assert.match(calendar, /hiddenCalendarRows/);
  assert.match(calendar, /export const calendarFilterRows/,
    'settings should read the row names from the calendar, not keep a second list');

  const settings = read('js/views/settings.js');
  assert.match(settings, /calendarRowsBlock/);
  assert.match(settings, /calendarFilterRows\(\)/);
});

test('a hidden row drops its filter before the grid is drawn, not while drawing it', () => {
  // Clearing it inside the row builder ran too late: the grid had already been
  // filtered and the address already written, so the first render after hiding
  // a row was still narrowed by a control no longer on screen to explain why.
  const calendar = read('js/views/calendar.js');
  const render = calendar.slice(calendar.indexOf('export function renderCalendar'));
  const body = render.slice(0, render.indexOf('\n}'));

  assert.match(body, /dropHiddenFilters\(\)/);
  assert.ok(
    body.indexOf('dropHiddenFilters()') < body.indexOf('everything.filter(matchesFilters)'),
    'it has to run before the books are filtered'
  );
  assert.ok(
    body.indexOf('dropHiddenFilters()') < body.indexOf('writeUrlState()'),
    'and before the address is written'
  );
});

test('the two sets of row toggles are told apart when read aloud', () => {
  // The library's own row toggles carry some of the same words — Kind, Format,
  // Where from — and on screen only a subtitle separates them.
  assert.match(read('js/views/settings.js'), /row on the calendar/);
});

/* --- Clearing a field the log also writes ---------------------------------- */

test('clearing a date by button marks it touched, or Save writes the old one back', () => {
  // Save calls syncFromStore first, which refreshes any field the person has
  // not edited from the stored record. Setting `.value` in code fires no input
  // event, so the clear button has to say so itself — without it, clearing
  // appeared to work, saved nothing, and the date was back on reopening.
  const form = read('js/views/bookForm.js');
  const clear = form.slice(form.indexOf("startedInput.value = '';"));
  const body = clear.slice(0, clear.indexOf('Clear what actually happened'));

  assert.match(body, /touched\.add\('startedAt'\)/);
  assert.match(body, /touched\.add\('finishedAt'\)/);
  assert.match(body, /touched\.add\('progress'\)/);
});

test('a deliberately cleared date is not stamped straight back on', () => {
  // The status rules stamp a missing date onto anything marked Reading or
  // Finished, which is right for a date never set and wrong for one just
  // deleted. The store tells them apart by comparing the patch with what it
  // is replacing.
  const store = read('js/data/store.js');
  assert.match(store, /function statusAfterClearing/);
  assert.match(store, /status: statusAfterClearing\(existing, defined\)/);
});

/* --- Two lengths ------------------------------------------------------------ */

test('the length lines are declared before the notes that read them', () => {
  // refreshProgressNote runs while the form is still being assembled, and it
  // asks which length line is showing. Declared any later, that read hits the
  // temporal dead zone and the whole record fails to open.
  const form = read('js/views/bookForm.js');
  assert.ok(
    form.indexOf('const pagesLine =') < form.indexOf('refreshProgressNote();'),
    'pagesLine has to exist before the first refreshProgressNote() call'
  );
});

test('a hidden length line is actually hidden', () => {
  // `.length-line` is display:flex, which beats the browser's own
  // `[hidden] { display: none }` — without the explicit rule the line stays
  // on screen no matter what the JavaScript sets.
  const css = read('css/components.css');
  assert.match(css, /\.length-line\[hidden\]\s*\{[^}]*display:\s*none/);
});

test('the length boxes can shrink', () => {
  // Flex items do not shrink by default, and a text box holds its ~20-character
  // intrinsic width — which is how a field row hangs off the side of a phone.
  const css = read('css/components.css');
  const block = css.slice(css.indexOf('.length-line {'), css.indexOf('.length-line__unit'));
  assert.match(block, /min-width:\s*0/);
});

test('a running time is a text box, not a number box', () => {
  // A number input drops the colons in 9:45:30 without a word rather than
  // refusing them, so the length silently becomes nothing.
  const form = read('js/views/bookForm.js');
  const audio = form.slice(form.indexOf("input('audioSeconds'"), form.indexOf("input('speed'"));
  assert.ok(!/type:\s*'number'/.test(audio), 'the running time field stays text');

  const log = read('js/views/sessionLog.js');
  assert.match(log, /field\.type = mode === 'time' \? 'text' : 'number'/);
});

test('an unreadable running time is refused rather than dropped', () => {
  const form = read('js/views/bookForm.js');
  assert.match(form, /!parseHms\(audioInput\.value\)[\s\S]{0,200}showErrors/);
});

test('the speed sits on its own line, away from the running time', () => {
  // The Length cell can be 150px wide. A label, a running time, a speed and
  // two words of connective tissue on one line left both boxes too narrow to
  // read back what was being typed into them.
  const form = read('js/views/bookForm.js');
  const audio = form.slice(form.indexOf('const audioLine ='), form.indexOf('const speedLine ='));
  assert.ok(!/speedInput/.test(audio), 'the speed is not on the running time line');
  assert.match(form, /speedLine\.hidden = !audio/, 'and it hides with it');
});

test('the length boxes have a width to shrink from, not to zero', () => {
  const css = read('css/components.css');
  const block = css.slice(css.indexOf('.length-line .input {'), css.indexOf('.length-line__unit'));
  // `flex: 1 1 0` let the box collapse to whatever space was left over.
  assert.match(block, /flex:\s*1\s+1\s+[1-9]/);
  // A number input draws its spinner arrows inside its own box, over the last
  // digit of "1.75" unless the box leaves room for them.
  assert.match(block, /\.length-line--speed \.input \{[^}]*padding-right/);
});

/* --- A date input mid-edit is not a finished date --------------------------- */

/* --- Filtering the library by more than one shelf at once ------------------ */

test('shelves are a set, not one value at a time', () => {
  // Every other library filter is one thing at a time — a shelf, a genre, a
  // format. Shelves are the one thing on a book that is genuinely a list of
  // several ("owned" and "signed" at once), so a single filters.tag could
  // never show a book on more than one shelf as picked.
  const lib = read('js/views/library.js');
  assert.match(lib, /tags:\s*new Set\(\)/);
  assert.ok(!/filters\.tag\b/.test(lib), 'the old single-value field is gone, not left dangling');
});

test('picking a second shelf widens the results, it does not narrow them', () => {
  // The calendar's own multi-select rows match on *any* checked value within
  // a row, because a book can be several things at once — ticking a second
  // one should never be a way to see fewer books. Shelves follow the same
  // rule here.
  const lib = read('js/views/library.js');
  assert.match(lib, /book\.shelves\.some\(\(shelf\) => filters\.tags\.has\(shelf\)\)/);
});

test('guessing a finish date checks the start date is actually finished', () => {
  // A native date input can fire "change" once per keystroke while a year is
  // being retyped — each one a complete-looking but wrong date, since a lone
  // "2" typed into a cleared year field reads as "0002". Without a validity
  // check here, that guess landed permanently: the guard only fires once,
  // while endInput is still empty, and never gets a second try to fix itself.
  const form = read('js/views/bookForm.js');
  const listener = form.slice(
    form.indexOf("startInput.addEventListener('change'"),
    form.indexOf("startInput.addEventListener('change'") + 800
  );
  assert.match(listener, /isValidKey\(startInput\.value\)/);
});
