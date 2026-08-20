/**
 * What the session log adds up to.
 *
 * Once you're logging sittings, two better numbers become available than
 * anything the plan can give you: the pace you actually read at, and whether
 * you read at all yesterday. Both are derived here rather than stored, because
 * a stored streak is a stored bug — it goes stale the moment a session is
 * edited, deleted, or backdated.
 */

import { today, daysBetween, addDays } from '../lib/dates.js';
import { sessionPages } from '../data/schema.js';

/**
 * Totals for one book's log.
 * @returns {{sessions: number, minutes: number, pages: number, days: number,
 *   firstDay: string|null, lastDay: string|null, furthestPage: number}}
 */
export function bookTotals(book) {
  const sessions = book.sessions ?? [];
  const days = new Set(sessions.map((session) => session.date));

  return {
    sessions: sessions.length,
    minutes: sessions.reduce((sum, session) => sum + (session.minutes ?? 0), 0),
    pages: sessions.reduce((sum, session) => sum + sessionPages(session), 0),
    days: days.size,
    firstDay: sessions.length ? sessions[0].date : null,
    lastDay: sessions.length ? sessions[sessions.length - 1].date : null,
    furthestPage: sessions.reduce((max, session) => Math.max(max, session.pageTo ?? 0), 0),
  };
}

/**
 * The distinct days a book was actually read on.
 *
 * Useful wherever "since you started" would overstate things: a book read on
 * two days across a fortnight has two reading days, not fifteen.
 */
export const readingDaysFor = (book) =>
  [...new Set((book.sessions ?? []).map((session) => session.date))].sort();

/** Every session across the library, flattened, with its book attached. */
export function allSessions(books) {
  return books
    .flatMap((book) => (book.sessions ?? []).map((session) => ({ session, book })))
    .sort((a, b) => a.session.date.localeCompare(b.session.date));
}


/**
 * Consecutive days with logged reading, counting back from today.
 *
 * Today not being logged yet doesn't break a streak — you might read tonight —
 * so a streak that reaches yesterday is still live. Two days of silence ends
 * it. Without that grace the counter resets every morning and reads as
 * punishment rather than encouragement.
 *
 * @returns {{current: number, longest: number, lastDay: string|null,
 *   readToday: boolean, atRisk: boolean}}
 */
export function readingStreak(books, todayKey = today()) {
  const days = [...new Set(allSessions(books).map((entry) => entry.session.date))].sort();
  if (!days.length) {
    return { current: 0, longest: 0, lastDay: null, readToday: false, atRisk: false };
  }

  // Longest run anywhere in the history.
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i += 1) {
    run = daysBetween(days[i - 1], days[i]) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  const lastDay = days[days.length - 1];
  const readToday = lastDay === todayKey;
  const gap = daysBetween(lastDay, todayKey);

  let current = 0;
  if (gap <= 1) {
    current = 1;
    for (let i = days.length - 1; i > 0; i -= 1) {
      if (daysBetween(days[i - 1], days[i]) !== 1) break;
      current += 1;
    }
  }

  return { current, longest, lastDay, readToday, atRisk: current > 0 && !readToday };
}

/**
 * The pace actually being read, as opposed to the pace that was planned.
 *
 * Rate is measured against *elapsed* days rather than days with sessions,
 * because skipped days are part of how fast you really finish a book. The
 * per-sitting figures are reported separately for when you want the other
 * question answered.
 *
 * @returns {{ok: boolean, pagesPerDay: number, minutesPerDay: number,
 *   pagesPerSitting: number, minutesPerSitting: number,
 *   minutesPerPage: number|null, elapsed: number, source: string}}
 */
export function observedPace(book, todayKey = today()) {
  const totals = bookTotals(book);
  const start = totals.firstDay ?? book.actual.startedAt ?? book.schedule.start;

  if (!start) return { ok: false, source: 'none' };

  const elapsed = Math.max(1, daysBetween(start, todayKey) + 1);

  // Prefer the log. Fall back to a single progress marker when there's no log
  // yet, which is most books most of the time.
  const pages = totals.pages > 0 ? totals.pages : book.progress.page || 0;
  const source = totals.pages > 0 ? 'sessions' : book.progress.page ? 'progress' : 'none';

  if (source === 'none') return { ok: false, source };

  // How much evidence is behind the number. A single reading day tells you
  // almost nothing about how fast a 440-page book will go.
  const readingDays = totals.days;
  const confidence =
    source === 'sessions' && readingDays >= 3
      ? 'good'
      : source === 'sessions' && readingDays >= 2
        ? 'ok'
        : elapsed >= 4 && pages > 0
          ? 'ok'
          : 'low';

  return {
    ok: true,
    source,
    confidence,
    readingDays,
    elapsed,
    pagesPerDay: pages / elapsed,
    minutesPerDay: totals.minutes / elapsed,
    pagesPerSitting: totals.sessions ? totals.pages / totals.sessions : 0,
    minutesPerSitting: totals.sessions ? totals.minutes / totals.sessions : 0,
    minutesPerPage: totals.pages > 0 && totals.minutes > 0 ? totals.minutes / totals.pages : null,
  };
}

/** Library-wide roll-up, for the header strip and later the stats dashboard. */
export function libraryTotals(books, todayKey = today()) {
  const entries = allSessions(books);
  const last7 = entries.filter(
    (entry) => daysBetween(entry.session.date, todayKey) <= 6 && entry.session.date <= todayKey
  );

  return {
    minutes: entries.reduce((sum, entry) => sum + (entry.session.minutes ?? 0), 0),
    pages: entries.reduce((sum, entry) => sum + sessionPages(entry.session), 0),
    minutesThisWeek: last7.reduce((sum, entry) => sum + (entry.session.minutes ?? 0), 0),
    pagesThisWeek: last7.reduce((sum, entry) => sum + sessionPages(entry.session), 0),
    streak: readingStreak(books, todayKey),
  };
}

/** Format minutes the way a person says them: 95 -> "1h 35m". */
export function formatDuration(minutes) {
  const total = Math.round(minutes ?? 0);
  if (!total) return '0m';
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}


/**
 * The days a book was actually read, and the gaps between them.
 *
 * A start and an end date describe a span, not a habit. Someone who read on
 * 3 July and picked the book up again on the 18th has two reading days and a
 * fifteen-day gap, and saying so is more honest than either "read for sixteen
 * days" or "read for two".
 *
 * @returns {{days: string[], gaps: {from: string, to: string, days: number}[],
 *   longestGap: number, span: number}}
 */
export function readingHistory(book) {
  const days = [...new Set((book.sessions ?? []).map((session) => session.date))].sort();
  if (days.length < 2) {
    return { days, gaps: [], longestGap: 0, span: days.length };
  }

  const gaps = [];
  for (let i = 1; i < days.length; i += 1) {
    const between = daysBetween(days[i - 1], days[i]) - 1;
    if (between > 0) {
      gaps.push({ from: addDays(days[i - 1], 1), to: addDays(days[i], -1), days: between });
    }
  }

  return {
    days,
    gaps,
    longestGap: gaps.reduce((max, gap) => Math.max(max, gap.days), 0),
    span: daysBetween(days[0], days[days.length - 1]) + 1,
  };
}

/** A sentence describing a broken-up read, or null when it was continuous. */
export function historySummary(book) {
  const history = readingHistory(book);
  if (!history.days.length) return null;
  if (!history.gaps.length) {
    return history.days.length === 1
      ? 'Read on one day so far'
      : `Read on ${history.days.length} consecutive days`;
  }

  return (
    `Read on ${history.days.length} days across ${history.span}` +
    `, with ${history.gaps.length} break${history.gaps.length === 1 ? '' : 's'}` +
    ` (longest ${history.longestGap} days)`
  );
}
