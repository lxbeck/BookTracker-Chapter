/**
 * Export and import round-tripping, and the statistics derived from a library.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBook } from '../js/data/schema.js';
import { headline, goalProgress, finishedByMonth, breakdown, cumulativePages } from '../js/logic/stats.js';

const TODAY = '2026-06-15';

const book = (props) => normalizeBook(props, TODAY);

const LIBRARY = [
  book({
    title: 'The Strange Case of Dr Jekyll and Mr Hyde', author: 'Robert Louis Stevenson', genre: 'Gothic',
    pageCount: 245, status: 'finished', shelves: ['2026 goal'],
    actual: { startedAt: '2026-05-01', finishedAt: '2026-05-09' },
    sessions: [
      { date: '2026-05-01', minutes: 60, pageFrom: 0, pageTo: 100 },
      { date: '2026-05-09', minutes: 90, pageFrom: 100, pageTo: 245 },
    ],
  }),
  book({
    title: 'A Princess of Mars', author: 'Edgar Rice Burroughs', genre: 'Adventure',
    pageCount: 448, status: 'finished', shelves: ['2026 goal', 'series reads'],
    actual: { startedAt: '2026-06-01', finishedAt: '2026-06-11' },
    sessions: [{ date: '2026-06-10', minutes: 120, pageFrom: 0, pageTo: 448 }],
  }),
  book({
    title: 'The Gods of Mars', author: 'Edgar Rice Burroughs', genre: 'Adventure',
    pageCount: 512, status: 'reading', shelves: ['series reads'],
    schedule: { start: '2026-06-12', end: '2026-06-30' },
  }),
];

test('headline figures count finished books and logged reading separately', () => {
  const stats = headline(LIBRARY, TODAY);
  assert.equal(stats.booksFinished, 2);
  assert.equal(stats.pagesFinished, 693);
  assert.equal(stats.minutes, 270);
  assert.equal(stats.daysRead, 3);
  assert.equal(stats.pagesLogged, 693);
  // Pace is per day *read*, not per calendar day.
  assert.equal(Math.round(stats.pagesPerReadingDay), 231);
});

test('average days per book uses the real start and finish dates', () => {
  const stats = headline(LIBRARY, TODAY);
  // Jekyll and Hyde took 9 days, The Gods of Mars 11.
  assert.equal(stats.averageDaysPerBook, 10);
});

test('breakdowns rank by count and handle multi-valued fields', () => {
  const byAuthor = breakdown(LIBRARY, (b) => b.author);
  assert.equal(byAuthor[0].label, 'Edgar Rice Burroughs');
  assert.equal(byAuthor[0].value, 2);

  const byShelf = breakdown(LIBRARY, (b) => b.shelves);
  assert.equal(byShelf.find((row) => row.label === '2026 goal').value, 2);
  assert.equal(byShelf.find((row) => row.label === 'series reads').value, 2);
});

test('a breakdown counts how many of each row are finished', () => {
  // "You own 40 comics" and "you have read 6 of them" are different facts,
  // and the bars are only interesting because of the second.
  const byAuthor = breakdown(LIBRARY, (b) => b.author);
  for (const row of byAuthor) {
    assert.ok(row.done <= row.value, 'finished can never exceed the total');
  }

  const finished = LIBRARY.filter((b) => b.status === 'finished').length;
  assert.equal(
    byAuthor.reduce((sum, row) => sum + row.done, 0),
    finished
  );
});

test('books finished by month lands them in the right buckets', () => {
  const months = finishedByMonth(LIBRARY, 12, TODAY);
  assert.equal(months.length, 12);
  assert.equal(months.at(-1).value, 1, 'June');
  assert.equal(months.at(-2).value, 1, 'May');
  assert.equal(months.reduce((sum, m) => sum + m.value, 0), 2);
});

test('cumulative pages only ever climb', () => {
  const series = cumulativePages(LIBRARY, 60, TODAY);
  assert.equal(series.length, 60);
  for (let i = 1; i < series.length; i += 1) {
    assert.ok(series[i].value >= series[i - 1].value, 'cumulative went backwards');
  }
  assert.equal(series.at(-1).value, 693);
});

test('goal progress reports pace, not just a count', () => {
  const goal = goalProgress(LIBRARY, { type: 'books', target: 24 }, TODAY);
  assert.equal(goal.done, 2);
  assert.equal(goal.percent, 8);
  // Mid-June is about 45% through the year, so 24 books expects ~11 by now.
  assert.equal(goal.expected, 11);
  assert.ok(!goal.onTrack);
  assert.equal(goal.delta, -9);
  assert.ok(goal.perWeekNeeded > 0);
});

test('a pages goal counts pages of finished books', () => {
  const goal = goalProgress(LIBRARY, { type: 'pages', target: 12000 }, TODAY);
  assert.equal(goal.done, 693);
});

test('no goal set reports nothing rather than zero', () => {
  assert.equal(goalProgress(LIBRARY, null, TODAY), null);
  assert.equal(goalProgress(LIBRARY, { type: 'books', target: 0 }, TODAY), null);
});
