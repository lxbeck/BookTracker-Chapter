/**
 * Data-layer tests. Run with `npm test` (no dependencies — node's built-in
 * runner). These cover the parts that are expensive to get wrong: day-key
 * arithmetic, the month grid the calendar renders from, and the normalise /
 * status rules that keep the plan and the record from contradicting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays,
  daysBetween,
  spanLength,
  isValidKey,
  monthGrid,
  withinRange,
  eachDay,
} from '../js/lib/dates.js';

import { normalizeBook, validateBook, applyStatusRules } from '../js/data/schema.js';

/* --- dates ---------------------------------------------------------------- */

test('day keys validate against the real calendar', () => {
  assert.ok(isValidKey('2026-02-28'));
  assert.ok(!isValidKey('2026-02-30'), 'February 30 is not a day');
  assert.ok(!isValidKey('2026-2-8'), 'unpadded months are rejected');
  assert.ok(isValidKey('2028-02-29'), 'leap day is a day');
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('daysBetween survives a DST transition', () => {
  // US DST starts 2026-03-08; a naive ms/86400000 would return 6.958 here.
  assert.equal(daysBetween('2026-03-07', '2026-03-14'), 7);
  assert.equal(daysBetween('2026-11-01', '2026-11-02'), 1);
  assert.equal(daysBetween('2026-03-14', '2026-03-07'), -7);
});

test('a Sunday-to-Saturday plan is seven days, not six', () => {
  assert.equal(spanLength('2026-03-01', '2026-03-07'), 7);
  assert.equal(spanLength('2026-03-01', '2026-03-01'), 1);
});

test('withinRange is inclusive at both ends', () => {
  assert.ok(withinRange('2026-03-01', '2026-03-01', '2026-03-07'));
  assert.ok(withinRange('2026-03-07', '2026-03-01', '2026-03-07'));
  assert.ok(!withinRange('2026-03-08', '2026-03-01', '2026-03-07'));
  assert.ok(!withinRange('2026-03-08', null, null), 'an unscheduled book is on no day');
});

test('eachDay enumerates an inclusive span', () => {
  assert.deepEqual(eachDay('2026-03-01', '2026-03-03'), ['2026-03-01', '2026-03-02', '2026-03-03']);
});

test('monthGrid always returns six full weeks', () => {
  const grid = monthGrid(2026, 1); // February 2026
  assert.equal(grid.length, 42);
  assert.equal(grid.filter((cell) => cell.inMonth).length, 28);
  assert.equal(grid[0].key, '2026-02-01', 'Feb 1 2026 is a Sunday, so no leading pad');
});

test('monthGrid respects a Monday week start', () => {
  const sunday = monthGrid(2026, 2, 0);
  const monday = monthGrid(2026, 2, 1);
  assert.notEqual(sunday[0].key, monday[0].key);
  assert.equal(monday.length, 42);
});

/* --- schema --------------------------------------------------------------- */

test('normalizeBook coerces messy input without throwing', () => {
  const book = normalizeBook({
    title: '  A Princess of Mars  ',
    pageCount: '448',
    isbn: '978-0-486-43617-3',
    format: 'papyrus',
    status: 'nonsense',
    schedule: { start: '2026-03-01', end: 'not-a-date' },
  });

  assert.equal(book.title, 'A Princess of Mars');
  assert.equal(book.pageCount, 448);
  assert.equal(book.isbn, '9780486436173');
  assert.equal(book.format, 'physical', 'unknown formats fall back');
  assert.equal(book.status, 'planned', 'unknown statuses fall back');
  assert.equal(book.schedule.end, null, 'an unparseable date is dropped, not guessed');
});

test('an end date before the start is pulled back to the start', () => {
  const book = normalizeBook({
    title: 'The Gods of Mars',
    schedule: { start: '2026-03-10', end: '2026-03-02' },
  });
  assert.equal(book.schedule.end, '2026-03-10');
});

test('marking finished stamps a finish date and completes progress', () => {
  const book = normalizeBook(
    { title: 'The Warlord of Mars', pageCount: 480, status: 'finished' },
    '2026-04-02'
  );
  assert.equal(book.actual.finishedAt, '2026-04-02');
  assert.equal(book.progress.percent, 100);
  assert.equal(book.progress.page, 480);
});

test('un-finishing a book clears the finish stamp', () => {
  const finished = normalizeBook({ title: 'Test', status: 'finished' }, '2026-04-02');
  const reopened = applyStatusRules({ ...finished, status: 'reading' }, '2026-04-05');
  assert.equal(reopened.actual.finishedAt, null);
});

test('progress percent is derived from the current page', () => {
  const book = applyStatusRules(
    normalizeBook({ title: 'Test', pageCount: 400, status: 'reading', progress: { page: 100 } })
  );
  assert.equal(Math.round(book.progress.percent), 25);
});

test('validateBook catches the errors worth catching', () => {
  assert.deepEqual(validateBook(normalizeBook({ title: 'Fine' })), {});
  assert.ok(validateBook(normalizeBook({ title: '   ' })).title);
  assert.ok(validateBook(normalizeBook({ title: 'x', isbn: '12345' })).isbn);
  assert.ok(validateBook(normalizeBook({ title: 'x', rating: 9 })).rating);
});
