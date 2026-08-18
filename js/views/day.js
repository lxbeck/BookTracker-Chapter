/**
 * Day view — one day, at full size.
 *
 * The calendar answers "what does this month look like"; this answers "what am
 * I reading today", which is the question you actually open the app with. Same
 * rows as the day popup, given the whole screen and the covers to match.
 */

import { el, fill } from '../lib/dom.js';
import { allBooks } from '../data/store.js';
import { entriesForDay } from '../logic/schedule.js';
import { libraryTotals, formatDuration } from '../logic/sessions.js';
import { today, addDays, formatLong, relativeDay, formatShort } from '../lib/dates.js';
import { dayRow } from './dayRow.js';
import { openBookForm } from './bookForm.js';

/** Which day is on screen. Module state, like the calendar's month cursor. */
let cursor = null;

/** Let the calendar hand off to this view on a day click. */
export function goToDay(dayKey) {
  cursor = dayKey;
  location.hash = '#/day';
}

export function renderDay(mount) {
  const todayKey = today();
  if (!cursor) cursor = todayKey;

  const books = allBooks();
  const entries = entriesForDay(books, cursor, todayKey);
  const totals = libraryTotals(books, todayKey);
  const redraw = () => renderDay(mount);

  const loggedToday = books.flatMap((book) =>
    book.sessions.filter((session) => session.date === cursor)
  );
  const minutes = loggedToday.reduce((sum, session) => sum + (session.minutes ?? 0), 0);

  fill(mount, [
    el('div.view-head.view-head--day', {}, [
      el('div', {}, [
        el('h2.view-title', {}, formatLong(cursor)),
        el('p.view-sub', {}, [
          relativeDay(cursor, todayKey),
          entries.length ? ` \u00b7 ${entries.length} book${entries.length === 1 ? '' : 's'}` : ' \u00b7 nothing scheduled',
          minutes ? ` \u00b7 ${formatDuration(minutes)} logged` : '',
        ].join('')),
      ]),

      totals.streak.current > 0
        ? el('div.streak', { class: totals.streak.atRisk ? 'streak--at-risk' : '' }, [
            el('span', {}, [
              el('b', {}, String(totals.streak.current)),
              ` day${totals.streak.current === 1 ? '' : 's'} running`,
            ]),
          ])
        : null,

      el('div.cal-nav', {}, [
        navButton('\u2039', 'Previous day', () => move(-1, mount)),
        el('button.btn.btn--ghost', {
          type: 'button',
          onClick: () => {
            cursor = todayKey;
            redraw();
          },
        }, 'Today'),
        navButton('\u203a', 'Next day', () => move(1, mount)),
      ]),
    ]),

    el('div.day-strip', {}, weekStrip(books, cursor, todayKey, mount)),

    entries.length
      ? el('div.day-board', {}, entries.map((entry) =>
          dayRow(entry, cursor, todayKey, { redraw, size: 'large' })
        ))
      : el('div.empty', {}, [
          el('h3', {}, 'Nothing on this day'),
          el('p', {}, 'No book is planned or in progress for this date.'),
          el('button.btn.btn--stamp', {
            type: 'button',
            onClick: () => openBookForm({ defaultStart: cursor }),
          }, 'Schedule a book here'),
        ]),
  ].filter(Boolean));
}

function move(delta, mount) {
  cursor = addDays(cursor, delta);
  renderDay(mount);
}

const navButton = (glyph, label, onClick) =>
  el('button.btn.btn--ghost.cal-nav__step', { type: 'button', 'aria-label': label, onClick }, glyph);

/**
 * A week of context above the day. Jumping a fortnight one arrow-press at a
 * time is miserable, and the strip doubles as a reminder of what's coming.
 */
function weekStrip(books, dayKey, todayKey, mount) {
  return Array.from({ length: 7 }, (_, i) => {
    const key = addDays(dayKey, i - 3);
    const count = entriesForDay(books, key, todayKey).length;
    const isCursor = key === dayKey;

    return el('button.day-strip__day', {
      type: 'button',
      class: [isCursor && 'is-current', key === todayKey && 'is-today'].filter(Boolean).join(' '),
      'aria-current': isCursor ? 'date' : null,
      onClick: () => {
        cursor = key;
        renderDay(mount);
      },
    }, [
      el('span.day-strip__label', {}, formatShort(key)),
      el('span.day-strip__count', {}, count ? `${count} book${count === 1 ? '' : 's'}` : '\u2014'),
    ]);
  });
}
