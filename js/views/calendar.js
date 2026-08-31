/**
 * Calendar view — the month grid.
 *
 * Each day holds up to four cover tiles. Four is the design constraint, not an
 * accident: a fifth tile makes the row overflow the cell at realistic column
 * widths, so a day with more than four books shows three and a count. The
 * covers are laid out as a flexible row rather than a 2x2 block because a row
 * keeps every cell the same height whatever the viewport does, and a month
 * grid with ragged rows reads as broken.
 *
 * Rescheduling works by drag-and-drop, and by keyboard: focus a cover and use
 * Shift + arrows to shift its plan by a day or a week. A calendar that can only
 * be operated with a mouse is a calendar half the people can't use.
 */

import { el, fill, toast } from '../lib/dom.js';
import { allBooks, getSettings, updateSettings, rescheduleBook, getBook } from '../data/store.js';
import { monthGrid, monthName, weekdayLabels, today, addDays, formatLong, toKey } from '../lib/dates.js';
import { groupByDay, DAY_STATE_LABEL, CALENDAR_MODES } from '../logic/schedule.js';
import { FORMATS, FORMAT_PRIORITY, hasFormat } from '../data/schema.js';
import { kindsPresent, kindLabel } from '../data/kinds.js';
import { sourcesPresent, sourceLabel } from '../data/sources.js';
import { coverThumb } from './cover.js';
import { openBookForm } from './bookForm.js';
import { loadSampleLibrary } from '../data/seed.js';
import { attachHoverCard, hide as hideHoverCard } from './hoverCard.js';
import { libraryTotals, formatDuration, allSessions } from '../logic/sessions.js';
import { openDayPopup } from './dayPopup.js';
import { goToDay } from './dayCursor.js';

/**
 * How many covers a day can hold.
 *
 * Six fits comfortably at full width; below that the tiles get too narrow to
 * read as books at all, so narrower viewports show fewer and lean on the +N
 * chip. A function rather than a constant, because the answer changes when the
 * window does.
 */
const TILE_BREAKPOINTS = [
  { maxWidth: 600, tiles: 3 },
  { maxWidth: 860, tiles: 4 },
  { maxWidth: Infinity, tiles: 6 },
];

function tilesPerDay() {
  const width = globalThis.innerWidth ?? 1200;
  return TILE_BREAKPOINTS.find((stop) => width <= stop.maxWidth).tiles;
}

/**
 * How to break N tiles into rows.
 *
 * Rows are sized from the cell's height, so the row shape decides how big the
 * covers get: one book fills the whole day, three sit in a single row that
 * spans it, and six stack as two rows of three. The alternative — a fixed grid
 * with empty cells — leaves a gap where a fourth book would go, which reads as
 * a missing book rather than a deliberate layout.
 *
 * @param {number} count
 * @returns {number[]} how many tiles go in each row
 */
export function rowPlan(count) {
  switch (count) {
    case 0:
      return [];
    case 1:
      return [1];
    case 2:
      return [2];
    case 3:
      return [3];
    case 4:
      return [2, 2];
    case 5:
      return [3, 2];
    default:
      return [3, 3];
  }
}

/** Split a flat list into the chunks `rowPlan` calls for. */
function chunkByPlan(items) {
  const plan = rowPlan(items.length);
  const rows = [];
  let cursor = 0;
  for (const size of plan) {
    rows.push(items.slice(cursor, cursor + size));
    cursor += size;
  }
  return rows;
}

/** Which month is on screen. Module state — not worth persisting. */
let cursor = null;

/**
 * What is on show. An empty set means everything of that sort.
 *
 * Filtering is the real answer to a crowded day: hiding what you aren't
 * looking for beats a "+4" chip, because the chip tells you something is
 * missing without telling you what.
 *
 * Three separate questions, because they are genuinely independent — "the
 * comics" and "the audiobooks" and "the ones from the library" can each be
 * asked on their own or together. Within a row the toggles are additive
 * (comics *or* manga); across rows they narrow (comics *and* audiobook), which
 * is the only reading that makes sense: a book is one kind but may be several
 * formats, and asking for comics-or-audiobooks would be a search, not a filter.
 */
const visibleKinds = new Set();
const visibleFormats = new Set();
const visibleSources = new Set();

/** Every filter row, so adding a fourth is a row in this table. */
const FILTER_ROWS = [
  {
    id: 'kinds',
    label: 'Kind',
    aria: 'Kinds shown',
    selected: () => visibleKinds,
    // Every kind actually scheduled *in the month on screen*, including kinds
    // invented in Settings. Offering a toggle for an anthology planned for
    // November while you are looking at August is offering to filter a grid
    // down to nothing.
    present: (books) => kindsPresent(books),
    matches: (book, selected) => selected.has(book.category),
    name: (id) => kindLabel(id),
  },
  {
    id: 'formats',
    label: 'Format',
    aria: 'Formats shown',
    selected: () => visibleFormats,
    present: (books) =>
      FORMAT_PRIORITY
        .map((id) => ({
          id,
          label: FORMATS[id].label,
          count: books.filter((book) => hasFormat(book, id)).length,
        }))
        .filter((entry) => entry.count > 0),
    // A book read on paper with the audiobook playing answers to both, because
    // it genuinely is both.
    matches: (book, selected) => [...selected].some((id) => hasFormat(book, id)),
    name: (id) => FORMATS[id]?.label ?? id,
  },
  {
    id: 'sources',
    label: 'Where from',
    aria: 'Sources shown',
    selected: () => visibleSources,
    present: (books) => sourcesPresent(books),
    matches: (book, selected) => selected.has(book.source),
    name: (id) => sourceLabel(id),
  },
];

/**
 * The rows Settings can offer to hide, named.
 *
 * Exported from here rather than copied into the settings view, because a
 * second list of these is a second list to forget to update — which is how the
 * library's own row toggles once ended up offering a row that no longer
 * existed.
 */
export const calendarFilterRows = () => FILTER_ROWS.map(({ id, label }) => ({ id, label }));

/** Does this book survive every filter row currently narrowing the grid? */
function matchesFilters(book) {
  return FILTER_ROWS.every((row) => {
    const selected = row.selected();
    return selected.size === 0 || row.matches(book, selected);
  });
}

/**
 * Which calendar this is: the plan, or the record.
 *
 * Two questions were sharing one grid. "A book runs the 16th to the 22nd" and
 * "I read on the 16th and the 18th" are both true, and a view that painted the
 * scheduled days and the read days in the same covers could not tell you which
 * you were looking at. Now the plan is one calendar and the log is another,
 * and the switch between them says which you are reading.
 *
 * Module state, like the month cursor: it belongs to this session, not to the
 * library, and syncing it would make one device's view jump on another's.
 *
 * @type {'plan'|'log'}
 */
let calendarMode = 'plan';

const MODE_LABEL = { plan: 'Scheduled', log: 'Read' };

/**
 * Which calendar, and which kinds, live in the address bar.
 *
 * Module state alone meant a reload dropped you back on the scheduled view
 * with every kind showing, however carefully you had set it up — and there was
 * no way to send yourself "comics I actually read in August". The hash carries
 * both now: `#/calendar?mode=log&kinds=comic,manga`. Defaults are left out of
 * the URL rather than spelled out, so an untouched calendar keeps a clean
 * address.
 */
/**
 * Read `#/calendar?mode=log&kinds=comic,manga` back into view state.
 *
 * Anything unrecognised is left alone rather than corrected: a hand-typed
 * `mode=bananas` should leave the calendar as it was, not blank it.
 *
 * @param {string} hash
 * @returns {{mode?: string, kinds?: string[]}}
 */
export function parseCalendarHash(hash) {
  const params = new URLSearchParams(String(hash).split('?')[1] ?? '');
  const state = {};

  const mode = params.get('mode');
  if (CALENDAR_MODES.includes(mode)) state.mode = mode;

  for (const row of FILTER_ROWS) {
    if (!params.has(row.id)) continue;
    state[row.id] = params.get(row.id).split(',').map((id) => id.trim()).filter(Boolean);
  }

  return state;
}

/** The address for a given view state. Defaults are left out, not spelled out. */
export function calendarHash({ mode = 'plan', kinds = [], formats = [], sources = [] } = {}) {
  const params = new URLSearchParams();
  if (mode !== 'plan') params.set('mode', mode);

  for (const [id, values] of [['kinds', kinds], ['formats', formats], ['sources', sources]]) {
    if (values.length) params.set(id, values.join(','));
  }

  const query = params.toString();
  return `#/calendar${query ? `?${query}` : ''}`;
}

/**
 * Whether a hash is news, or this view's own echo.
 *
 * The address is written from the view on every render and read back on the
 * next one, which is a loop with a bug in the middle of it: press Read and the
 * view writes `?mode=log`; press Scheduled and the next render reads that
 * still-current address and puts the view straight back on Read. Every switch
 * above the grid stopped working after its first use, in precisely the way
 * that looks like a dead button.
 *
 * So a hash this view wrote is not read back. Anything else — a pasted link, a
 * reload, a hand-edited address, the Back button — is.
 */
export const isOwnHash = (hash, written) => written != null && hash === written;

/** The last address this view wrote, so it can recognise its own echo. */
let writtenHash = null;

function readUrlState() {
  if (isOwnHash(location.hash, writtenHash)) return;

  const state = parseCalendarHash(location.hash);

  if (state.mode) calendarMode = state.mode;

  for (const row of FILTER_ROWS) {
    if (!state[row.id]) continue;
    const selected = row.selected();
    selected.clear();
    for (const id of state[row.id]) selected.add(id);
  }
}

function writeUrlState() {
  const next = calendarHash({
    mode: calendarMode,
    kinds: [...visibleKinds],
    formats: [...visibleFormats],
    sources: [...visibleSources],
  });
  writtenHash = next;

  // replaceState rather than assigning to location.hash: this is a repaint of
  // the address bar to match the view, not a new place to press Back to.
  if (location.hash !== next) history.replaceState(null, '', next);
}

/**
 * Wired in step 4.5. Kept as hooks rather than direct imports so the grid
 * stays usable — and testable — without the popup and hover layers.
 */
const calendarHooks = {
  // Deliberately without the grid's entries: those are filtered by kind and by
  // whichever calendar is on screen, while the popup is the whole day — and a
  // popup that opened showing three books and redrew itself showing five, the
  // moment you logged a sitting, was worse than either.
  onDayOpen: (dayKey) => openDayPopup(dayKey),
  attachHover: attachHoverCard,
};

/** Re-render only when a resize actually changes how many tiles fit. */
let lastTileCount = null;
let resizeBound = false;

function bindResize(mount) {
  if (resizeBound) return;
  resizeBound = true;
  let frame = null;
  globalThis.addEventListener?.('resize', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (tilesPerDay() !== lastTileCount && document.contains(mount)) renderCalendar(mount);
    });
  });
}

/**
 * Show a specific month.
 *
 * The year view hands off to the month grid without needing to know how its
 * cursor works. Repainting directly matters when the calendar is already the
 * current route: the hash wouldn't change, so nothing would re-render.
 */
export function goToMonth(year, month) {
  cursor = { year, month };
  location.hash = '#/calendar';

  const mount = document.querySelector('#view');
  if (mount && document.body.dataset.route === 'calendar') renderCalendar(mount);
}

export function renderCalendar(mount) {
  hideHoverCard();
  readUrlState();
  dropHiddenFilters();
  const everything = allBooks();
  const books = everything.filter(matchesFilters);
  const todayKey = today();
  const { weekStartsOn } = getSettings();

  if (!cursor) {
    const now = new Date();
    cursor = { year: now.getFullYear(), month: now.getMonth() };
  }

  const maxTiles = tilesPerDay();
  lastTileCount = maxTiles;
  bindResize(mount);
  const cells = monthGrid(cursor.year, cursor.month, weekStartsOn);
  const buckets = groupByDay(books, cells.map((cell) => cell.key), todayKey, calendarMode);

  const scheduled = books.filter((b) => b.schedule.start).length;
  const daysLogged = loggedDaysInView(books);
  const totals = libraryTotals(everything, todayKey);
  const isLog = calendarMode === 'log';

  writeUrlState();

  fill(mount, [
    el('div.view-head.view-head--calendar', {}, [
      el('div', {}, [
        el('h2.view-title', {}, `${monthName(cursor.month)} ${cursor.year}`),
        el('p.view-sub', {}, isLog
          ? `${daysLogged} day${daysLogged === 1 ? '' : 's'} read this month`
          : `${scheduled} book${scheduled === 1 ? '' : 's'} on the schedule`),
      ]),
      totals.streak.current > 0 || totals.minutesThisWeek > 0 ? streakStrip(totals) : null,
      el('div.cal-nav', {}, [
        navButton('\u2039', 'Previous month', () => step(-1, mount)),
        el('button.btn.btn--ghost', { type: 'button', onClick: () => goToday(mount) }, 'Today'),
        navButton('\u203a', 'Next month', () => step(1, mount)),
      ]),
    ]),

    introStrip(everything),

    el('div.cal-filters', {}, [
      modeSwitch(mount),
      ...(filterToggles(everything, mount) ?? []),
    ].filter(Boolean)),

    isLog
      ? (daysLogged === 0 ? emptyLog() : null)
      : (scheduled === 0 ? emptyCalendar() : null),

    el('div.cal', {}, [
      el(
        'div.cal__weekdays',
        { 'aria-hidden': 'true' },
        weekdayLabels(weekStartsOn).map((name) =>
          el('span.cal__weekday', {}, [
            el('b', {}, name.slice(0, 3)),
            el('i', {}, name.slice(0, 1)),
          ])
        )
      ),
      el(
        'div.cal__grid',
        { role: 'grid', 'aria-label': `${monthName(cursor.month)} ${cursor.year}` },
        cells.map((cell) => dayCell(cell, buckets.get(cell.key) ?? [], todayKey, mount, maxTiles))
      ),
    ]),

    el('p.cal__legend', {}, [
      legendKey('reading', isLog ? 'Read that day' : 'Reading now'),
      isLog ? null : legendKey('planned', 'Planned'),
      legendKey('finished', 'Finished that day'),
      el('span.cal__legend-hint', {}, isLog
        ? 'Only days with a sitting logged \u00b7 click a day to log another'
        : 'Click a day for details, the date for the full day view \u00b7 drag a cover to reschedule'),
    ].filter(Boolean)),
  ]);
}

/**
 * The streak is deliberately forgiving: today counts as unbroken until the day
 * is actually over, so the number doesn't reset every morning and read as a
 * telling-off before you've had a chance to read anything.
 */
function streakStrip(totals) {
  const { streak } = totals;
  return el('div.streak', { class: streak.atRisk ? 'streak--at-risk' : '' }, [
    streak.current > 0
      ? el('span', {}, [
          el('b', {}, String(streak.current)),
          ` day${streak.current === 1 ? '' : 's'} running`,
        ])
      : null,
    totals.minutesThisWeek > 0
      ? el('span', {}, [el('b', {}, formatDuration(totals.minutesThisWeek)), ' this week'])
      : null,
  ].filter(Boolean));
}

/**
 * The switch between the two calendars.
 *
 * Two buttons rather than a checkbox: "Scheduled" and "Read" name what you get,
 * where a checkbox labelled "show logged reading only" would make you work out
 * what the unticked state means.
 */
function modeSwitch(mount) {
  return el('div.cal-modes', { role: 'group', 'aria-label': 'What the calendar shows' },
    CALENDAR_MODES.map((mode) =>
      el('button.cal-mode', {
        type: 'button',
        class: calendarMode === mode ? 'is-on' : '',
        'aria-pressed': String(calendarMode === mode),
        title: mode === 'plan'
          ? 'Every day a book is scheduled for'
          : 'Only the days you logged a sitting',
        onClick: () => {
          if (calendarMode === mode) return;
          calendarMode = mode;
          rerender(mount);
        },
      }, MODE_LABEL[mode])
    ));
}

/** Days in the visible month with at least one sitting logged. */
function loggedDaysInView(books) {
  const first = toKey(new Date(cursor.year, cursor.month, 1));
  const last = toKey(new Date(cursor.year, cursor.month + 1, 0));

  const days = new Set();
  for (const { session } of allSessions(books)) {
    if (session.date >= first && session.date <= last) days.add(session.date);
  }
  return days.size;
}

/**
 * What the kind filter becomes when one kind is clicked.
 *
 * From "Everything", a kind is a fresh choice rather than a deselection.
 * Selecting every kind one at a time lands back on Everything — correctly,
 * since that is what it shows — but the set underneath still held them all,
 * so the next click on Comics *removed* comics and left you looking at books.
 * Technically consistent, and unusable: the button said Comics and you got
 * Books. Everything now clears the slate, so the next click means what it says.
 *
 * Pure, and exported, because it is the rule worth testing about this row.
 *
 * @param {Set<string>} selected
 * @param {string} id
 * @param {boolean} showingAll
 * @returns {Set<string>}
 */
export function nextVisibleKinds(selected, id, showingAll) {
  if (showingAll) return new Set([id]);

  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * One row of switches per thing worth narrowing by, each with an explicit
 * "Everything".
 *
 * Toggling within a row is additive: comics and manga on together shows both
 * and hides books. Turning everything off in a row is treated as everything on
 * rather than an empty calendar, since an empty grid with no visible way back
 * is a trap.
 *
 * The rows are built from one table (see FILTER_ROWS) rather than written out
 * three times, because three near-identical copies of this is how the second
 * one quietly stops matching the first.
 */
function filterToggles(books, mount) {
  const inView = booksInView(books);

  const rows = FILTER_ROWS
    .filter((row) => showsRow(row))
    .map((row) => filterRow(row, inView, mount))
    .filter(Boolean);

  return rows.length ? rows : null;
}

/** Whether a row is switched on in Settings. A predicate, and nothing else. */
function showsRow(row) {
  return !(getSettings().hiddenCalendarRows ?? []).includes(row.id);
}

/**
 * A row switched off in Settings drops whatever it had selected.
 *
 * This has to run before the grid is filtered and before the address is
 * written, not while the rows are being built — otherwise the first render
 * after hiding a row still narrows the grid by it, and still puts it in the
 * hash, from a control that is no longer on screen to explain why. Which is
 * the worst of both: books missing, and nothing to say so.
 */
function dropHiddenFilters() {
  for (const row of FILTER_ROWS) {
    if (!showsRow(row)) row.selected().clear();
  }
}

function filterRow(row, inView, mount) {
  const present = row.present(inView);

  // Nothing to choose between when everything in view answers the same way.
  if (present.length < 2) return null;

  const selected = row.selected();
  const showingAll = selected.size === 0 || selected.size === present.length;

  const apply = (next) => {
    selected.clear();
    for (const id of next) selected.add(id);
    rerender(mount);
  };

  return el('div.kind-toggles', { role: 'group', 'aria-label': row.aria }, [
    // Three rows need saying apart; one did not.
    el('span.kind-toggles__title', {}, row.label),

    el('button.kind-toggle.kind-toggle--all', {
      type: 'button',
      class: showingAll ? 'is-on' : '',
      'aria-pressed': String(showingAll),
      onClick: () => apply([]),
    }, 'Everything'),

    ...present.map((entry) =>
      el('button.kind-toggle', {
        type: 'button',
        class: !showingAll && selected.has(entry.id) ? 'is-on' : '',
        'aria-pressed': String(!showingAll && selected.has(entry.id)),
        onClick: () => apply(nextVisibleKinds(selected, entry.id, showingAll)),
      }, [
        entry.label,
        el('span.kind-toggle__count', {}, String(entry.count)),
      ])
    ),

    // Named from the selection, not from what this month happens to hold: a
    // filter set in September and carried back to August, where that kind
    // isn't scheduled, would otherwise leave an empty grid under the words
    // "showing  only".
    !showingAll
      ? el('span.kind-toggles__note', {},
          `${[...selected].map((id) => row.name(id).toLowerCase()).join(' and ')} only`)
      : null,
  ].filter(Boolean));
}

/**
 * The books whose plans touch the month on screen.
 *
 * A plan spanning a month boundary belongs to both months, so the test is an
 * overlap rather than a start date: a book begun in July and finished in
 * August is on the August grid and its kind should be filterable there.
 */
function booksInView(books) {
  const first = toKey(new Date(cursor.year, cursor.month, 1));
  const last = toKey(new Date(cursor.year, cursor.month + 1, 0));

  return books.filter((book) => {
    const start = book.schedule.start;
    if (!start) return false;
    const end = book.schedule.end || start;
    return start <= last && end >= first;
  });
}

const rerender = (mount) => renderCalendar(mount);

function step(delta, mount) {
  const next = new Date(cursor.year, cursor.month + delta, 1);
  cursor = { year: next.getFullYear(), month: next.getMonth() };
  rerender(mount);
}

function goToday(mount) {
  const now = new Date();
  cursor = { year: now.getFullYear(), month: now.getMonth() };
  rerender(mount);
}

const navButton = (glyph, label, onClick) =>
  el('button.btn.btn--ghost.cal-nav__step', { type: 'button', 'aria-label': label, onClick }, glyph);

const legendKey = (state, label) =>
  el('span.cal__legend-key', {}, [el('i', { class: `swatch swatch--${state}` }), label]);

/* --- Cells ---------------------------------------------------------------- */

function dayCell(cell, entries, todayKey, mount, maxTiles) {
  const isToday = cell.key === todayKey;
  // Overflowing days give up one cover slot to the count, so the row never
  // grows past `maxTiles` items in total.
  const shown = entries.length > maxTiles ? entries.slice(0, maxTiles - 1) : entries;
  const overflow = entries.length - shown.length;

  const node = el('div.cal__day', {
    class: [!cell.inMonth && 'cal__day--outside', isToday && 'cal__day--today']
      .filter(Boolean)
      .join(' '),
    role: 'gridcell',
    dataset: { day: cell.key },
    'aria-label': `${formatLong(cell.key)}, ${entries.length} book${entries.length === 1 ? '' : 's'}`,
  });

  // The number opens the day at full size; the empty space opens the popup.
  // Two weights of the same gesture, so a quick look doesn't cost a page load.
  const date = el('button.cal__date', {
    type: 'button',
    onClick: (event) => {
      event.stopPropagation();
      goToDay(cell.key);
    },
    'aria-label': `Open ${formatLong(cell.key)} in the day view`,
  }, String(cell.date));

  node.addEventListener('click', (event) => {
    if (event.target.closest('.cal__tile, .cal__date, .cal__more')) return;
    openDay(cell.key, mount);
  });

  const items = [
    ...shown.map((entry) => coverTile(entry, cell.key, mount)),
    overflow > 0
      ? el(
          'button.cal__more',
          {
            type: 'button',
            onClick: () => openDay(cell.key, mount),
            'aria-label': `${overflow} more on ${formatLong(cell.key)}`,
          },
          `+${overflow}`
        )
      : null,
  ].filter(Boolean);

  const tiles = el(
    'div.cal__tiles',
    {},
    chunkByPlan(items).map((row) => el('div.cal__tile-row', {}, row))
  );

  node.append(date, tiles);
  makeDropTarget(node, cell.key, mount);
  return node;
}

function coverTile(entry, dayKey, mount) {
  const { book, state } = entry;
  // A logged day is a record of something that happened. Dragging it would
  // move the *plan*, which is not what the gesture looks like it does here, so
  // rescheduling belongs to the scheduled calendar only.
  const canMove = calendarMode !== 'log';

  const tile = el('button.cal__tile', {
    class: `cal__tile--${state}`,
    type: 'button',
    draggable: canMove ? 'true' : null,
    dataset: { bookId: book.id, state },
    'aria-label': `${book.title} — ${DAY_STATE_LABEL[state].toLowerCase()}`,
    onClick: (event) => {
      event.stopPropagation();
      openBookForm({ book });
    },
  }, coverThumb(book, { width: '100%', alt: '' }));

  attachLongPress(tile, () => openDay(dayKey, mount));

  if (!canMove) {
    calendarHooks.attachHover?.(tile, book, dayKey);
    return tile;
  }

  tile.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', book.id);
    event.dataTransfer.effectAllowed = 'move';
    tile.classList.add('is-dragging');
    document.body.classList.add('is-rescheduling');
  });

  tile.addEventListener('dragend', () => {
    tile.classList.remove('is-dragging');
    document.body.classList.remove('is-rescheduling');
  });

  // Keyboard equivalent of the drag: shift the plan without a mouse.
  tile.addEventListener('keydown', (event) => {
    if (!event.shiftKey) return;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const delta = moves[event.key];
    if (!delta) return;
    event.preventDefault();
    nudge(book.id, delta, mount);
  });

  calendarHooks.attachHover?.(tile, book, dayKey);
  return tile;
}

/**
 * Press and hold a cover to open the day.
 *
 * Hovering a cover answers "what does this day ask of me", and a touch screen
 * cannot hover — so the whole of that answer was desktop-only, and a tap went
 * straight past it into the record. A long press is the touch idiom for "tell
 * me more about this", and it lands on the day popup, which says everything
 * the hover card does and can be acted on as well.
 *
 * Touch only: a mouse already has hover, and stealing a held click from it
 * would break dragging, which is the thing a held mouse button is for.
 */
const LONG_PRESS_MS = 450;

const LONG_PRESS_SLOP = 10; // a finger is never perfectly still

function attachLongPress(node, onHold) {
  let timer = null;
  let held = false;
  let from = null;

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  node.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    held = false;
    from = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      held = true;
      onHold();
    }, LONG_PRESS_MS);
  });

  // Only a real move counts as a scroll. Cancelling on any movement at all
  // meant the press only worked for someone holding unnaturally still.
  node.addEventListener('pointermove', (event) => {
    if (!timer || !from) return;
    if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > LONG_PRESS_SLOP) cancel();
  });

  for (const event of ['pointerup', 'pointercancel', 'pointerleave']) {
    node.addEventListener(event, cancel);
  }

  // The tap that ends a long press must not also open the record behind it.
  node.addEventListener('click', (event) => {
    if (!held) return;
    held = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

/* --- Rescheduling --------------------------------------------------------- */

function makeDropTarget(node, dayKey, mount) {
  node.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    node.classList.add('is-drop-target');
  });

  node.addEventListener('dragleave', () => node.classList.remove('is-drop-target'));

  node.addEventListener('drop', (event) => {
    event.preventDefault();
    node.classList.remove('is-drop-target');
    document.body.classList.remove('is-rescheduling');
    const bookId = event.dataTransfer.getData('text/plain');
    if (bookId) moveTo(bookId, dayKey, mount);
  });
}

function moveTo(bookId, dayKey, mount) {
  const book = getBook(bookId);
  if (!book || book.schedule.start === dayKey) return;

  const result = rescheduleBook(bookId, dayKey);
  if (!result.ok) {
    toast('That book could not be moved.', { variant: 'error' });
    return;
  }
  announceMove(result.book, mount);
}

function nudge(bookId, days, mount) {
  const book = getBook(bookId);
  if (!book?.schedule.start) {
    toast('Give this book a start date before moving it.', { variant: 'error' });
    return;
  }
  const result = rescheduleBook(bookId, addDays(book.schedule.start, days));
  if (result.ok) {
    announceMove(result.book, mount);
    // The store re-renders the grid, so focus has to be re-found by book id.
    requestAnimationFrame(() => {
      document.querySelector(`.cal__tile[data-book-id="${bookId}"]`)?.focus();
    });
  }
}

function announceMove(book, mount) {
  const end = book.schedule.end;
  toast(
    `${book.title} moved to ${formatLong(book.schedule.start)}${end ? ` \u2013 ${formatLong(end)}` : ''}.`
  );
  // A move can push a book out of the visible month; follow it there.
  const moved = new Date(book.schedule.start);
  if (moved.getMonth() !== cursor.month || moved.getFullYear() !== cursor.year) {
    cursor = { year: moved.getFullYear(), month: moved.getMonth() };
    rerender(mount);
  }
}

/* --- Day interaction ------------------------------------------------------ */

/**
 * Step 4 opens the add form pre-dated to the clicked day. Step 4.5 replaces
 * this with the full day popup by setting `calendarHooks.onDayOpen`.
 */
function openDay(dayKey, mount) {
  if (calendarHooks.onDayOpen) {
    calendarHooks.onDayOpen(dayKey, () => rerender(mount));
    return;
  }
  openBookForm({ defaultStart: dayKey });
}

function emptyLog() {
  return el('div.empty.empty--inline', {}, [
    el('h3', {}, 'Nothing logged this month'),
    el('p', {}, 'This calendar shows the days you actually read. Log a sitting against a book and the day it happened fills in here.'),
    el('div.empty__actions', {}, [
      el('button.btn.btn--ghost', {
        type: 'button',
        onClick: () => goToDay(today()),
      }, 'Log today\u2019s reading'),
    ]),
  ]);
}

/**
 * What this is, on the first visit only.
 *
 * The empty states explain each corner of the app once you are standing in it,
 * which is no help at all for the question a new arrival actually has: what is
 * this for, and what am I meant to do first. Three sentences and a way to see
 * it with something on it — then it is dismissed for good, because an
 * introduction that keeps introducing itself is an advert.
 */
function introStrip(books) {
  if (getSettings().introDismissed) return null;

  const dismiss = () => updateSettings({ introDismissed: true });

  return el('div.intro', {}, [
    el('div.intro__body', {}, [
      el('h3.intro__title', {}, 'Chapter, in three sentences'),
      el('ol.intro__steps', {}, [
        el('li', {}, 'Catalogue a book and give it a start and finish date; it spreads itself across those days, with a page target for each one.'),
        el('li', {}, 'Log what you actually read. The Scheduled calendar shows the plan, the Read one shows the days you kept it.'),
        el('li', {}, 'The Day view is what today asks of you; Stats is whether the year is going the way you meant it to.'),
      ]),
      el('p.intro__note', {}, 'Everything stays in this browser unless you run the sync server. Nothing is sent anywhere.'),
    ]),
    el('div.intro__actions', {}, [
      books.length
        ? null
        : el('button.btn.btn--stamp.btn--sm', {
            type: 'button',
            onClick: () => {
              loadSampleLibrary();
              dismiss();
            },
          }, 'Show me with a sample library'),
      el('button.btn.btn--quiet.btn--sm', {
        type: 'button',
        onClick: dismiss,
      }, books.length ? 'Got it' : 'I\u2019ll start my own'),
    ].filter(Boolean)),
  ]);
}

function emptyCalendar() {
  return el('div.empty.empty--inline', {}, [
    el('h3', {}, 'Nothing scheduled yet'),
    el('p', {}, 'Give a book a start and finish date and it will appear here, spread across the days you plan to read it.'),
    el('div.empty__actions', {}, [
      el('button.btn.btn--stamp', { type: 'button', onClick: () => openBookForm() }, 'Add a book'),
      el('button.btn.btn--ghost', { type: 'button', onClick: () => loadSampleLibrary() }, 'Load a sample library'),
    ]),
  ]);
}
