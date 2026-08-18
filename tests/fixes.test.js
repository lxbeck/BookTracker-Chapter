/**
 * The batch of corrections: percent at both ends of a session, sessions with no
 * timing, non-contiguous reading days, starting a plan from current progress,
 * and the save path that used to lose logged sittings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBook, resolveProgress, validateSession, normalizeSession } from '../js/data/schema.js';
import { dayState } from '../js/logic/schedule.js';
import { readingDaysFor, observedPace } from '../js/logic/sessions.js';
import { startFromHere, paceFor } from '../js/logic/pacing.js';

const TODAY = '2026-08-11';
const book = (props) => normalizeBook({ title: 'x', ...props }, TODAY);

/* --- sessions without timing ---------------------------------------------- */

test('a session with progress but no minutes is valid', () => {
  const noTiming = normalizeSession({ date: TODAY, pageFrom: 40, pageTo: 120 });
  assert.deepEqual(validateSession(noTiming), {}, 'progress alone must be enough');
  assert.equal(noTiming.minutes, null);
});

test('a session with minutes but no pages is also valid', () => {
  assert.deepEqual(validateSession(normalizeSession({ date: TODAY, minutes: 45 })), {});
});

test('a session with neither is rejected, and says what is needed', () => {
  const errors = validateSession(normalizeSession({ date: TODAY }));
  assert.match(errors.minutes, /where you got to|how long/);
});

test('pace still works from pages when no minutes were ever logged', () => {
  const untimed = book({
    pageCount: 400, status: 'reading',
    sessions: [
      { date: '2026-08-08', pageFrom: 0, pageTo: 60 },
      { date: '2026-08-09', pageFrom: 60, pageTo: 120 },
      { date: '2026-08-11', pageFrom: 120, pageTo: 200 },
    ],
  });
  const pace = observedPace(untimed, TODAY);
  assert.ok(pace.ok);
  assert.equal(pace.pagesPerDay, 50, '200 pages over 4 elapsed days');
  assert.equal(pace.minutesPerPage, null, 'no timing means no minutes-per-page');
});

/* --- percentage at both ends ---------------------------------------------- */

test('a percentage range converts to pages at both ends', () => {
  const good = book({ pageCount: 400 });
  // "from 40% to 55%" is 160 to 220.
  assert.equal(resolveProgress(good, { percent: 40 }).page, 160);
  assert.equal(resolveProgress(good, { percent: 55 }).page, 220);
});

/* --- non-contiguous reading ---------------------------------------------- */

test('a book read on two days does not occupy the fortnight between', () => {
  const patchy = book({
    pageCount: 400,
    status: 'reading',
    schedule: { start: '2026-07-03', end: '2026-07-31' },
    actual: { startedAt: '2026-07-03' },
    sessions: [
      { date: '2026-07-03', minutes: 40, pageFrom: 0, pageTo: 50 },
      { date: '2026-07-18', minutes: 40, pageFrom: 50, pageTo: 100 },
    ],
  });

  assert.equal(dayState(patchy, '2026-07-03', TODAY), 'reading');
  assert.equal(dayState(patchy, '2026-07-18', TODAY), 'reading');
  // The days between are still part of the plan, but they are not days read.
  assert.notEqual(dayState(patchy, '2026-07-10', TODAY), 'reading');
  assert.equal(readingDaysFor(patchy).length, 2);
});

test('without a log the recorded span is still used, since nothing better exists', () => {
  const unlogged = book({
    pageCount: 400, status: 'reading',
    schedule: { start: '2026-08-01', end: '2026-08-20' },
    actual: { startedAt: '2026-08-01' },
  });
  assert.equal(dayState(unlogged, '2026-08-05', TODAY), 'reading');
});

test('a finished book with a log shows only the days it was read', () => {
  const finished = book({
    pageCount: 300, status: 'finished',
    actual: { startedAt: '2026-07-03', finishedAt: '2026-07-20' },
    sessions: [
      { date: '2026-07-03', minutes: 60, pageFrom: 0, pageTo: 150 },
      { date: '2026-07-20', minutes: 60, pageFrom: 150, pageTo: 300 },
    ],
  });
  assert.equal(dayState(finished, '2026-07-20', TODAY), 'finished', 'the finish day wins');
  assert.equal(dayState(finished, '2026-07-03', TODAY), 'reading');
  assert.equal(dayState(finished, '2026-07-10', TODAY), null, 'a day never read stays empty');
});

/* --- starting a plan from where you are ---------------------------------- */

test('a book joined part-way through is replanned from today, not flattered', () => {
  // The reported case: 40% into Moby-Dick, a plan that thinks you are miles
  // ahead of a schedule you never followed.
  const goodOmens = book({
    title: 'Moby-Dick',
    pageCount: 400,
    status: 'reading',
    schedule: { start: '2026-08-09', end: '2026-08-20' },
    progress: { page: 160 },
  });

  const before = paceFor(goodOmens, TODAY, TODAY);
  assert.ok(before.delta > 25, 'should look implausibly far ahead to begin with');

  const preview = startFromHere(goodOmens, TODAY);
  assert.ok(preview.ok, preview.reason);
  assert.equal(preview.done, 160);
  assert.equal(preview.remaining, 240);
  assert.equal(preview.from, TODAY);
  assert.equal(preview.to, '2026-08-20', 'a finish date still ahead is kept');
  assert.equal(preview.days, 10);
  assert.equal(preview.perDay, 24, '240 pages over 10 days');

  const replanned = normalizeBook({ ...goodOmens, ...preview.patch }, TODAY);
  const after = paceFor(replanned, TODAY, TODAY);
  assert.equal(after.cumulative, 160 + 24, 'tonight is where you are, plus one day');
  assert.ok(Math.abs(after.delta) < 25, 'no longer reports a fictional lead');
});

test('replanning from here still totals the whole book', () => {
  const partway = book({
    pageCount: 400, status: 'reading',
    schedule: { start: '2026-08-09', end: '2026-08-15' },
    progress: { page: 160 },
  });
  const replanned = normalizeBook({ ...partway, ...startFromHere(partway, TODAY).patch }, TODAY);

  let total = 160;
  for (const day of ['2026-08-11','2026-08-12','2026-08-13','2026-08-14','2026-08-15']) {
    total += paceFor(replanned, day, TODAY).todayTarget;
  }
  assert.equal(total, 400);
});

test('a past finish date is pushed out rather than demanding the rest today', () => {
  const overdue = book({
    pageCount: 400, status: 'reading',
    schedule: { start: '2026-07-01', end: '2026-07-14' },
    progress: { page: 100 },
  });
  const preview = startFromHere(overdue, TODAY);
  assert.ok(preview.to > TODAY, 'the new finish date must be in the future');
  assert.ok(!preview.keepsEnd);
});

test('a book with no progress has nothing to start from', () => {
  const untouched = book({ pageCount: 400, status: 'planned', schedule: { start: TODAY, end: '2026-08-20' } });
  assert.ok(!startFromHere(untouched, TODAY).ok);
});
