/**
 * Plans that slip, and what the record should say about it.
 *
 * Three related things are tested here, because they are three halves of one
 * complaint: a plan written on Sunday is wrong by Tuesday if you miss Monday;
 * moving a plan used to erase the plan you were actually failing to keep; and
 * a book that has been moved four times is telling you something the record
 * never said out loud.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBook } from '../js/data/schema.js';
import { paceFor, progressTrail, dayDemand, paceStanding, progressReport } from '../js/logic/pacing.js';
import { finishedSummary, observedPace } from '../js/logic/sessions.js';

class MemoryStorage {
  #entries = new Map();
  getItem(key) { return this.#entries.has(key) ? this.#entries.get(key) : null; }
  setItem(key, value) { this.#entries.set(key, String(value)); }
  removeItem(key) { this.#entries.delete(key); }
  clear() { this.#entries.clear(); }
}
globalThis.localStorage ??= new MemoryStorage();

const store = await import('../js/data/store.js');

const book = (props, todayKey) => normalizeBook({ title: 'x', ...props }, todayKey);

/* --- A missed evening condenses into the rest of the week ------------------ */

/** The reported case: 210 pages, 23–29 August, thirty a day. */
const weekly = (todayKey, sessions = []) =>
  book({
    title: 'A Princess of Mars',
    pageCount: 210,
    status: 'reading',
    schedule: { start: '2026-08-23', end: '2026-08-29' },
    actual: { startedAt: '2026-08-23' },
    sessions,
  }, todayKey);

test('an untouched plan asks for exactly what it was written for', () => {
  const fresh = weekly('2026-08-23');
  const pace = paceFor(fresh, '2026-08-23', '2026-08-23');

  assert.equal(pace.todayTarget, 30);
  assert.equal(pace.dueToday, 30);
  assert.equal(pace.condensed, false, 'nothing to condense on day one');
});

test('a missed day is spread over the days that are left', () => {
  // Read the 23rd, skipped the 24th. On the 25th there are 180 pages and five
  // days: 36 a day, not the thirty the plan was written with.
  const behind = weekly('2026-08-25', [
    { date: '2026-08-23', minutes: 45, pageFrom: 0, pageTo: 30 },
  ]);

  const pace = paceFor(behind, '2026-08-25', '2026-08-25');

  assert.equal(pace.todayTarget, 30, 'the plan still says what it said');
  assert.equal(pace.dueToday, 36, 'today asks for what actually finishes the book');
  assert.equal(pace.condensed, true);
  assert.equal(pace.daysLeft, 5);
});

test('reading ahead makes today ask for less, not more', () => {
  const ahead = weekly('2026-08-25', [
    { date: '2026-08-23', minutes: 90, pageFrom: 0, pageTo: 120 },
  ]);

  const pace = paceFor(ahead, '2026-08-25', '2026-08-25');
  assert.equal(pace.dueToday, 18, '90 left over five days');
  assert.ok(pace.dueToday < pace.todayTarget);
});

test('only today condenses; yesterday asked what it asked', () => {
  const behind = weekly('2026-08-25', [
    { date: '2026-08-23', minutes: 45, pageFrom: 0, pageTo: 30 },
  ]);

  assert.equal(paceFor(behind, '2026-08-24', '2026-08-25').dueToday, 30, 'a day gone by');
  assert.equal(paceFor(behind, '2026-08-27', '2026-08-25').dueToday, 30, 'and a day to come');
});

test('the day says why its number is not the plan’s number', () => {
  const behind = weekly('2026-08-25', [
    { date: '2026-08-23', minutes: 45, pageFrom: 0, pageTo: 30 },
  ]);

  const demand = dayDemand(behind, '2026-08-25', 'reading', '2026-08-25');
  assert.match(demand.lead, /^36 pages to read today$/);
  assert.match(demand.note, /plan asked for 30/);
  assert.match(demand.note, /5 days left/);

  const onPlan = dayDemand(weekly('2026-08-23'), '2026-08-23', 'reading', '2026-08-23');
  assert.equal(onPlan.note, null, 'nothing to explain when the two agree');
});

test('a finished book is not asked for anything more', () => {
  const done = weekly('2026-08-27', [
    { date: '2026-08-23', minutes: 400, pageFrom: 0, pageTo: 210 },
  ]);
  assert.equal(paceFor(done, '2026-08-27', '2026-08-27').dueToday, 0);
});

/* --- Moving a plan keeps the plan it replaced ------------------------------ */

beforeEach(() => {
  localStorage.clear();
  store.replaceAll([], { readingOrders: [], deleted: [] });
});

test('rescheduling files the old plan away rather than forgetting it', () => {
  const added = store.addBook({
    title: 'The War of the Worlds',
    pageCount: 192,
    schedule: { start: '2026-08-16', end: '2026-08-22' },
  }).book;

  store.rescheduleBook(added.id, '2026-08-22');

  const moved = store.getBook(added.id);
  assert.equal(moved.schedule.start, '2026-08-22');
  assert.equal(moved.schedule.history.length, 1);
  assert.deepEqual(
    { start: moved.schedule.history[0].start, end: moved.schedule.history[0].end },
    { start: '2026-08-16', end: '2026-08-22' }
  );
});

test('saving a record without touching the dates is not a reschedule', () => {
  const added = store.addBook({
    title: 'Frankenstein',
    pageCount: 280,
    schedule: { start: '2026-08-16', end: '2026-08-22' },
  }).book;

  store.updateBook(added.id, { notes: 'a note' });
  store.updateBook(added.id, { rating: 4 });

  assert.equal(store.getBook(added.id).schedule.history.length, 0);
});

test('every move is counted, and the count is what a nudge would key off', () => {
  const added = store.addBook({
    title: 'Moby-Dick',
    pageCount: 600,
    schedule: { start: '2026-08-01', end: '2026-08-10' },
  }).book;

  store.rescheduleBook(added.id, '2026-08-05');
  store.rescheduleBook(added.id, '2026-08-12');
  store.rescheduleBook(added.id, '2026-08-20');

  assert.equal(store.getBook(added.id).schedule.history.length, 3);
});

/* --- The chart judges each day by the plan it was lived under -------------- */

test('a rescheduled book is not flattered by its new plan', () => {
  // The reported case: planned 16–22 August, read only on the 17th, then moved
  // to 22–27. Measured against the *new* plan, the 18th looks comfortably
  // ahead — the new plan had not started yet, so it asked for nothing.
  const moved = book({
    pageCount: 210,
    status: 'reading',
    schedule: {
      start: '2026-08-22',
      end: '2026-08-27',
      history: [{ start: '2026-08-16', end: '2026-08-22', at: '2026-08-21' }],
    },
    actual: { startedAt: '2026-08-16' },
    sessions: [{ date: '2026-08-17', minutes: 40, pageFrom: 0, pageTo: 30 }],
  }, '2026-08-23');

  const trail = progressTrail(moved, '2026-08-23');
  const at = (day) => trail.points.find((point) => point.day === day);

  assert.equal(trail.ok, true);
  assert.equal(trail.points[0].day, '2026-08-16', 'the trail starts at the original plan');
  assert.equal(trail.moves, 1);

  // Under the plan in force on the 18th, three days in of seven, 90 pages were
  // due — and 30 had been read. Behind, which is the truth.
  const eighteenth = at('2026-08-18');
  assert.ok(eighteenth.planned > eighteenth.actual,
    `expected to be behind on the 18th, got planned ${eighteenth.planned} vs actual ${eighteenth.actual}`);

  assert.equal(at('2026-08-21').replanned, true, 'the day of the move is marked');
});

test('with no history the trail is unchanged', () => {
  const plain = book({
    pageCount: 100,
    status: 'reading',
    schedule: { start: '2026-08-20', end: '2026-08-24' },
    sessions: [{ date: '2026-08-20', minutes: 30, pageFrom: 0, pageTo: 20 }],
  }, '2026-08-22');

  const trail = progressTrail(plain, '2026-08-22');
  assert.equal(trail.moves, 0);
  assert.equal(trail.points.some((point) => point.replanned), false);
});

/* --- What finishing took --------------------------------------------------- */

test('a finished book reports what it took', () => {
  const done = book({
    pageCount: 300,
    status: 'finished',
    actual: { startedAt: '2026-07-03', finishedAt: '2026-08-10' },
    sessions: [
      { date: '2026-07-03', minutes: 120, pageFrom: 0, pageTo: 100 },
      { date: '2026-07-20', minutes: 120, pageFrom: 100, pageTo: 200 },
      { date: '2026-08-10', minutes: 120, pageFrom: 200, pageTo: 300 },
    ],
  }, '2026-08-11');

  const summary = finishedSummary(done);

  assert.equal(summary.ok, true);
  assert.equal(summary.from, '2026-07-03');
  assert.equal(summary.to, '2026-08-10');
  assert.equal(summary.days, 39, 'inclusive of both ends');
  assert.equal(summary.readingDays, 3);
  assert.equal(summary.sessions, 3);
  assert.equal(summary.minutes, 360);
  assert.equal(summary.pagesPerHour, 50, '300 pages in six hours');
  assert.equal(summary.pagesPerReadingDay, 100);
});

test('a finished book with no log still reports the dates', () => {
  const done = book({
    pageCount: 300,
    status: 'finished',
    actual: { startedAt: '2026-07-03', finishedAt: '2026-07-04' },
  }, '2026-08-11');

  const summary = finishedSummary(done);
  assert.equal(summary.days, 2);
  assert.equal(summary.sessions, 0);
  assert.equal(summary.pagesPerHour, null, 'no time logged means no speed to report');
});

/* --- A plan for what is left ----------------------------------------------- */

test('moving a plan for a part-read book plans the part that is left', () => {
  // The reported case: a 310-minute audiobook, 80% done, rescheduled to finish
  // in a single day. It used to ask for the whole 310 minutes again.
  const added = store.addBook({
    title: 'The Time Machine (audio)',
    pageCount: 310,
    formats: ['audio'],
    status: 'reading',
    schedule: { start: '2026-06-30', end: '2026-07-10' },
    progress: { page: 248 },
  }).book;

  // Rescheduled to finish it in one evening, which is what was reported.
  store.updateBook(added.id, { schedule: { start: '2026-08-20', end: '2026-08-20' } });
  const moved = store.getBook(added.id);

  assert.equal(moved.schedule.rebase.page, 248, 'the plan counts from where you are');
  assert.equal(moved.schedule.rebase.at, '2026-08-20');
  assert.equal(moved.schedule.rebase.originalStart, '2026-06-30', 'and remembers where it began');

  const pace = paceFor(moved, '2026-08-20', '2026-08-20');
  assert.equal(pace.total, 310);
  assert.equal(pace.todayTarget, 62, '62 minutes left, not the whole book again');
  assert.equal(pace.days, 1);
});

test('a moved plan spread over several days asks for the remainder, not the book', () => {
  const added = store.addBook({
    title: 'Half read',
    pageCount: 400,
    status: 'reading',
    schedule: { start: '2026-08-01', end: '2026-08-10' },
    progress: { page: 300 },
  }).book;

  // Ten days again, but only a quarter of the book is left: ten a day.
  store.rescheduleBook(added.id, '2026-08-20');
  const pace = paceFor(store.getBook(added.id), '2026-08-20', '2026-08-20');

  assert.equal(pace.days, 10);
  assert.equal(pace.todayTarget, 10, '100 left over ten days');
});

test('a book nobody has started is not rebased', () => {
  const added = store.addBook({
    title: 'Untouched',
    pageCount: 200,
    schedule: { start: '2026-08-01', end: '2026-08-10' },
  }).book;

  store.rescheduleBook(added.id, '2026-08-05');
  assert.equal(store.getBook(added.id).schedule.rebase, null, 'nothing to count from');
});

/* --- Speed, measured honestly ---------------------------------------------- */

test('an audiobook is not read at 266 minutes an hour', () => {
  // 310 minutes of audio, and only some sittings timed. The old sum divided
  // the whole book by the whole log and produced an impossible rate.
  const listened = normalizeBook({
    title: 'The Time Machine (audio)',
    pageCount: 310,
    formats: ['audio'],
    status: 'finished',
    actual: { startedAt: '2026-06-30', finishedAt: '2026-08-20' },
    sessions: [
      { date: '2026-06-30', minutes: 70, pageFrom: 0, pageTo: 70 },
      { date: '2026-07-03', pageFrom: 70, pageTo: 150 },
      { date: '2026-08-20', pageFrom: 150, pageTo: 310 },
    ],
  }, '2026-08-21');

  const summary = finishedSummary(listened);

  assert.equal(summary.unit, 'minutes');
  assert.equal(summary.pagesPerHour, null, 'an hourly page rate means nothing here');
  assert.equal(summary.listenedAt, 1, '70 minutes of audio in 70 minutes of clock');
  assert.equal(summary.partiallyTimed, true, 'and it says the log is only partly timed');
  assert.equal(summary.timedSessions, 1);
});

test('a speed is measured over the sittings that were actually timed', () => {
  const read = normalizeBook({
    title: 'Partly timed',
    pageCount: 300,
    status: 'finished',
    actual: { startedAt: '2026-08-01', finishedAt: '2026-08-03' },
    sessions: [
      { date: '2026-08-01', minutes: 60, pageFrom: 0, pageTo: 40 },
      { date: '2026-08-02', pageFrom: 40, pageTo: 260 },
      { date: '2026-08-03', minutes: 60, pageFrom: 260, pageTo: 300 },
    ],
  }, '2026-08-04');

  const summary = finishedSummary(read);
  // 80 pages across two timed hours, not 300 pages across two hours.
  assert.equal(summary.pagesPerHour, 40);
  assert.equal(summary.partiallyTimed, true);
});

test('an implausible playback speed is not reported at all', () => {
  const wrong = normalizeBook({
    title: 'Mis-logged',
    pageCount: 310,
    formats: ['audio'],
    status: 'finished',
    actual: { startedAt: '2026-08-01', finishedAt: '2026-08-02' },
    sessions: [{ date: '2026-08-01', minutes: 10, pageFrom: 0, pageTo: 310 }],
  }, '2026-08-03');

  assert.equal(finishedSummary(wrong).listenedAt, null, '31x the clock is a typo, not a habit');
});

/* --- A finished, paused or abandoned book is not still being paced -------- */

/**
 * The reported case: a finished audiobook with nothing logged, whose progress
 * strip read "Average so far: 5 pages a day, since you started, 83 days ago"
 * — a number that keeps sliding toward zero for as long as the book sits on
 * the shelf, because "since you started" was measured against the real,
 * ever-advancing today rather than against anything the book itself recorded.
 */
test('a finished book with nothing logged reports no ongoing pace at all', () => {
  const vicious = book({
    title: 'Vicious',
    pageCount: 402,
    status: 'finished',
    actual: { startedAt: '2026-06-01', finishedAt: '2026-06-03' },
    progress: { page: 402, percent: 100 },
  }, '2026-08-22'); // 83 days after it started, same as reported

  assert.equal(observedPace(vicious, '2026-08-22').ok, false,
    'nothing is "since you started" once the book is finished');

  const report = progressReport(vicious, '2026-08-22');
  assert.equal(report.rateLabel, null, 'no more invented average');
  assert.equal(report.rateBasis, null);
  assert.equal(report.timeLeft, null);
  assert.equal(report.projected, null, 'nothing left to project a finish for');
  assert.equal(report.verdict, null, 'and nothing to measure against a plan');
  assert.equal(report.needed, null);
  // The parts that are still just facts about the book stay exactly right.
  assert.equal(report.percent, 100);
  assert.equal(report.done, 402);
});

test('a finished book that WAS logged still reports no ongoing pace', () => {
  // Confirms the gate is on status, not on the presence of a log — a book can
  // be finished and well-documented and still not be "still going".
  const logged = book({
    pageCount: 300,
    status: 'finished',
    actual: { startedAt: '2026-07-01', finishedAt: '2026-07-10' },
    sessions: [{ date: '2026-07-01', minutes: 300, pageFrom: 0, pageTo: 300 }],
  }, '2026-09-01');

  assert.equal(observedPace(logged, '2026-09-01').ok, false);
  assert.equal(progressReport(logged, '2026-09-01').rateLabel, null);
});

test('an on-hold or abandoned book gets the same treatment as finished', () => {
  for (const status of ['on-hold', 'dnf']) {
    const paused = book({
      pageCount: 400,
      status,
      schedule: { start: '2026-06-01', end: '2026-06-10' },
      actual: { startedAt: '2026-06-01' },
      progress: { page: 120 },
    }, '2026-09-01');

    assert.equal(observedPace(paused, '2026-09-01').ok, false, `${status}: no ongoing pace`);
    assert.equal(progressReport(paused, '2026-09-01').needed, null, `${status}: no "needed from here"`);
    assert.equal(paceStanding(paused, '2026-09-01'), null, `${status}: no standing against the plan`);
  }
});

test('a currently-reading book is completely unaffected', () => {
  const active = book({
    pageCount: 300,
    status: 'reading',
    schedule: { start: '2026-08-01', end: '2026-08-10' },
    actual: { startedAt: '2026-08-01' },
    sessions: [
      { date: '2026-08-01', minutes: 60, pageFrom: 0, pageTo: 60 },
      { date: '2026-08-03', minutes: 60, pageFrom: 60, pageTo: 120 },
      { date: '2026-08-05', minutes: 60, pageFrom: 120, pageTo: 180 },
    ],
  }, '2026-08-06');

  const observed = observedPace(active, '2026-08-06');
  assert.equal(observed.ok, true);
  assert.ok(observed.pagesPerDay > 0);

  const report = progressReport(active, '2026-08-06');
  assert.ok(report.rateLabel, 'a book being read still gets its average');
  assert.ok(report.needed, 'and still gets a needed-from-here figure');
});

test('asking today of a paused plan says so instead of inventing a target', () => {
  const paused = book({
    pageCount: 400,
    status: 'on-hold',
    schedule: { start: '2026-06-01', end: '2026-06-20' },
    actual: { startedAt: '2026-06-01' },
    progress: { page: 100 },
  }, '2026-06-10');

  const demand = dayDemand(paused, '2026-06-10', 'reading', '2026-06-10');
  assert.match(demand.lead, /On hold/);
  assert.equal(demand.note, null);
});

test('a past day of a since-paused plan still reports its historical target', () => {
  // Suppressing today's live demand must not erase what the plan asked for on
  // a day that already happened — that is a fixed fact, not a moving one.
  const paused = book({
    pageCount: 400,
    status: 'on-hold',
    schedule: { start: '2026-06-01', end: '2026-06-20' },
    actual: { startedAt: '2026-06-01' },
    progress: { page: 100 },
  }, '2026-09-01');

  const demand = dayDemand(paused, '2026-06-05', 'reading', '2026-09-01');
  assert.match(demand.lead, /pages were due/);
});
