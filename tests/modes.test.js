/**
 * The two calendars, and the filter row above them.
 *
 * "Scheduled" and "Read" answer different questions about the same book, and
 * the bug they were introduced for is the one where you cannot tell which
 * question the grid in front of you is answering: a book planned 16–22 August
 * and read on the 16th and the 18th was drawn across all seven days, with the
 * two days that actually happened distinguished only by the colour of a
 * two-pixel underline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBook } from '../js/data/schema.js';
import { dayState, entriesForDay, groupByDay } from '../js/logic/schedule.js';
import { monthGrid } from '../js/lib/dates.js';

const TODAY = '2026-08-18';
const book = (props) => normalizeBook({ title: 'x', ...props }, TODAY);

/** The example from the report: a week planned, two days of it read. */
const patchy = () =>
  book({
    title: 'A Princess of Mars',
    pageCount: 400,
    status: 'reading',
    schedule: { start: '2026-08-16', end: '2026-08-22' },
    actual: { startedAt: '2026-08-16' },
    sessions: [
      { date: '2026-08-16', minutes: 40, pageFrom: 0, pageTo: 60 },
      { date: '2026-08-18', minutes: 40, pageFrom: 60, pageTo: 130 },
    ],
  });

/* --- the scheduled calendar ----------------------------------------------- */

test('the scheduled calendar shows every day of the plan, skipped or not', () => {
  const planned = patchy();

  for (const day of ['2026-08-16', '2026-08-17', '2026-08-18', '2026-08-22']) {
    assert.ok(dayState(planned, day, TODAY, 'plan'), `${day} is part of the plan`);
  }
  assert.equal(dayState(planned, '2026-08-15', TODAY, 'plan'), null, 'the day before is not');
  assert.equal(dayState(planned, '2026-08-23', TODAY, 'plan'), null, 'nor the day after');
});

test('the scheduled calendar still says which days have been and gone', () => {
  const planned = patchy();

  assert.equal(dayState(planned, '2026-08-17', TODAY, 'plan'), 'reading', 'already past');
  assert.equal(dayState(planned, '2026-08-20', TODAY, 'plan'), 'planned', 'still ahead');
});

test('a finished book keeps only its finish day on the scheduled calendar', () => {
  const done = book({
    status: 'finished',
    schedule: { start: '2026-08-01', end: '2026-08-14' },
    actual: { startedAt: '2026-08-01', finishedAt: '2026-08-09' },
  });

  assert.equal(dayState(done, '2026-08-09', TODAY, 'plan'), 'finished');
  assert.equal(dayState(done, '2026-08-12', TODAY, 'plan'), null, 'the plan is spent');
});

/* --- the logged calendar --------------------------------------------------- */

test('the logged calendar shows only the days actually read', () => {
  const read = patchy();

  assert.equal(dayState(read, '2026-08-16', TODAY, 'log'), 'reading');
  assert.equal(dayState(read, '2026-08-18', TODAY, 'log'), 'reading');
  assert.equal(dayState(read, '2026-08-17', TODAY, 'log'), null, 'a skipped day is empty');
  assert.equal(dayState(read, '2026-08-20', TODAY, 'log'), null, 'the future logs nothing');
});

test('the logged calendar keeps the day a book was finished', () => {
  const done = book({
    status: 'finished',
    schedule: { start: '2026-08-01', end: '2026-08-14' },
    actual: { startedAt: '2026-08-01', finishedAt: '2026-08-09' },
    sessions: [{ date: '2026-08-01', minutes: 60, pageFrom: 0, pageTo: 200 }],
  });

  assert.equal(dayState(done, '2026-08-09', TODAY, 'log'), 'finished');
  assert.equal(dayState(done, '2026-08-01', TODAY, 'log'), 'reading');
  assert.equal(dayState(done, '2026-08-05', TODAY, 'log'), null);
});

test('a book with no log falls back to the span it was recorded over', () => {
  // Someone who fills in start and finish dates but never logs a sitting still
  // has a reading history, and an empty logged calendar would be a lie.
  const unlogged = book({
    status: 'finished',
    actual: { startedAt: '2026-08-02', finishedAt: '2026-08-04' },
  });

  assert.equal(dayState(unlogged, '2026-08-03', TODAY, 'log'), 'reading');
  assert.equal(dayState(unlogged, '2026-08-05', TODAY, 'log'), null);
});

test('an unscheduled book that was read still appears on the logged calendar', () => {
  const spontaneous = book({
    status: 'reading',
    schedule: { start: null, end: null },
    sessions: [{ date: '2026-08-17', minutes: 30, pageFrom: 0, pageTo: 40 }],
  });

  assert.equal(dayState(spontaneous, '2026-08-17', TODAY, 'log'), 'reading');
  assert.equal(dayState(spontaneous, '2026-08-17', TODAY, 'plan'), null, 'it was never planned');

  // And the month grid must reach it: the window used to be drawn from the
  // schedule alone, which for this book is nothing at all.
  const grid = monthGrid(2026, 7).map((cell) => cell.key);
  const grouped = groupByDay([spontaneous], grid, TODAY, 'log');
  assert.equal(grouped.get('2026-08-17').length, 1);
});

/* --- grouping agrees with the single-day answer in every mode -------------- */

test('groupByDay matches entriesForDay in both calendars', () => {
  const books = [
    patchy(),
    book({
      title: 'Finished one',
      status: 'finished',
      schedule: { start: '2026-08-01', end: '2026-08-10' },
      actual: { startedAt: '2026-08-01', finishedAt: '2026-08-06' },
      sessions: [{ date: '2026-08-01', minutes: 20, pageFrom: 0, pageTo: 50 }],
    }),
    book({ title: 'Unplanned', status: 'backlog', schedule: { start: null, end: null } }),
  ];

  const grid = monthGrid(2026, 7).map((cell) => cell.key);

  for (const mode of ['plan', 'log', 'both']) {
    const grouped = groupByDay(books, grid, TODAY, mode);
    for (const key of grid) {
      assert.deepEqual(
        grouped.get(key).map((entry) => `${entry.book.title}:${entry.state}`),
        entriesForDay(books, key, TODAY, mode).map((entry) => `${entry.book.title}:${entry.state}`),
        `${mode} mismatch on ${key}`
      );
    }
  }
});

test('the day view is unaffected: no mode still means the whole picture', () => {
  const read = patchy();

  assert.equal(dayState(read, '2026-08-16', TODAY), 'reading', 'a day read');
  assert.equal(dayState(read, '2026-08-20', TODAY), 'planned', 'a day still planned');
});

/* --- the kind filter ------------------------------------------------------- */

test('from Everything, clicking a kind selects that kind alone', async () => {
  const { nextVisibleKinds } = await import('../js/views/calendar.js');

  // The reported sequence: comics on, books on — which is everything — then
  // comics again. That last click must mean comics, not "all but comics".
  let selected = nextVisibleKinds(new Set(), 'comic', true);
  assert.deepEqual([...selected], ['comic']);

  selected = nextVisibleKinds(selected, 'book', false);
  assert.deepEqual([...selected].sort(), ['book', 'comic'], 'which is everything available');

  selected = nextVisibleKinds(selected, 'comic', true);
  assert.deepEqual([...selected], ['comic'], 'the second click on comics means comics');
});

test('while filtered, a kind still toggles on and off', async () => {
  const { nextVisibleKinds } = await import('../js/views/calendar.js');

  const one = nextVisibleKinds(new Set(['comic']), 'manga', false);
  assert.deepEqual([...one].sort(), ['comic', 'manga']);

  const off = nextVisibleKinds(one, 'comic', false);
  assert.deepEqual([...off], ['manga']);

  // Turning the last one off is a way back to Everything, not an empty grid.
  assert.deepEqual([...nextVisibleKinds(off, 'manga', false)], []);
});

test('the click never mutates the set it was given', async () => {
  const { nextVisibleKinds } = await import('../js/views/calendar.js');

  const before = new Set(['comic']);
  nextVisibleKinds(before, 'manga', false);
  assert.deepEqual([...before], ['comic']);
});
