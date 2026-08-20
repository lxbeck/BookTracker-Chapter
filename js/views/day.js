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
import { openBookForm } from './bookForm.js';
import { coverThumb } from './cover.js';
import { paceFor, paceStanding } from '../logic/pacing.js';
import { DAY_STATE_LABEL } from '../logic/schedule.js';
import { formatUnit } from '../data/schema.js';
import { setStatus } from '../data/store.js';
import { openDayPopup } from './dayPopup.js';
import { currentDay, setCurrentDay, goToDay } from './dayCursor.js';

export function renderDay(mount) {
  const todayKey = today();
  const cursor = currentDay();

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
            setCurrentDay(todayKey);
            redraw();
          },
        }, 'Today'),
        navButton('\u203a', 'Next day', () => move(1, mount)),
      ]),
    ]),

    el('div.day-strip', {}, weekStrip(books, cursor, todayKey, mount)),

    el('div.day-board', {
      class: entries.length > 6 ? 'day-board--dense' : '',
      style: gridShape(entries.length),
    },
      entries.length
        ? entries.map((entry) => dayCard(entry, cursor, todayKey, redraw))
        : el('div.day-board__empty', {}, [
            el('h3', {}, 'Nothing on this day'),
            el('p', {}, 'No book is planned or in progress for this date.'),
            el('button.btn.btn--stamp', {
              type: 'button',
              onClick: () => openBookForm({ defaultStart: cursor }),
            }, 'Schedule a book here'),
          ])
    ),
  ].filter(Boolean));
}

/**
 * How to lay N cards into the fixed rectangle.
 *
 * Chosen to keep each card as close to a portrait shape as possible, since the
 * cover is the tallest thing in it: two books side by side, four as a 2x2,
 * nine as a 3x3. Squeezing everything into one row was what turned a busy day
 * into slivers and a sideways scrollbar.
 */
function gridShape(count) {
  if (count <= 1) return { '--day-cols': '1', '--day-rows': '1' };
  if (count === 2) return { '--day-cols': '2', '--day-rows': '1' };
  if (count <= 4) return { '--day-cols': '2', '--day-rows': '2' };
  if (count <= 6) return { '--day-cols': '3', '--day-rows': '2' };
  if (count <= 9) return { '--day-cols': '3', '--day-rows': '3' };
  if (count <= 12) return { '--day-cols': '4', '--day-rows': '3' };
  if (count <= 16) return { '--day-cols': '4', '--day-rows': '4' };
  return { '--day-cols': '5', '--day-rows': String(Math.ceil(count / 5)) };
}

function move(delta, mount) {
  setCurrentDay(addDays(currentDay(), delta));
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
        setCurrentDay(key);
        renderDay(mount);
      },
    }, [
      el('span.day-strip__label', {}, formatShort(key)),
      el('span.day-strip__count', {}, count ? `${count} book${count === 1 ? '' : 's'}` : '\u2014'),
    ]);
  });
}

/**
 * One book as a full-height card.
 *
 * The day is a single fixed rectangle, so the cover takes whatever height is
 * left after the text and derives its width from that — the same rule the
 * calendar tiles follow. Detail beyond a glance lives in the record; this view
 * is for seeing the day, not editing it.
 */
function dayCard({ book, state }, dayKey, todayKey, redraw) {
  const pace = paceFor(book, dayKey, todayKey);
  const unit = formatUnit(book);
  const noun = unit === 'minutes' ? 'minutes' : 'pages';
  const standing = paceStanding(book, todayKey);

  const lead =
    state === 'finished'
      ? 'Finished on this day'
      : !pace.ok
        ? pace.reason
        : !pace.inPlan
          ? 'Outside this book\u2019s plan'
          : `${pace.todayTarget} ${noun} ${
              dayKey < todayKey ? 'were due' : dayKey === todayKey ? 'to read today' : 'due that day'
            }`;

  return el('article.day-card', {}, [
    el('div.day-card__art', {}, coverThumb(book, { width: 'auto', alt: '' })),

    el('div.day-card__text', {}, [
      el('p.day-card__state', { class: `is-${state}` }, DAY_STATE_LABEL[state]),
      el('h3.day-card__title', {}, book.title),
      el('p.day-card__author', {}, book.author || 'Unknown author'),
      el('p.day-card__lead', {}, lead),
      pace.ok
        ? el('p.day-card__meta', {},
            `Day ${Math.min(Math.max(pace.dayIndex, 1), pace.days)} of ${pace.days} \u00b7 target ${unit === 'minutes' ? '' : 'page '}${pace.cumulative}`.trim())
        : null,
      standing ? el('p.day-card__standing', { class: `is-${standing.tone}` }, standing.text) : null,
    ].filter(Boolean)),

    el('div.day-card__actions', {}, [
      el('button.btn.btn--stamp.btn--sm', {
        type: 'button',
        onClick: () => openDayPopup(dayKey),
      }, 'Log reading'),
      book.status !== 'finished'
        ? el('button.btn.btn--quiet.btn--sm', {
            type: 'button',
            onClick: () => {
              setStatus(book.id, 'finished');
              redraw();
            },
          }, 'Finished')
        : null,
      el('button.btn.btn--quiet.btn--sm', {
        type: 'button',
        onClick: () => openBookForm({ book }),
      }, 'Record'),
    ].filter(Boolean)),
  ]);
}
