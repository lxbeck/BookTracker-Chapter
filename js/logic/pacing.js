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
  const days = spanLength(schedule.start, end);
  const dayIndex = daysBetween(schedule.start, dayKey) + 1;

  // Asking about a day outside the plan is a legitimate question with a boring
  // answer, so return the shape rather than an error.
  const inPlan = dayIndex >= 1 && dayIndex <= days;

  const at = (index) => Math.round((pageCount * clamp(index, 0, days)) / days);
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
    perDay: Math.round(pageCount / days),
    dayIndex,
    inPlan,
    todayTarget,
    cumulative,
    remaining,
    daysLeft,
    adjusted: Math.ceil(remaining / daysLeft),
    delta: done - at(daysBetween(schedule.start, todayKey) + 1),
    overdue: todayKey > end && remaining > 0,
  };
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

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
    rateLabel: observed.ok
      ? `${Math.round(observed.pagesPerDay)} ${unit === 'minutes' ? 'min' : 'pages'} a day`
      : null,
    sittings: totals.sessions,
    timeLeft,
    projected,
    verdict: projected ? finishVerdict(book, projected) : null,
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
