/**
 * Year view — twelve months at once.
 *
 * The month grid answers "what does this week look like"; this answers "how is
 * the year shaped". At this density a cover is illegible, so each day is a
 * small square coloured by what's on it, and the detail comes from hovering or
 * clicking through.
 *
 * The window is any twelve consecutive months, not just January to December,
 * because a plan that runs August to August is a perfectly normal thing to
 * want to see whole.
 */

import { el, fill } from '../lib/dom.js';
import { allBooks, getSettings } from '../data/store.js';
import {
  monthGrid, monthName, weekdayLabels, today, formatLong, toKey, fromKey,
} from '../lib/dates.js';
import { groupByDay } from '../logic/schedule.js';
import { openDayPopup } from './dayPopup.js';
import { goToDay } from './day.js';
import { goToMonth } from './calendar.js';
import { libraryTotals, formatDuration } from '../logic/sessions.js';

/** First month on screen. Module state, like the other views' cursors. */
let cursor = null;

export function renderYear(mount) {
  const todayKey = today();
  const { weekStartsOn } = getSettings();
  const books = allBooks();

  if (!cursor) {
    const now = new Date();
    cursor = { year: now.getFullYear(), month: 0 };
  }

  const months = Array.from({ length: 12 }, (_, offset) => {
    const date = new Date(cursor.year, cursor.month + offset, 1);
    return { year: date.getFullYear(), month: date.getMonth() };
  });

  // One pass over the whole window rather than twelve separate scans.
  const allKeys = months.flatMap(({ year, month }) =>
    monthGrid(year, month, weekStartsOn).filter((cell) => cell.inMonth).map((cell) => cell.key)
  );
  const buckets = groupByDay(books, allKeys, todayKey);

  const busiest = Math.max(1, ...[...buckets.values()].map((entries) => entries.length));
  const totals = libraryTotals(books, todayKey);
  const scheduledDays = [...buckets.values()].filter((entries) => entries.length).length;

  const first = months[0];
  const last = months[11];
  const spansOneYear = first.year === last.year;

  fill(mount, [
    el('div.view-head.view-head--calendar', {}, [
      el('div', {}, [
        el('h2.view-title', {},
          spansOneYear
            ? String(first.year)
            : `${monthName(first.month).slice(0, 3)} ${first.year} \u2013 ${monthName(last.month).slice(0, 3)} ${last.year}`),
        el('p.view-sub', {},
          `${scheduledDays} days with reading planned \u00b7 ${formatDuration(totals.minutes)} logged all time`),
      ]),

      el('div.cal-nav', {}, [
        navButton('\u00ab', 'Back a year', () => shift(-12, mount)),
        navButton('\u2039', 'Back a month', () => shift(-1, mount)),
        el('button.btn.btn--ghost', {
          type: 'button',
          onClick: () => {
            // "This year" means the calendar year, not the next twelve months.
            cursor = { year: new Date().getFullYear(), month: 0 };
            renderYear(mount);
          },
        }, 'This year'),
        el('button.btn.btn--ghost', {
          type: 'button',
          onClick: () => {
            const now = new Date();
            cursor = { year: now.getFullYear(), month: now.getMonth() };
            renderYear(mount);
          },
        }, 'From this month'),
        navButton('\u203a', 'Forward a month', () => shift(1, mount)),
        navButton('\u00bb', 'Forward a year', () => shift(12, mount)),
      ]),
    ]),

    el('div.year-grid', {},
      months.map(({ year, month }) =>
        monthBlock(year, month, weekStartsOn, buckets, todayKey, busiest, mount))),

    el('p.cal__legend', {}, [
      el('span.cal__legend-key', {}, [
        el('i.swatch.swatch--planned'), 'A darker square means more books that day',
      ]),
      el('span.cal__legend-hint', {}, 'Click a day to open it'),
    ]),
  ]);
}

function shift(months, mount) {
  const next = new Date(cursor.year, cursor.month + months, 1);
  cursor = { year: next.getFullYear(), month: next.getMonth() };
  renderYear(mount);
}

const navButton = (glyph, label, onClick) =>
  el('button.btn.btn--ghost.cal-nav__step', { type: 'button', 'aria-label': label, onClick }, glyph);

function monthBlock(year, month, weekStartsOn, buckets, todayKey, busiest, mount) {
  const cells = monthGrid(year, month, weekStartsOn);
  const inMonth = cells.filter((cell) => cell.inMonth);
  const count = inMonth.reduce((sum, cell) => sum + (buckets.get(cell.key)?.length ?? 0), 0);

  return el('section.year-month', {}, [
    el('header.year-month__head', {}, [
      // The month name is the way into the month grid: at this size the
      // squares answer "how busy", and the calendar answers "with what".
      el('button.year-month__name', {
        type: 'button',
        'aria-label': `Open ${monthName(month)} ${year} in the calendar`,
        onClick: () => goToMonth(year, month),
      }, monthName(month)),
      count ? el('span.year-month__count', {}, String(count)) : null,
    ].filter(Boolean)),

    el('div.year-month__weekdays', { 'aria-hidden': 'true' },
      weekdayLabels(weekStartsOn).map((name) => el('span', {}, name.slice(0, 1)))),

    el('div.year-month__grid', { role: 'grid', 'aria-label': `${monthName(month)} ${year}` },
      cells.map((cell) => dayDot(cell, buckets, todayKey, busiest, mount))),
  ]);
}

function dayDot(cell, buckets, todayKey, busiest, mount) {
  if (!cell.inMonth) return el('span.year-day.year-day--blank', { 'aria-hidden': 'true' });

  const entries = buckets.get(cell.key) ?? [];
  const isToday = cell.key === todayKey;

  // Four steps rather than a continuous ramp: a smooth gradient at 14px is
  // impossible to read back into a number.
  const level = entries.length === 0
    ? 0
    : Math.min(4, Math.ceil((entries.length / busiest) * 4));

  const finished = entries.filter((entry) => entry.state === 'finished').length;

  const label = entries.length
    ? `${formatLong(cell.key)}: ${entries.length} book${entries.length === 1 ? '' : 's'}${finished ? `, ${finished} finished` : ''}`
    : `${formatLong(cell.key)}: nothing scheduled`;

  const node = el('button.year-day', {
    class: [
      `year-day--${level}`,
      isToday && 'year-day--today',
      finished && 'year-day--finished',
    ].filter(Boolean).join(' '),
    type: 'button',
    role: 'gridcell',
    dataset: { day: cell.key },
    'aria-label': label,
    title: label,
    onClick: (event) => {
      // Shift-click jumps straight to the full day, matching the month grid's
      // two weights of the same gesture.
      if (event.shiftKey) goToDay(cell.key);
      else openDayPopup(cell.key);
    },
  }, String(cell.date));

  return node;
}
