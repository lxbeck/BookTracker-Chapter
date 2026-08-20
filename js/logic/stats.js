/**
 * Statistics, derived on demand.
 *
 * Nothing here is stored. Every figure is recomputed from books and sessions,
 * so editing a session or deleting a book can never leave a stale total behind
 * — the classic failure of a stats table that maintains its own counters.
 */

import {
  today, fromKey, toKey, addDays, daysBetween, monthName, formatShort, formatLong,
} from '../lib/dates.js';
import { allSessions, readingStreak, formatDuration } from './sessions.js';
import { sessionPages } from '../data/schema.js';

const monthKey = (dayKey) => dayKey.slice(0, 7);

/** Books finished in each of the last `count` months. */
export function finishedByMonth(books, count = 12, todayKey = today()) {
  const buckets = new Map();
  const cursor = fromKey(todayKey);

  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    buckets.set(toKey(date).slice(0, 7), {
      label: monthName(date.getMonth()).slice(0, 3),
      fullLabel: `${monthName(date.getMonth())} ${date.getFullYear()}`,
      // `full` is what the hover read-out shows. A three-letter axis label is
      // ambiguous across a window that spans two years.
      full: `${monthName(date.getMonth())} ${date.getFullYear()}`,
      value: 0,
      pages: 0,
    });
  }

  for (const book of books) {
    if (book.status !== 'finished' || !book.actual.finishedAt) continue;
    const bucket = buckets.get(monthKey(book.actual.finishedAt));
    if (!bucket) continue;
    bucket.value += 1;
    bucket.pages += book.pageCount ?? 0;
  }

  return [...buckets.values()];
}

/** Minutes and pages logged per month. */
export function loggedByMonth(books, count = 12, todayKey = today()) {
  const buckets = new Map();
  const cursor = fromKey(todayKey);

  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    buckets.set(toKey(date).slice(0, 7), {
      label: monthName(date.getMonth()).slice(0, 3),
      fullLabel: `${monthName(date.getMonth())} ${date.getFullYear()}`,
      full: `${monthName(date.getMonth())} ${date.getFullYear()}`,
      value: 0,
      pages: 0,
    });
  }

  for (const { session } of allSessions(books)) {
    const bucket = buckets.get(monthKey(session.date));
    if (!bucket) continue;
    bucket.value += session.minutes ?? 0;
    bucket.pages += sessionPages(session);
  }

  return [...buckets.values()];
}

/** Cumulative pages over the last `days` days. */
export function cumulativePages(books, days = 90, todayKey = today()) {
  const start = addDays(todayKey, -(days - 1));
  const perDay = new Map();

  for (const { session } of allSessions(books)) {
    if (session.date < start || session.date > todayKey) continue;
    perDay.set(session.date, (perDay.get(session.date) ?? 0) + sessionPages(session));
  }

  let running = 0;
  return Array.from({ length: days }, (_, i) => {
    const key = addDays(start, i);
    running += perDay.get(key) ?? 0;
    return {
      label: formatShort(key).slice(4),
      fullLabel: formatLong(key),
      value: running,
      day: key,
      onDay: perDay.get(key) ?? 0,
      note: (perDay.get(key) ?? 0)
        ? `${perDay.get(key)} pages that day`
        : 'nothing logged that day',
    };
  });
}

/** A year of daily minutes, oldest first, for the heat grid. */
export function dailyMinutes(books, days = 182, todayKey = today()) {
  const start = addDays(todayKey, -(days - 1));
  const perDay = new Map();

  for (const { session } of allSessions(books)) {
    if (session.date < start || session.date > todayKey) continue;
    perDay.set(session.date, (perDay.get(session.date) ?? 0) + (session.minutes ?? 0));
  }

  return Array.from({ length: days }, (_, i) => {
    const key = addDays(start, i);
    return { label: key, fullLabel: formatLong(key), value: perDay.get(key) ?? 0 };
  });
}

/** Count books by a field, biggest first. Powers genre and author breakdowns. */
export function breakdown(books, read, { onlyFinished = false } = {}) {
  const counts = new Map();

  for (const book of books) {
    if (onlyFinished && book.status !== 'finished') continue;
    const value = read(book);
    for (const key of [].concat(value).filter(Boolean)) {
      const entry = counts.get(key) ?? { value: 0, done: 0 };
      entry.value += 1;
      // Carried alongside the total so a bar can show how much of a shelf is
      // actually read. "You own 40 comics" and "you have read 6 of them" are
      // different facts, and the second is the interesting one.
      if (book.status === 'finished') entry.done += 1;
      counts.set(key, entry);
    }
  }

  return [...counts.entries()]
    .map(([label, entry]) => ({ label, value: entry.value, done: entry.done }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/**
 * The headline numbers.
 *
 * Average pace is measured across days with logged reading rather than all
 * days, because "you read 4 pages a day" is a misleading thing to tell someone
 * who reads 80 pages twice a week.
 */
/**
 * Finished books split by kind.
 *
 * "8 books finished this year" is misleading when four are single comic
 * issues; the split is what makes the number mean anything.
 */
export function finishedByCategory(books, { year = null } = {}) {
  const finished = books.filter(
    (book) =>
      book.status === 'finished' &&
      (!year || book.actual.finishedAt?.startsWith(String(year)))
  );

  const counts = new Map();
  for (const book of finished) {
    const key = book.category ?? 'book';
    const entry = counts.get(key) ?? { count: 0, pages: 0 };
    entry.count += 1;
    entry.pages += book.pageCount ?? 0;
    counts.set(key, entry);
  }

  return [...counts.entries()]
    .map(([category, entry]) => ({ category, ...entry }))
    .sort((a, b) => b.count - a.count);
}

export function headline(books, todayKey = today()) {
  const sessions = allSessions(books);
  const finished = books.filter((book) => book.status === 'finished');
  const minutes = sessions.reduce((sum, entry) => sum + (entry.session.minutes ?? 0), 0);
  const pages = sessions.reduce((sum, entry) => sum + sessionPages(entry.session), 0);
  const daysRead = new Set(sessions.map((entry) => entry.session.date)).size;

  const finishedPages = finished.reduce((sum, book) => sum + (book.pageCount ?? 0), 0);

  // How long a finished book actually took, start to finish.
  const spans = finished
    .filter((book) => book.actual.startedAt && book.actual.finishedAt)
    .map((book) => daysBetween(book.actual.startedAt, book.actual.finishedAt) + 1);

  return {
    booksFinished: finished.length,
    byCategory: finishedByCategory(books),
    byCategoryThisYear: finishedByCategory(books, { year: todayKey.slice(0, 4) }),
    pagesFinished: finishedPages,
    minutes,
    hours: minutes / 60,
    pagesLogged: pages,
    sessions: sessions.length,
    daysRead,
    pagesPerReadingDay: daysRead ? pages / daysRead : 0,
    minutesPerReadingDay: daysRead ? minutes / daysRead : 0,
    minutesPerPage: pages > 0 && minutes > 0 ? minutes / pages : null,
    averageDaysPerBook: spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : null,
    streak: readingStreak(books, todayKey),
  };
}

/**
 * Progress against a yearly goal, with the pace needed to still hit it.
 * @param {{type: 'books'|'pages', target: number}} goal
 */
/**
 * Progress against every goal that has been set.
 *
 * Goals are a list rather than one setting, because "twenty books and twelve
 * comics" is a perfectly ordinary year and expressing it as a single number
 * means picking which half to leave out. An entry with no category is the
 * overall goal and counts everything.
 */
export function allGoalProgress(books, goals, todayKey = today()) {
  return (Array.isArray(goals) ? goals : [goals])
    .map((goal) => goalProgress(books, goal, todayKey))
    .filter(Boolean);
}

export function goalProgress(books, goal, todayKey = today()) {
  if (!goal?.target) return null;

  const year = todayKey.slice(0, 4);
  const finished = books
    .filter((book) => book.status === 'finished' && book.actual.finishedAt?.startsWith(year))
    // A goal can be about one kind of thing. "Twenty books" and "twenty
    // things, four of which were single comic issues" are different years, and
    // counting them the same is what makes a round number stop meaning
    // anything by about March.
    .filter((book) => !goal.category || book.category === goal.category);

  const done =
    goal.type === 'pages'
      ? finished.reduce((sum, book) => sum + (book.pageCount ?? 0), 0)
      : finished.length;

  const dayOfYear = daysBetween(`${year}-01-01`, todayKey) + 1;
  const daysInYear = daysBetween(`${year}-01-01`, `${year}-12-31`) + 1;
  const daysLeft = Math.max(1, daysInYear - dayOfYear);

  const expected = (goal.target * dayOfYear) / daysInYear;
  const remaining = Math.max(0, goal.target - done);

  return {
    type: goal.type,
    category: goal.category ?? null,
    label: goal.label ?? null,
    target: goal.target,
    done,
    remaining,
    percent: Math.min(100, Math.round((done / goal.target) * 100)),
    expected: Math.round(expected),
    delta: Math.round(done - expected),
    onTrack: done >= expected,
    daysLeft,
    perWeekNeeded: remaining / (daysLeft / 7),
    projected: dayOfYear > 0 ? Math.round((done / dayOfYear) * daysInYear) : 0,
  };
}

export { formatDuration };
