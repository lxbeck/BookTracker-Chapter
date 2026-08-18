/**
 * Session log tests: totals, streak rules, and the pace derived from what was
 * actually read rather than what was planned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBook, normalizeSession, validateSession, sessionPages } from '../js/data/schema.js';
import {
  bookTotals,
  readingStreak,
  observedPace,
  libraryTotals,
  formatDuration,
} from '../js/logic/sessions.js';

const TODAY = '2026-03-10';

const withSessions = (sessions, props = {}) =>
  normalizeBook(
    {
      title: 'A Princess of Mars',
      pageCount: 448,
      status: 'reading',
      schedule: { start: '2026-03-01', end: '2026-03-11' },
      actual: { startedAt: '2026-03-01' },
      sessions,
      ...props,
    },
    TODAY
  );

/* --- session shape -------------------------------------------------------- */

test('a session with its pages backwards is straightened out', () => {
  const session = normalizeSession({ date: '2026-03-02', pageFrom: 90, pageTo: 40 });
  assert.equal(session.pageFrom, 40);
  assert.equal(session.pageTo, 90);
  assert.equal(sessionPages(session), 50);
});

test('a session must record minutes, a page reached, or both', () => {
  assert.ok(validateSession(normalizeSession({ date: '2026-03-02' })).minutes);
  assert.deepEqual(validateSession(normalizeSession({ date: '2026-03-02', minutes: 30 })), {});
  assert.deepEqual(validateSession(normalizeSession({ date: '2026-03-02', pageTo: 60 })), {});
});

test('a session cannot reach past the end of the book', () => {
  const book = withSessions([]);
  const errors = validateSession(normalizeSession({ date: TODAY, pageTo: 900 }), book);
  assert.match(errors.pageTo, /only has 448 pages/);
});

test('a session without a date is dropped rather than stored broken', () => {
  const book = withSessions([{ minutes: 30 }, { date: '2026-03-02', minutes: 20 }]);
  assert.equal(book.sessions.length, 1);
});

test('sessions are kept in date order however they were entered', () => {
  const book = withSessions([
    { date: '2026-03-05', minutes: 20 },
    { date: '2026-03-02', minutes: 30 },
    { date: '2026-03-03', minutes: 25 },
  ]);
  assert.deepEqual(
    book.sessions.map((s) => s.date),
    ['2026-03-02', '2026-03-03', '2026-03-05']
  );
});

/* --- totals --------------------------------------------------------------- */

test('totals add up minutes, pages, and distinct days read', () => {
  const book = withSessions([
    { date: '2026-03-02', minutes: 40, pageFrom: 0, pageTo: 55 },
    { date: '2026-03-02', minutes: 20, pageFrom: 55, pageTo: 80 },
    { date: '2026-03-04', minutes: 60, pageFrom: 80, pageTo: 160 },
  ]);

  const totals = bookTotals(book);
  assert.equal(totals.sessions, 3);
  assert.equal(totals.minutes, 120);
  assert.equal(totals.pages, 160);
  assert.equal(totals.days, 2, 'two sittings on one day is one day read');
  assert.equal(totals.furthestPage, 160);
});

test('durations read the way people say them', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(60), '1h');
  assert.equal(formatDuration(95), '1h 35m');
});

/* --- streaks -------------------------------------------------------------- */

test('consecutive days build a streak', () => {
  const book = withSessions([
    { date: '2026-03-08', minutes: 30 },
    { date: '2026-03-09', minutes: 30 },
    { date: '2026-03-10', minutes: 30 },
  ]);
  const streak = readingStreak([book], TODAY);
  assert.equal(streak.current, 3);
  assert.ok(streak.readToday);
  assert.ok(!streak.atRisk);
});

test("not having read yet today does not break yesterday's streak", () => {
  const book = withSessions([
    { date: '2026-03-08', minutes: 30 },
    { date: '2026-03-09', minutes: 30 },
  ]);
  const streak = readingStreak([book], TODAY);
  assert.equal(streak.current, 2, 'still live — the day is not over');
  assert.ok(streak.atRisk, 'flagged so the interface can nudge');
});

test('two silent days ends the streak', () => {
  const book = withSessions([
    { date: '2026-03-06', minutes: 30 },
    { date: '2026-03-07', minutes: 30 },
  ]);
  const streak = readingStreak([book], TODAY);
  assert.equal(streak.current, 0);
  assert.equal(streak.longest, 2, 'history is still remembered');
});

test('a streak spans books, not just one of them', () => {
  const a = withSessions([{ date: '2026-03-09', minutes: 30 }]);
  const b = withSessions([{ date: '2026-03-10', minutes: 30 }], { title: 'Another' });
  assert.equal(readingStreak([a, b], TODAY).current, 2);
});

test('an empty library has no streak and does not throw', () => {
  const streak = readingStreak([], TODAY);
  assert.equal(streak.current, 0);
  assert.equal(streak.lastDay, null);
});

/* --- observed pace -------------------------------------------------------- */

test('observed pace measures against elapsed days, not just days read', () => {
  const book = withSessions([
    { date: '2026-03-01', minutes: 60, pageFrom: 0, pageTo: 100 },
    { date: '2026-03-05', minutes: 60, pageFrom: 100, pageTo: 200 },
  ]);

  const pace = observedPace(book, TODAY);
  assert.equal(pace.source, 'sessions');
  assert.equal(pace.elapsed, 10, 'Mar 1 to Mar 10 inclusive');
  assert.equal(pace.pagesPerDay, 20, '200 pages over 10 elapsed days');
  assert.equal(pace.pagesPerSitting, 100);
  assert.equal(pace.minutesPerPage, 0.6);
});

test('with no log, pace falls back to the single progress marker', () => {
  const book = withSessions([], { progress: { page: 150 } });
  const pace = observedPace(book, TODAY);
  assert.equal(pace.source, 'progress');
  assert.equal(pace.pagesPerDay, 15);
});

test('a book with neither log nor progress reports no pace at all', () => {
  const book = withSessions([], { progress: { page: 0 } });
  assert.equal(observedPace(book, TODAY).ok, false);
});

/* --- library roll-up ------------------------------------------------------ */

test('library totals count the last seven days separately', () => {
  const book = withSessions([
    { date: '2026-03-01', minutes: 90, pageFrom: 0, pageTo: 100 },
    { date: '2026-03-09', minutes: 45, pageFrom: 100, pageTo: 150 },
    { date: '2026-03-10', minutes: 30, pageFrom: 150, pageTo: 180 },
  ]);

  const totals = libraryTotals([book], TODAY);
  assert.equal(totals.minutes, 165);
  assert.equal(totals.minutesThisWeek, 75, 'March 1 is outside the window');
  assert.equal(totals.pagesThisWeek, 80);
});
