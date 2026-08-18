/**
 * Calendar tests: which books land on which day in which state, and what a
 * given day asks of the reader.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBook } from '../js/data/schema.js';
import { dayState, entriesForDay, groupByDay } from '../js/logic/schedule.js';
import { paceFor, paceHeadline, paceStanding, projectedFinish } from '../js/logic/pacing.js';
import { monthGrid } from '../js/lib/dates.js';

const TODAY = '2026-03-10';

/** Build a book without letting normalize's status rules stamp a real clock. */
const book = (props) => normalizeBook(props, TODAY);

/* --- day states ----------------------------------------------------------- */

test('a planned book shows across its whole scheduled span', () => {
  const planned = book({
    title: 'The Gods of Mars',
    status: 'planned',
    schedule: { start: '2026-03-08', end: '2026-03-14' },
  });

  assert.equal(dayState(planned, '2026-03-07', TODAY), null);
  assert.equal(dayState(planned, '2026-03-08', TODAY), 'planned');
  assert.equal(dayState(planned, '2026-03-11', TODAY), 'planned');
  assert.equal(dayState(planned, '2026-03-14', TODAY), 'planned');
  assert.equal(dayState(planned, '2026-03-15', TODAY), null);
});

test('a book in progress reads as reading up to today and planned after', () => {
  const reading = book({
    title: 'A Princess of Mars',
    status: 'reading',
    schedule: { start: '2026-03-08', end: '2026-03-14' },
    actual: { startedAt: '2026-03-08' },
  });

  assert.equal(dayState(reading, '2026-03-09', TODAY), 'reading');
  assert.equal(dayState(reading, TODAY, TODAY), 'reading');
  assert.equal(dayState(reading, '2026-03-12', TODAY), 'planned', 'the future is still a plan');
});

test('the finish day wins over the plan that also covers it', () => {
  const finished = book({
    title: 'The Strange Case of Dr Jekyll and Mr Hyde',
    status: 'finished',
    schedule: { start: '2026-03-01', end: '2026-03-14' },
    actual: { startedAt: '2026-03-01', finishedAt: '2026-03-09' },
  });

  assert.equal(dayState(finished, '2026-03-09', TODAY), 'finished');
  assert.equal(dayState(finished, '2026-03-05', TODAY), 'reading', 'history stays visible');
  assert.equal(
    dayState(finished, '2026-03-12', TODAY),
    null,
    'a finished book stops occupying the rest of its plan'
  );
});

test('paused and abandoned books leave the calendar', () => {
  const held = book({
    title: 'The Turn of the Screw',
    status: 'on-hold',
    schedule: { start: null, end: null },
  });
  assert.equal(dayState(held, TODAY, TODAY), null);
});

/* --- grouping ------------------------------------------------------------- */

test('entries on a day are ordered reading, planned, finished', () => {
  const books = [
    book({ title: 'Planned one', status: 'planned', schedule: { start: TODAY, end: TODAY } }),
    book({
      title: 'Finished one',
      status: 'finished',
      actual: { startedAt: TODAY, finishedAt: TODAY },
    }),
    book({
      title: 'Reading one',
      status: 'reading',
      schedule: { start: '2026-03-08', end: '2026-03-20' },
      actual: { startedAt: '2026-03-08' },
    }),
  ];

  const states = entriesForDay(books, TODAY, TODAY).map((entry) => entry.state);
  assert.deepEqual(states, ['reading', 'planned', 'finished']);
});

test('groupByDay agrees with entriesForDay across a whole month grid', () => {
  const books = [
    book({ title: 'A', status: 'planned', schedule: { start: '2026-03-02', end: '2026-03-06' } }),
    book({
      title: 'B',
      status: 'reading',
      schedule: { start: '2026-02-25', end: '2026-03-12' },
      actual: { startedAt: '2026-02-25' },
    }),
    book({ title: 'C', status: 'planned', schedule: { start: '2026-04-04', end: '2026-04-08' } }),
    book({ title: 'D', status: 'planned', schedule: { start: null, end: null } }),
  ];

  const grid = monthGrid(2026, 2).map((cell) => cell.key);
  const grouped = groupByDay(books, grid, TODAY);

  for (const key of grid) {
    const direct = entriesForDay(books, key, TODAY).map((entry) => entry.book.title);
    const bucketed = grouped.get(key).map((entry) => entry.book.title);
    assert.deepEqual(bucketed, direct, `mismatch on ${key}`);
  }
});

test('groupByDay clips spans that overhang the visible grid', () => {
  const long = book({
    title: 'Long haul',
    status: 'planned',
    schedule: { start: '2025-01-01', end: '2027-01-01' },
  });
  const grid = monthGrid(2026, 2).map((cell) => cell.key);
  const grouped = groupByDay([long], grid, TODAY);
  assert.equal([...grouped.values()].every((entries) => entries.length === 1), true);
});

/* --- pacing --------------------------------------------------------------- */

test('700 pages across a Sunday-to-Saturday week is 100 a day', () => {
  const weekly = book({
    title: 'Les Miserables',
    pageCount: 700,
    status: 'planned',
    schedule: { start: '2026-03-01', end: '2026-03-07' },
  });

  const pace = paceFor(weekly, '2026-03-01', '2026-03-01');
  assert.equal(pace.days, 7);
  assert.equal(pace.todayTarget, 100);
  assert.equal(pace.cumulative, 100);
  assert.equal(paceHeadline(weekly, '2026-03-04', '2026-03-01'), '100 pages to read today');
});

test('daily targets always sum to the exact page count, without drift', () => {
  // 448 over 11 days is 40.72 a day; a flat rounded rate would overshoot.
  const awkward = book({
    title: 'A Princess of Mars',
    pageCount: 448,
    status: 'planned',
    schedule: { start: '2026-03-01', end: '2026-03-11' },
  });

  let sum = 0;
  for (let i = 0; i < 11; i += 1) {
    const day = `2026-03-${String(i + 1).padStart(2, '0')}`;
    sum += paceFor(awkward, day, '2026-03-01').todayTarget;
  }
  assert.equal(sum, 448);
});

test('an audiobook reports minutes, not pages', () => {
  const audio = book({
    title: 'The War of the Worlds',
    format: 'audio',
    pageCount: 990,
    status: 'planned',
    schedule: { start: '2026-03-01', end: '2026-03-10' },
  });
  assert.match(paceHeadline(audio, '2026-03-02', '2026-03-01'), /minutes to read today/);
});

test('a book with no length says so instead of inventing a target', () => {
  const vague = book({
    title: 'Unknown length',
    status: 'planned',
    schedule: { start: '2026-03-01', end: '2026-03-07' },
  });
  assert.match(paceHeadline(vague, '2026-03-02', '2026-03-01'), /No length recorded/);
});

test('standing reports behind, ahead, and past due', () => {
  const base = {
    title: 'A Princess of Mars',
    pageCount: 448,
    status: 'reading',
    schedule: { start: '2026-03-01', end: '2026-03-11' },
    actual: { startedAt: '2026-03-01' },
  };

  const behind = paceStanding(book({ ...base, progress: { page: 100 } }), '2026-03-08');
  assert.equal(behind.tone, 'behind');

  const ahead = paceStanding(book({ ...base, progress: { page: 400 } }), '2026-03-08');
  assert.equal(ahead.tone, 'ahead');

  const late = paceStanding(book({ ...base, progress: { page: 300 } }), '2026-03-20');
  assert.equal(late.tone, 'overdue');
  assert.match(late.text, /148 pages left/);
});

test('projected finish follows the pace actually being read', () => {
  const slow = book({
    title: 'Slow going',
    pageCount: 400,
    status: 'reading',
    schedule: { start: '2026-03-01', end: '2026-03-08' },
    actual: { startedAt: '2026-03-01' },
    progress: { page: 100 },
  });
  // 100 pages in 10 days is 10 a day; 300 left means 30 more days.
  assert.equal(projectedFinish(slow, '2026-03-10'), '2026-04-09');
});

/* --- derived progress (step 6) -------------------------------------------- */

test('projected finish uses the logged pace, not the planned one', async () => {
  const { progressReport } = await import('../js/logic/pacing.js');
  const { normalizeBook } = await import('../js/data/schema.js');

  const slow = normalizeBook(
    {
      title: 'Slow going',
      pageCount: 400,
      status: 'reading',
      schedule: { start: '2026-03-01', end: '2026-03-08' },
      sessions: [
        { date: '2026-03-01', minutes: 60, pageFrom: 0, pageTo: 50 },
        { date: '2026-03-06', minutes: 60, pageFrom: 50, pageTo: 100 },
      ],
    },
    '2026-03-10'
  );

  const report = progressReport(slow, '2026-03-10');
  assert.equal(report.done, 100, 'progress follows the furthest logged page');
  assert.equal(report.percent, 25);
  assert.equal(report.rate, 10, '100 pages over 10 elapsed days');
  // 300 pages left at 10 a day is 30 more days.
  assert.equal(report.projected, '2026-04-09');
  assert.equal(report.verdict.tone, 'late');
  assert.match(report.verdict.text, /32 days past the plan/);
});

test('time left is derived from minutes actually spent per page', () => {
  return import('../js/logic/pacing.js').then(async ({ progressReport }) => {
    const { normalizeBook } = await import('../js/data/schema.js');
    const book = normalizeBook(
      {
        title: 'Timed',
        pageCount: 300,
        status: 'reading',
        schedule: { start: '2026-03-01', end: '2026-03-20' },
        sessions: [{ date: '2026-03-01', minutes: 120, pageFrom: 0, pageTo: 100 }],
      },
      '2026-03-05'
    );
    const report = progressReport(book, '2026-03-05');
    // 120 minutes for 100 pages is 1.2 a page; 200 left is 240 minutes.
    assert.equal(report.timeLeft, '4h');
  });
});

test('a book finishing on schedule reads as landing on plan', async () => {
  const { progressReport } = await import('../js/logic/pacing.js');
  const { normalizeBook } = await import('../js/data/schema.js');

  const steady = normalizeBook(
    {
      title: 'Steady',
      pageCount: 100,
      status: 'reading',
      schedule: { start: '2026-03-01', end: '2026-03-10' },
      sessions: [{ date: '2026-03-01', minutes: 60, pageFrom: 0, pageTo: 50 }],
    },
    '2026-03-05'
  );

  const report = progressReport(steady, '2026-03-05');
  // 50 pages in 5 elapsed days is 10 a day; 50 left is 5 more days -> Mar 10.
  assert.equal(report.projected, '2026-03-10');
  assert.equal(report.verdict.tone, 'on-time');
});

test('a book with no length reports no derived pace rather than guessing', async () => {
  const { progressReport } = await import('../js/logic/pacing.js');
  const { normalizeBook } = await import('../js/data/schema.js');
  const vague = normalizeBook({ title: 'No length', status: 'reading' }, '2026-03-05');
  assert.equal(progressReport(vague, '2026-03-05').ok, false);
});

/* --- tile row packing (step 4.7) ------------------------------------------ */

test('tiles are packed into the rows the layout calls for', async () => {
  const { rowPlan } = await import('../js/views/calendar.js');
  assert.deepEqual(rowPlan(0), []);
  assert.deepEqual(rowPlan(1), [1], 'one cover fills the day');
  assert.deepEqual(rowPlan(2), [2]);
  assert.deepEqual(rowPlan(3), [3], 'three span the day, no gap for a fourth');
  assert.deepEqual(rowPlan(4), [2, 2]);
  assert.deepEqual(rowPlan(5), [3, 2], 'the short row centres itself');
  assert.deepEqual(rowPlan(6), [3, 3]);
});

test('every row plan accounts for exactly the tiles given', async () => {
  const { rowPlan } = await import('../js/views/calendar.js');
  for (let n = 0; n <= 6; n += 1) {
    assert.equal(rowPlan(n).reduce((a, b) => a + b, 0), n, `plan for ${n} loses a tile`);
    assert.ok(rowPlan(n).length <= 2, `plan for ${n} needs more than two rows`);
  }
});
