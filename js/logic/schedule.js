/**
 * What appears on a calendar day, and why.
 *
 * The calendar needs three visually distinct states per the spec: planned,
 * reading in progress, and finished that day. Deriving them is fiddlier than
 * it looks, because a book carries both a plan and a record and they disagree
 * all the time — you start late, you finish early, you abandon it halfway.
 *
 * These are pure functions over the book list. No DOM, no store, no clock
 * except the one you pass in, so the rules are testable in isolation.
 */

import { today, withinRange, eachDay } from '../lib/dates.js';

/** @typedef {'finished'|'reading'|'planned'} DayState */

export const DAY_STATE_LABEL = {
  planned: 'Planned',
  reading: 'Reading',
  finished: 'Finished',
};

/**
 * The state a book is in on a given day, or null if it doesn't belong there.
 *
 * Precedence matters: a book finished on the 12th shows as *finished* on the
 * 12th even though the 12th also falls inside its plan.
 *
 * @param {object} book
 * @param {string} dayKey
 * @param {string} [todayKey]
 * @returns {DayState|null}
 */
export function dayState(book, dayKey, todayKey = today()) {
  const { schedule, actual, status } = book;

  // 1. The day it was finished — the strongest signal there is.
  if (actual.finishedAt === dayKey) return 'finished';

  // 2. Where there is a log, the log is the truth about which days you read.
  //    Nobody reads every day: a book started on 3 July and picked up again on
  //    the 18th did not occupy the fifteen days between, and painting it across
  //    them makes the calendar claim a fortnight of reading that never
  //    happened.
  const logged = book.sessions?.length ? new Set(book.sessions.map((s) => s.date)) : null;

  if (logged?.has(dayKey)) return 'reading';

  if (status === 'finished') {
    if (logged) return null; // the log has already had its say
    if (actual.startedAt && actual.finishedAt) {
      // No log, so the recorded span is the best guess available.
      if (withinRange(dayKey, actual.startedAt, actual.finishedAt)) return 'reading';
    }
    return null; // a finished book's *plan* is spent; don't keep drawing it
  }

  // 3. An open book with no log: assume the span, since there is nothing
  //    better. Days beyond today are still only a plan, however confident you
  //    feel. With a log, only the logged days above count as reading, and the
  //    plan below still shows the days ahead.
  if (status === 'reading' && !logged) {
    const from = actual.startedAt ?? schedule.start;
    if (from && withinRange(dayKey, from, todayKey)) return 'reading';
  }

  // 4. Anything the plan still covers.
  if (schedule.start && withinRange(dayKey, schedule.start, schedule.end ?? schedule.start)) {
    return 'planned';
  }

  // 5. A dropped or paused book keeps no forward presence on the calendar.
  return null;
}

/** Reading first, then planned, then finished — most actionable at the top. */
const STATE_WEIGHT = { reading: 0, planned: 1, finished: 2 };

/**
 * Every book on one day, ordered so the first four are the four worth showing.
 * @returns {{book: object, state: DayState}[]}
 */
export function entriesForDay(books, dayKey, todayKey = today()) {
  return books
    .map((book) => {
      const state = dayState(book, dayKey, todayKey);
      return state ? { book, state } : null;
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        STATE_WEIGHT[a.state] - STATE_WEIGHT[b.state] || a.book.title.localeCompare(b.book.title)
    );
}

/**
 * Build the whole visible month in one pass.
 *
 * Doing this per-cell would be 42 full scans of the library. Walking each
 * book's span once and bucketing by day is O(books x span) instead, which
 * matters the moment someone plans a year out.
 *
 * @param {object[]} books
 * @param {string[]} dayKeys - the grid's days, in order
 * @returns {Map<string, {book: object, state: DayState}[]>}
 */
export function groupByDay(books, dayKeys, todayKey = today()) {
  const buckets = new Map(dayKeys.map((key) => [key, []]));
  if (!dayKeys.length) return buckets;

  const first = dayKeys[0];
  const last = dayKeys[dayKeys.length - 1];

  for (const book of books) {
    // Widest window this book could possibly touch, clipped to the grid.
    const starts = [book.schedule.start, book.actual.startedAt].filter(Boolean);
    const ends = [book.schedule.end, book.schedule.start, book.actual.finishedAt, todayKey].filter(
      Boolean
    );
    if (!starts.length) continue;

    const from = [...starts].sort()[0];
    const to = [...ends].sort().at(-1);
    const clippedFrom = from < first ? first : from;
    const clippedTo = to > last ? last : to;
    if (clippedFrom > clippedTo) continue;

    for (const key of eachDay(clippedFrom, clippedTo)) {
      const state = dayState(book, key, todayKey);
      if (state) buckets.get(key)?.push({ book, state });
    }
  }

  for (const entries of buckets.values()) {
    entries.sort(
      (a, b) =>
        STATE_WEIGHT[a.state] - STATE_WEIGHT[b.state] || a.book.title.localeCompare(b.book.title)
    );
  }

  return buckets;
}
