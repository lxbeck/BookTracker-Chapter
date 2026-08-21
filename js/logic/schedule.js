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
import { compareTitles } from '../lib/titles.js';

/** @typedef {'finished'|'reading'|'planned'} DayState */

export const DAY_STATE_LABEL = {
  planned: 'Planned',
  reading: 'Reading',
  finished: 'Finished',
};

/**
 * What a calendar is being asked to show.
 *
 * `plan` is the diary: the days you set aside for a book, whether or not you
 * kept them. `log` is the record: the days you actually read, and nothing
 * else — no future, because nothing has happened there yet. They answer
 * different questions ("am I on track?" against "what did I do?"), and a
 * single view that splits the difference answers neither cleanly, which is
 * why the calendar offers both rather than blending them.
 *
 * `both` is that blend, and it is still the right answer for the day view and
 * the popup, where a day is examined one at a time and every fact about it
 * belongs on screen at once.
 *
 * @typedef {'both'|'plan'|'log'} CalendarMode
 */
export const CALENDAR_MODES = ['plan', 'log'];

/**
 * The state a book is in on a given day, or null if it doesn't belong there.
 *
 * Precedence matters: a book finished on the 12th shows as *finished* on the
 * 12th even though the 12th also falls inside its plan.
 *
 * @param {object} book
 * @param {string} dayKey
 * @param {string} [todayKey]
 * @param {CalendarMode} [mode]
 * @returns {DayState|null}
 */
export function dayState(book, dayKey, todayKey = today(), mode = 'both') {
  if (mode === 'plan') return plannedState(book, dayKey, todayKey);
  if (mode === 'log') return loggedState(book, dayKey, todayKey);

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

/**
 * The plan as written, log or no log.
 *
 * A book scheduled from the 16th to the 22nd sits on all seven days here, even
 * the ones you skipped: the question this mode answers is what you meant to
 * do, and a plan with holes punched in it by the log is no longer a plan.
 */
function plannedState(book, dayKey, todayKey) {
  const { schedule, actual, status } = book;

  if (actual.finishedAt === dayKey) return 'finished';
  if (!schedule.start) return null;
  if (!withinRange(dayKey, schedule.start, schedule.end ?? schedule.start)) return null;

  // A finished book's plan is spent — its finish day above is the last thing
  // it has to say. Leaving it painted across the rest of the span would make
  // every past month look like a month of unfinished business.
  if (status === 'finished') return null;

  // Days already gone by on a book you are reading were days at the book; the
  // rest of the span is still only an intention.
  if (status === 'reading' && dayKey <= todayKey) return 'reading';

  return 'planned';
}

/**
 * Only what actually happened.
 *
 * Sessions are the evidence, so a book scheduled across a week but read on two
 * of its days appears twice and nowhere else — and never past today, because
 * the future has nothing logged in it.
 */
function loggedState(book, dayKey, todayKey) {
  const { actual } = book;

  if (actual.finishedAt === dayKey) return 'finished';

  const sessions = book.sessions ?? [];
  if (sessions.length) {
    return sessions.some((session) => session.date === dayKey) ? 'reading' : null;
  }

  // No log at all. The recorded span is weaker evidence than a session, but it
  // is evidence, and dropping these books would empty the view for anyone who
  // records start and finish dates without logging sittings.
  if (!actual.startedAt) return null;
  const to = actual.finishedAt ?? (book.status === 'reading' ? todayKey : actual.startedAt);
  return withinRange(dayKey, actual.startedAt, to) ? 'reading' : null;
}

/** Reading first, then planned, then finished — most actionable at the top. */
const STATE_WEIGHT = { reading: 0, planned: 1, finished: 2 };

/**
 * Every book on one day, ordered so the first four are the four worth showing.
 * @param {CalendarMode} [mode]
 * @returns {{book: object, state: DayState}[]}
 */
export function entriesForDay(books, dayKey, todayKey = today(), mode = 'both') {
  return books
    .map((book) => {
      const state = dayState(book, dayKey, todayKey, mode);
      return state ? { book, state } : null;
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        STATE_WEIGHT[a.state] - STATE_WEIGHT[b.state] ||
          compareTitles(a.book.title, b.book.title)
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
 * @param {string} [todayKey]
 * @param {CalendarMode} [mode]
 * @returns {Map<string, {book: object, state: DayState}[]>}
 */
export function groupByDay(books, dayKeys, todayKey = today(), mode = 'both') {
  const buckets = new Map(dayKeys.map((key) => [key, []]));
  if (!dayKeys.length) return buckets;

  const first = dayKeys[0];
  const last = dayKeys[dayKeys.length - 1];

  for (const book of books) {
    // Widest window this book could possibly touch, clipped to the grid.
    //
    // Session dates are part of that window, not a detail: a sitting logged
    // before a book's plan begins, or on a book with no plan at all, is a real
    // day read, and a window drawn only from the schedule would step straight
    // over it.
    const logged = (book.sessions ?? []).map((session) => session.date).filter(Boolean).sort();
    const starts = [book.schedule.start, book.actual.startedAt, logged[0]].filter(Boolean);
    const ends = [
      book.schedule.end, book.schedule.start, book.actual.finishedAt, logged.at(-1), todayKey,
    ].filter(Boolean);
    if (!starts.length) continue;

    const from = [...starts].sort()[0];
    const to = [...ends].sort().at(-1);
    const clippedFrom = from < first ? first : from;
    const clippedTo = to > last ? last : to;
    if (clippedFrom > clippedTo) continue;

    for (const key of eachDay(clippedFrom, clippedTo)) {
      const state = dayState(book, key, todayKey, mode);
      if (state) buckets.get(key)?.push({ book, state });
    }
  }

  for (const entries of buckets.values()) {
    entries.sort(
      (a, b) =>
        STATE_WEIGHT[a.state] - STATE_WEIGHT[b.state] ||
          compareTitles(a.book.title, b.book.title)
    );
  }

  return buckets;
}
