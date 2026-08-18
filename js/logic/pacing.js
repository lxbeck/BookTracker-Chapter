/**
 * Pacing: turning a plan into "what does today ask of me".
 *
 * The obvious implementation is `pageCount / days` and done. It's wrong in a
 * way that shows: 448 pages over 11 days is 40.7 a day, and a flat rounded 41
 * drifts you to page 451 by the end. So targets are computed *cumulatively* —
 * where the plan says you should be by the end of day N — and a day's target is
 * the difference between two cumulative points. Rounding then self-corrects
 * instead of accumulating, and the last day always lands exactly on the total.
 *
 * Pure functions. The clock is always a parameter.
 */

import { today, spanLength, daysBetween, addDays } from '../lib/dates.js';
import { FORMATS } from '../data/schema.js';
import { observedPace, bookTotals, formatDuration } from './sessions.js';

/**
 * @typedef {Object} Pace
 * @property {boolean} ok            false when there isn't enough to compute
 * @property {string} reason         why, when ok is false
 * @property {number} total          pages (or minutes) in the book
 * @property {string} unit           'pages' | 'minutes'
 * @property {number} days           length of the plan in days
 * @property {number} perDay         the plan's flat daily rate, rounded
 * @property {number} dayIndex       1-based position of the day in the plan
 * @property {number} todayTarget    units to cover on this specific day
 * @property {number} cumulative     units you should have covered by day's end
 * @property {number} remaining      units left, from actual progress
 * @property {number} daysLeft       days left including the day in question
 * @property {number} adjusted       remaining / daysLeft — the honest rate now
 * @property {number} delta          actual progress minus cumulative target
 */

const EMPTY = (reason) => ({ ok: false, reason });

/**
 * Work out the pacing picture for one book on one day.
 *
 * @param {object} book
 * @param {string} [dayKey]   the day being asked about
 * @param {string} [todayKey] the real today, for ahead/behind
 * @returns {Pace}
 */
export function paceFor(book, dayKey = today(), todayKey = today()) {
  const { schedule, pageCount, progress, format } = book;
  const unit = FORMATS[format]?.unit ?? 'pages';

  if (!schedule.start) return EMPTY('No plan set');
  if (!pageCount) return EMPTY(`No length recorded, so there's no daily target`);

  const end = schedule.end ?? schedule.start;

  // A rebased plan measures from the day you caught up, not from the original
  // start — otherwise the targets keep asking you to make up days that have
  // already gone, which is the thing that makes a schedule feel like a debt.
  const rebase = schedule.rebase && dayKey >= schedule.rebase.at ? schedule.rebase : null;
  const from = rebase ? rebase.at : schedule.start;
  const base = rebase ? Math.min(rebase.page, pageCount) : 0;

  const days = spanLength(from, end);
  const dayIndex = daysBetween(from, dayKey) + 1;

  // Asking about a day outside the plan is a legitimate question with a boring
  // answer, so return the shape rather than an error.
  const inPlan = dayIndex >= 1 && dayIndex <= days;

  const at = (index) => base + Math.round(((pageCount - base) * clamp(index, 0, days)) / days);
  const cumulative = at(dayIndex);
  const todayTarget = inPlan ? cumulative - at(dayIndex - 1) : 0;

  const done = Math.min(progress.page || 0, pageCount);
  const remaining = Math.max(0, pageCount - done);
  const daysLeft = Math.max(1, daysBetween(todayKey, end) + 1);

  return {
    ok: true,
    reason: '',
    total: pageCount,
    unit,
    days,
    perDay: Math.round((pageCount - base) / days),
    rebased: Boolean(rebase),
    from,
    dayIndex,
    inPlan,
    todayTarget,
    cumulative,
    remaining,
    daysLeft,
    adjusted: Math.ceil(remaining / daysLeft),
    delta: done - at(daysBetween(from, todayKey) + 1),
    overdue: todayKey > end && remaining > 0,
  };
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** Remaining units divided by the days left in the plan, from today. */
function neededPerDay(book, todayKey = today()) {
  const { schedule, pageCount, progress } = book;
  if (!schedule.start || !pageCount) return null;

  const end = schedule.end ?? schedule.start;
  const remaining = Math.max(0, pageCount - Math.min(progress.page || 0, pageCount));
  if (!remaining) return null;

  const daysLeft = daysBetween(todayKey, end) + 1;
  if (daysLeft < 1) return { perDay: remaining, days: 0, overdue: true };

  return { perDay: Math.ceil(remaining / daysLeft), days: daysLeft, overdue: false };
}

/**
 * One sentence describing what a day asks of you. This is the line the hover
 * card leads with, so it has to survive every degenerate case: no length, no
 * plan, a day outside the plan, an audiobook measured in minutes.
 */
export function paceHeadline(book, dayKey, todayKey = today()) {
  const pace = paceFor(book, dayKey, todayKey);
  if (!pace.ok) return pace.reason;
  if (!pace.inPlan) return `Outside the plan for this book`;

  const noun = pace.unit === 'minutes' ? 'minutes' : 'pages';
  return `${pace.todayTarget} ${noun} to read today`;
}

/**
 * How the reader stands against the plan, phrased for a person rather than a
 * dashboard. Returns null when there's nothing meaningful to say.
 * @returns {{tone: 'ahead'|'behind'|'ontrack'|'overdue', text: string}|null}
 */
export function paceStanding(book, todayKey = today()) {
  const pace = paceFor(book, todayKey, todayKey);
  if (!pace.ok || book.status === 'finished') return null;

  const noun = pace.unit === 'minutes' ? 'minutes' : 'pages';

  if (pace.overdue) {
    return { tone: 'overdue', text: `Past the finish date with ${pace.remaining} ${noun} left` };
  }
  if (!book.progress.page) {
    return { tone: 'ontrack', text: `${pace.adjusted} ${noun} a day to finish on time` };
  }
  if (pace.delta <= -10) {
    return { tone: 'behind', text: `${Math.abs(pace.delta)} ${noun} behind — ${pace.adjusted} a day catches up` };
  }
  if (pace.delta >= 10) {
    return { tone: 'ahead', text: `${pace.delta} ${noun} ahead of the plan` };
  }
  return { tone: 'ontrack', text: `On track — ${pace.adjusted} ${noun} a day from here` };
}

/**
 * Projected finish date from the pace actually being read, which is usually
 * not the pace that was planned.
 *
 * The rate comes from the session log when there is one and from the single
 * progress marker when there isn't, so this works on day one and gets more
 * honest as the log fills in.
 *
 * @returns {string|null} day key
 */
export function projectedFinish(book, todayKey = today()) {
  const { pageCount, progress } = book;
  if (!pageCount) return null;

  const observed = observedPace(book, todayKey);
  if (!observed.ok || observed.pagesPerDay <= 0) return null;
  // One data point is not a reading pace. Projecting from it produces a
  // confident, specific, wrong date — worse than saying nothing yet.
  if (observed.confidence === 'low') return null;

  const done = Math.min(progress.page || 0, pageCount);
  const daysNeeded = Math.ceil((pageCount - done) / observed.pagesPerDay);
  return addDays(todayKey, Math.max(0, daysNeeded));
}

/**
 * The complete progress picture for one book: how far in, how fast, when it
 * lands, and whether that beats the date you planned for.
 *
 * This is what the library card and the record header read from, so the same
 * numbers appear everywhere rather than being recomputed slightly differently
 * in three places.
 *
 * @returns {{ok: boolean, percent: number, done: number, total: number,
 *   unit: string, remaining: number, rate: number, rateLabel: string,
 *   timeLeft: string|null, projected: string|null, verdict: object|null}}
 */
export function progressReport(book, todayKey = today()) {
  const unit = FORMATS[book.format]?.unit ?? 'pages';
  const total = book.pageCount ?? 0;
  const done = Math.min(book.progress.page || 0, total || Infinity) || 0;

  if (!total) {
    return { ok: false, percent: book.progress.percent || 0, done, total: 0, unit };
  }

  const observed = observedPace(book, todayKey);
  const totals = bookTotals(book);
  const remaining = Math.max(0, total - done);
  const projected = projectedFinish(book, todayKey);

  // How long the rest will take, in hours, when the log knows the pace per unit.
  const timeLeft =
    observed.ok && observed.minutesPerPage
      ? formatDuration(remaining * observed.minutesPerPage)
      : null;

  return {
    ok: true,
    percent: Math.round((done / total) * 100),
    done,
    total,
    unit,
    remaining,
    rate: observed.ok ? observed.pagesPerDay : 0,
    confidence: observed.confidence ?? 'none',
    // Spelled out, because "26 pages a day" on its own invites the reading
    // "you read 26 pages yesterday" when it actually means "79 pages spread
    // across the three days since you started, including the two you didn't
    // open the book".
    rateBasis: observed.ok
      ? observed.source === 'sessions'
        ? `${observed.readingDays} day${observed.readingDays === 1 ? '' : 's'} logged over ${observed.elapsed}`
        : `since you started, ${observed.elapsed} days ago`
      : null,
    rateLabel: observed.ok
      ? `${Math.round(observed.pagesPerDay)} ${unit === 'minutes' ? 'min' : 'pages'} a day`
      : null,
    // What the plan is actually asking for from here — the number to compare
    // the average against, and the one missing from the record until now.
    needed: neededPerDay(book, todayKey),
    sittings: totals.sessions,
    timeLeft,
    projected,
    verdict: projected ? finishVerdict(book, projected) : null,
    // Said plainly, so the absence of a projection doesn't read as a bug.
    projectionNote:
      !projected && observed.ok && observed.confidence === 'low'
        ? 'Log a couple more days and a finish estimate will appear.'
        : null,
  };
}

/**
 * Whether the projected finish beats the planned one. Phrased as days rather
 * than a date because "four days early" is the thing you react to.
 * @returns {{tone: 'early'|'late'|'on-time', text: string}|null}
 */
function finishVerdict(book, projected) {
  const target = book.schedule.end;
  if (!target) return { tone: 'on-time', text: `Finishes around ${projected}` };

  const drift = daysBetween(target, projected);
  if (drift <= -2) return { tone: 'early', text: `${Math.abs(drift)} days ahead of plan` };
  if (drift >= 2) return { tone: 'late', text: `${drift} days past the plan` };
  return { tone: 'on-time', text: 'Landing on plan' };
}

/* --- Catching up ----------------------------------------------------------
 *
 * Missing two days of a week-long plan doesn't mean the plan is dead; it means
 * the remaining pages belong to the remaining days. Targets are cumulative
 * from the plan's start, so simply carrying on would keep asking you to make
 * up the missed days on top of today's share — the reason a slipped schedule
 * feels like a debt rather than a plan.
 *
 * Catching up rebases: from today, spread what's left over what's left.
 * -------------------------------------------------------------------------- */

/**
 * What catching up would look like, without doing it.
 *
 * @returns {{ok: boolean, reason?: string, remaining: number, days: number,
 *   perDay: number, from: string, to: string, wasPerDay: number,
 *   needsExtension: boolean, suggestedEnd: string, unit: string}}
 */
export function catchUpPreview(book, todayKey = today()) {
  const { schedule, pageCount, progress } = book;
  const unit = FORMATS[book.format]?.unit ?? 'pages';

  if (!schedule.start) return { ok: false, reason: 'This book has no plan to catch up on.' };
  if (!pageCount) return { ok: false, reason: 'Add a page count first, or there is nothing to spread.' };

  const end = schedule.end ?? schedule.start;
  const done = Math.min(progress.page || 0, pageCount);
  const remaining = pageCount - done;

  if (remaining <= 0) return { ok: false, reason: 'This book is already finished.' };

  // Catching up from before the plan starts would compress it for no reason.
  const from = todayKey > schedule.start ? todayKey : schedule.start;
  const needsExtension = from > end;

  const current = paceFor(book, todayKey, todayKey);
  const wasPerDay = current.ok ? current.perDay : 0;

  // If the finish date has already passed, keeping the original daily pace is
  // a kinder default than demanding the whole remainder today.
  const suggestedEnd = needsExtension
    ? addDays(from, Math.max(0, Math.ceil(remaining / Math.max(wasPerDay, 1)) - 1))
    : end;

  const to = needsExtension ? suggestedEnd : end;
  const days = spanLength(from, to);

  return {
    ok: true,
    remaining,
    days,
    perDay: Math.ceil(remaining / days),
    from,
    to,
    wasPerDay,
    needsExtension,
    suggestedEnd,
    unit,
    behind: current.ok ? current.delta : 0,
  };
}

/**
 * The patch that applies a catch-up. Kept separate from the store so the
 * preview and the change can never disagree about what will happen.
 */
export function catchUpPatch(book, todayKey = today()) {
  const preview = catchUpPreview(book, todayKey);
  if (!preview.ok) return null;

  return {
    // The plan's start moves to the day you caught up. Leaving it on the
    // original date and tracking the change invisibly was the wrong call: the
    // form would still say 9 August while the targets came from the 11th, and
    // a plan you can't read off the record is not a plan.
    schedule: {
      start: preview.from,
      end: preview.to,
      rebase: {
        at: preview.from,
        page: Math.min(book.progress.page || 0, book.pageCount),
        originalStart: book.schedule.rebase?.originalStart ?? book.schedule.start,
      },
    },
  };
}

/**
 * Plan the rest of a book from where you already are.
 *
 * Distinct from catching up, which assumes the plan was right and you fell
 * behind. This is for a book you were already part-way through when you
 * started tracking it: 40% into Moby-Dick, no history, and a plan that
 * cheerfully reports you 95 pages ahead of a schedule you never followed.
 *
 * The fix is the same mechanism — rebase to today at your current page — but
 * the framing matters, because "you are ahead" and "start from here" lead to
 * completely different actions.
 */
export function startFromHere(book, todayKey = today()) {
  const { schedule, pageCount, progress } = book;
  const unit = FORMATS[book.format]?.unit ?? 'pages';

  if (!pageCount) return { ok: false, reason: 'Add a length first.' };

  const done = Math.min(progress.page || 0, pageCount);
  if (done <= 0) return { ok: false, reason: 'Record where you are first.' };

  const remaining = pageCount - done;
  if (remaining <= 0) return { ok: false, reason: 'This book is already finished.' };

  // Keep the finish date if it is still ahead; otherwise give the remainder the
  // same number of days the original plan allowed.
  const originalEnd = schedule.end ?? schedule.start;
  const keepsEnd = originalEnd && originalEnd > todayKey;
  const originalSpan = schedule.start && originalEnd ? spanLength(schedule.start, originalEnd) : 7;
  const end = keepsEnd ? originalEnd : addDays(todayKey, originalSpan - 1);

  const days = spanLength(todayKey, end);

  return {
    ok: true,
    from: todayKey,
    to: end,
    days,
    done,
    remaining,
    perDay: Math.ceil(remaining / days),
    unit,
    keepsEnd,
    currentPage: done,
    percent: Math.round((done / pageCount) * 100),
    patch: {
      schedule: {
        start: todayKey,
        end,
        rebase: {
          at: todayKey,
          page: done,
          originalStart: schedule.rebase?.originalStart ?? schedule.start,
        },
      },
      status: 'reading',
      actual: { startedAt: book.actual.startedAt ?? todayKey },
    },
  };
}

/**
 * The two halves of `startFromHere`, named separately.
 *
 * Previewing and applying are different moments — one goes in a sentence you
 * read, the other in a write you commit — and keeping the names apart stops a
 * caller from accidentally shipping the whole result object into the store.
 */
export const startFromHerePreview = (book, todayKey = today()) => startFromHere(book, todayKey);

export function startFromHerePatch(book, todayKey = today()) {
  const result = startFromHere(book, todayKey);
  return result.ok ? result.patch : null;
}
