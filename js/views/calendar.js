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
import { monthGrid, monthName, weekdayLabels, today, addDays, formatLong } from '../lib/dates.js';
import { groupByDay, DAY_STATE_LABEL } from '../logic/schedule.js';
import { coverThumb } from './cover.js';
import { openBookForm } from './bookForm.js';
import { loadSampleLibrary } from '../data/seed.js';
import { attachHoverCard, hide as hideHoverCard } from './hoverCard.js';
import { openDayPopup } from './dayPopup.js';

const MAX_TILES = 4;

/** Which month is on screen. Module state — not worth persisting. */
let cursor = null;

/**
 * Wired in step 4.5. Kept as hooks rather than direct imports so the grid
 * stays usable — and testable — without the popup and hover layers.
 */
export const calendarHooks = {
  onDayOpen: (dayKey, entries) => openDayPopup(dayKey, entries),
  attachHover: attachHoverCard,
};

export function renderCalendar(mount) {
  hideHoverCard();
  const books = allBooks();
  const todayKey = today();
  const { weekStartsOn } = getSettings();

  if (!cursor) {
    const now = new Date();
    cursor = { year: now.getFullYear(), month: now.getMonth() };
  }

  const cells = monthGrid(cursor.year, cursor.month, weekStartsOn);
  const buckets = groupByDay(books, cells.map((cell) => cell.key), todayKey);

  const scheduled = books.filter((b) => b.schedule.start).length;

  fill(mount, [
    el('div.view-head', {}, [
      el('div', {}, [
        el('h2.view-title', {}, `${monthName(cursor.month)} ${cursor.year}`),
        el('p.view-sub', {}, `${scheduled} book${scheduled === 1 ? '' : 's'} on the schedule`),
      ]),
      el('div.cal-nav', {}, [
        navButton('\u2039', 'Previous month', () => step(-1, mount)),
        el('button.btn.btn--ghost', { type: 'button', onClick: () => goToday(mount) }, 'Today'),
        navButton('\u203a', 'Next month', () => step(1, mount)),
      ]),
    ]),

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
        cells.map((cell) => dayCell(cell, buckets.get(cell.key) ?? [], todayKey, mount))
      ),
    ]),

    el('p.cal__legend', {}, [
      legendKey('reading', 'Reading now'),
      legendKey('planned', 'Planned'),
      legendKey('finished', 'Finished that day'),
      el('span.cal__legend-hint', {}, 'Drag a cover to reschedule \u00b7 Shift + arrows to nudge'),
    ]),
  ]);
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

function dayCell(cell, entries, todayKey, mount) {
  const isToday = cell.key === todayKey;
  const shown = entries.length > MAX_TILES ? entries.slice(0, MAX_TILES - 1) : entries;
  const overflow = entries.length - shown.length;

  const node = el('div.cal__day', {
    class: [!cell.inMonth && 'cal__day--outside', isToday && 'cal__day--today']
      .filter(Boolean)
      .join(' '),
    role: 'gridcell',
    dataset: { day: cell.key },
    'aria-label': `${formatLong(cell.key)}, ${entries.length} book${entries.length === 1 ? '' : 's'}`,
  });

  const date = el('button.cal__date', {
    type: 'button',
    onClick: () => openDay(cell.key, entries, mount),
    'aria-label': `Open ${formatLong(cell.key)}`,
  }, String(cell.date));

  const tiles = el(
    'div.cal__tiles',
    {},
    [
      ...shown.map((entry) => coverTile(entry, cell.key, mount)),
      overflow > 0 &&
        el(
          'button.cal__more',
          {
            type: 'button',
            onClick: () => openDay(cell.key, entries, mount),
            'aria-label': `${overflow} more on ${formatLong(cell.key)}`,
          },
          `+${overflow}`
        ),
    ].filter(Boolean)
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
