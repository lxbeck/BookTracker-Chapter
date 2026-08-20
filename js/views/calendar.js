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
import { allBooks, getSettings, rescheduleBook, getBook } from '../data/store.js';
import { monthGrid, monthName, weekdayLabels, today, addDays, formatLong, toKey } from '../lib/dates.js';
import { groupByDay, DAY_STATE_LABEL } from '../logic/schedule.js';
import { matchesKinds } from '../data/schema.js';
import { kindsPresent } from '../data/kinds.js';
import { coverThumb } from './cover.js';
import { openBookForm } from './bookForm.js';
import { loadSampleLibrary } from '../data/seed.js';
import { attachHoverCard, hide as hideHoverCard } from './hoverCard.js';
import { libraryTotals, formatDuration } from '../logic/sessions.js';
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
 * Which kinds are on show. Empty means everything.
 *
 * Filtering by kind is the real answer to a crowded day: hiding what you
 * aren't looking for beats a "+4" chip, because the chip tells you something
 * is missing without telling you what.
 */
const visibleKinds = new Set();

/**
 * Wired in step 4.5. Kept as hooks rather than direct imports so the grid
 * stays usable — and testable — without the popup and hover layers.
 */
const calendarHooks = {
  onDayOpen: (dayKey, entries) => openDayPopup(dayKey, entries),
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
  const everything = allBooks();
  const books = everything.filter((book) => matchesKinds(book, visibleKinds));
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
  const buckets = groupByDay(books, cells.map((cell) => cell.key), todayKey);

  const scheduled = books.filter((b) => b.schedule.start).length;
  const totals = libraryTotals(everything, todayKey);

  fill(mount, [
    el('div.view-head.view-head--calendar', {}, [
      el('div', {}, [
        el('h2.view-title', {}, `${monthName(cursor.month)} ${cursor.year}`),
        el('p.view-sub', {}, `${scheduled} book${scheduled === 1 ? '' : 's'} on the schedule`),
      ]),
      totals.streak.current > 0 || totals.minutesThisWeek > 0 ? streakStrip(totals) : null,
      el('div.cal-nav', {}, [
        navButton('\u2039', 'Previous month', () => step(-1, mount)),
        el('button.btn.btn--ghost', { type: 'button', onClick: () => goToday(mount) }, 'Today'),
        navButton('\u203a', 'Next month', () => step(1, mount)),
      ]),
    ]),

    kindToggles(everything, mount),

    scheduled === 0 ? emptyCalendar() : null,

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
      legendKey('reading', 'Reading now'),
      legendKey('planned', 'Planned'),
      legendKey('finished', 'Finished that day'),
      el('span.cal__legend-hint', {}, 'Click a day for details, the date for the full day view \u00b7 drag a cover to reschedule'),
    ]),
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
 * One switch per kind, plus an explicit "Everything".
 *
 * Toggling is additive: comics and manga on together shows both and hides
 * books. Turning everything off is treated as everything on rather than an
 * empty calendar, since an empty grid with no visible way back is a trap.
 */
function kindToggles(books, mount) {
  // Every kind actually scheduled *in the month on screen*, including kinds
  // invented in Settings. Offering a toggle for an anthology that is planned
  // for November while you are looking at August is offering to filter a grid
  // down to nothing — and since the row is rebuilt on every render, arrowing
  // to another month re-reads it.
  const present = kindsPresent(booksInView(books));

  // Nothing to choose between when only one kind is scheduled.
  if (present.length < 2) return null;

  const showingAll = visibleKinds.size === 0 || visibleKinds.size === present.length;

  return el('div.kind-toggles', { role: 'group', 'aria-label': 'Kinds shown' }, [
    el('button.kind-toggle.kind-toggle--all', {
      type: 'button',
      class: showingAll ? 'is-on' : '',
      'aria-pressed': String(showingAll),
      onClick: () => {
        visibleKinds.clear();
        rerender(mount);
      },
    }, 'Everything'),

    ...present.map((kind) =>
      el('button.kind-toggle', {
        type: 'button',
        class: !showingAll && visibleKinds.has(kind.id) ? 'is-on' : '',
        'aria-pressed': String(!showingAll && visibleKinds.has(kind.id)),
        onClick: () => {
          if (visibleKinds.has(kind.id)) visibleKinds.delete(kind.id);
          else visibleKinds.add(kind.id);
          rerender(mount);
        },
      }, [
        kind.label,
        el('span.kind-toggle__count', {}, String(kind.count)),
      ])
    ),

    !showingAll
      ? el('span.kind-toggles__note', {},
          `showing ${present
            .filter((kind) => visibleKinds.has(kind.id))
            .map((kind) => kind.label.toLowerCase())
            .join(' and ')} only`)
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
    openDay(cell.key, entries, mount);
  });

  const items = [
    ...shown.map((entry) => coverTile(entry, cell.key, mount)),
    overflow > 0
      ? el(
          'button.cal__more',
          {
            type: 'button',
            onClick: () => openDay(cell.key, entries, mount),
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

  const tile = el('button.cal__tile', {
    class: `cal__tile--${state}`,
    type: 'button',
    draggable: 'true',
    dataset: { bookId: book.id, state },
    'aria-label': `${book.title} — ${DAY_STATE_LABEL[state].toLowerCase()}`,
    onClick: (event) => {
      event.stopPropagation();
      openBookForm({ book });
    },
  }, coverThumb(book, { width: '100%', alt: '' }));

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
function openDay(dayKey, entries, mount) {
  if (calendarHooks.onDayOpen) {
    calendarHooks.onDayOpen(dayKey, entries, () => rerender(mount));
    return;
  }
  openBookForm({ defaultStart: dayKey });
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
