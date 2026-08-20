/**
 * The backlog status, book categories, and category-aware statistics.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBook, STATUSES, CATEGORIES } from '../js/data/schema.js';
import { headline, finishedByCategory } from '../js/logic/stats.js';

const TODAY = '2026-08-11';
const book = (props) => normalizeBook({ title: 'x', ...props }, TODAY);

/* --- backlog -------------------------------------------------------------- */

test('backlog is a real status, distinct from planned', () => {
  assert.ok(STATUSES.backlog);
  assert.notEqual(STATUSES.backlog.label, STATUSES.planned.label);
});

test('a planned book with no dates falls back to the backlog', () => {
  const undated = book({ status: 'planned', schedule: { start: null, end: null } });
  assert.equal(undated.status, 'backlog', 'planned should mean dated');
});

test('scheduling a backlog book promotes it to planned', () => {
  const scheduled = book({ status: 'backlog', schedule: { start: '2026-09-01', end: '2026-09-07' } });
  assert.equal(scheduled.status, 'planned');
});

test('removing the dates from a plan returns it to the backlog', () => {
  const planned = book({ status: 'planned', schedule: { start: '2026-09-01', end: '2026-09-07' } });
  assert.equal(planned.status, 'planned');
  const unplanned = normalizeBook({ ...planned, schedule: { start: null, end: null } }, TODAY);
  assert.equal(unplanned.status, 'backlog');
});

test('a finished book keeps its status without dates', () => {
  const finished = book({ status: 'finished', actual: { finishedAt: '2026-07-01' } });
  assert.equal(finished.status, 'finished', 'the backlog rule must not touch finished books');
});

/* --- categories ----------------------------------------------------------- */

test('a book is a book unless told otherwise', () => {
  assert.equal(book({}).category, 'book');
  assert.equal(book({ category: 'manga' }).category, 'manga');
});

test('a kind this device has not heard of is kept, not reclassified', () => {
  // Kinds are extensible in Settings. A record naming one added on another
  // device arrives here before the setting does, and silently turning it into
  // a book would lose the classification for good.
  assert.equal(book({ category: 'researchPaper' }).category, 'researchPaper');
});

test('a kind id can never carry anything unsafe into a class name', () => {
  assert.equal(book({ category: '<script>' }).category, 'script');
  assert.equal(book({ category: '   ' }).category, 'book');
});

test('category and format are independent', () => {
  const digitalManga = book({ category: 'manga', format: 'ebook' });
  assert.equal(digitalManga.category, 'manga');
  assert.equal(digitalManga.format, 'ebook');
});

/* --- the honest finished count -------------------------------------------- */

const LIBRARY = [
  book({ title: 'The Strange Case of Dr Jekyll and Mr Hyde', status: 'finished', category: 'book', pageCount: 245, actual: { finishedAt: '2026-03-01' } }),
  book({ title: 'The Gods of Mars', status: 'finished', category: 'book', pageCount: 448, actual: { finishedAt: '2026-04-01' } }),
  book({ title: 'The Warlord of Mars', status: 'finished', category: 'book', pageCount: 512, actual: { finishedAt: '2026-05-01' } }),
  book({ title: 'Little Nemo 1', status: 'finished', category: 'comic', pageCount: 130, actual: { finishedAt: '2026-06-01' } }),
  book({ title: 'Little Nemo 2', status: 'finished', category: 'comic', pageCount: 130, actual: { finishedAt: '2026-06-02' } }),
  book({ title: 'Little Nemo 3', status: 'finished', category: 'comic', pageCount: 130, actual: { finishedAt: '2026-06-03' } }),
  book({ title: 'Little Nemo 4', status: 'finished', category: 'comic', pageCount: 130, actual: { finishedAt: '2026-06-04' } }),
  book({ title: 'Hokusai Manga 1', status: 'finished', category: 'manga', pageCount: 220, actual: { finishedAt: '2026-07-01' } }),
  book({ title: 'Unread', status: 'backlog', category: 'book', pageCount: 300 }),
];

test('the finished split matches the reported case: 8 finished, 3 books', () => {
  const stats = headline(LIBRARY, TODAY);
  assert.equal(stats.booksFinished, 8, 'the headline count is unchanged');

  const byCategory = Object.fromEntries(
    stats.byCategory.map((row) => [row.category, row.count])
  );
  assert.deepEqual(byCategory, { comic: 4, book: 3, manga: 1 });
});

test('the split is ordered by count, biggest first', () => {
  const rows = finishedByCategory(LIBRARY);
  assert.equal(rows[0].category, 'comic');
  assert.equal(rows[0].count, 4);
});

test('pages are totalled per kind, not just counts', () => {
  const comics = finishedByCategory(LIBRARY).find((row) => row.category === 'comic');
  assert.equal(comics.pages, 520);
});

test('unfinished books are excluded from the split', () => {
  const total = finishedByCategory(LIBRARY).reduce((sum, row) => sum + row.count, 0);
  assert.equal(total, 8, 'the backlog book must not be counted');
});

test('the split can be narrowed to one year', () => {
  const withOld = [
    ...LIBRARY,
    book({ title: 'Old one', status: 'finished', category: 'book', pageCount: 100, actual: { finishedAt: '2025-01-01' } }),
  ];
  assert.equal(finishedByCategory(withOld).reduce((s, r) => s + r.count, 0), 9);
  assert.equal(finishedByCategory(withOld, { year: 2026 }).reduce((s, r) => s + r.count, 0), 8);
});

test('every category has a plural, so sentences read properly', () => {
  for (const [id, category] of Object.entries(CATEGORIES)) {
    assert.ok(category.label, `${id} has no label`);
    assert.ok(category.plural, `${id} has no plural`);
  }
});

/* --- kind groups (calendar toggles) --------------------------------------- */

test('the calendar groups six categories into three switches', async () => {
  const { KIND_GROUPS, KIND_GROUP_ORDER, kindGroupOf, CATEGORY_ORDER } =
    await import('../js/data/schema.js');

  assert.deepEqual(KIND_GROUP_ORDER, ['books', 'comics', 'manga']);

  // Every category must land in exactly one group, or a book would vanish from
  // the calendar when a filter is on.
  const assigned = KIND_GROUP_ORDER.flatMap((id) => KIND_GROUPS[id].categories);
  assert.equal(new Set(assigned).size, assigned.length, 'a category is in two groups');
  for (const category of CATEGORY_ORDER) {
    assert.ok(assigned.includes(category), `${category} belongs to no group`);
  }
});

test('non-fiction and anthologies read as books, graphic novels as comics', async () => {
  const { kindGroupOf } = await import('../js/data/schema.js');
  assert.equal(kindGroupOf('book'), 'books');
  assert.equal(kindGroupOf('nonfiction'), 'books');
  assert.equal(kindGroupOf('anthology'), 'books');
  assert.equal(kindGroupOf('comic'), 'comics');
  assert.equal(kindGroupOf('graphicNovel'), 'comics');
  assert.equal(kindGroupOf('manga'), 'manga');
});

test('an unknown category falls back to books rather than disappearing', async () => {
  const { kindGroupOf } = await import('../js/data/schema.js');
  assert.equal(kindGroupOf('nonsense'), 'books');
  assert.equal(kindGroupOf(undefined), 'books');
});

/* --- reading with gaps ---------------------------------------------------- */

test('a broken-up read is described as days and gaps, not one long span', async () => {
  const { readingHistory, historySummary } = await import('../js/logic/sessions.js');

  // The reported case: read on 3 July, picked up again on the 18th.
  const patchy = book({
    title: 'Moby-Dick',
    pageCount: 400,
    status: 'reading',
    sessions: [
      { date: '2026-07-03', pageFrom: 0, pageTo: 60 },
      { date: '2026-07-18', pageFrom: 60, pageTo: 120 },
      { date: '2026-07-19', pageFrom: 120, pageTo: 180 },
    ],
  });

  const history = readingHistory(patchy);
  assert.equal(history.days.length, 3, 'three days were read');
  assert.equal(history.span, 17, 'across seventeen calendar days');
  assert.equal(history.gaps.length, 1);
  assert.equal(history.longestGap, 14);

  const summary = historySummary(patchy);
  assert.match(summary, /3 days across 17/);
  assert.match(summary, /longest 14 days/);
});

test('a continuous read says so plainly', async () => {
  const { historySummary } = await import('../js/logic/sessions.js');
  const steady = book({
    pageCount: 300,
    status: 'reading',
    sessions: [
      { date: '2026-07-03', pageFrom: 0, pageTo: 50 },
      { date: '2026-07-04', pageFrom: 50, pageTo: 100 },
    ],
  });
  assert.match(historySummary(steady), /2 consecutive days/);
});

test('a book with no log has no history to describe', async () => {
  const { historySummary } = await import('../js/logic/sessions.js');
  assert.equal(historySummary(book({ pageCount: 300 })), null);
});

test('an unlogged day inside a plan is not claimed as reading', async () => {
  const { dayState } = await import('../js/logic/schedule.js');

  const patchy = book({
    pageCount: 400,
    status: 'reading',
    schedule: { start: '2026-07-01', end: '2026-07-20' },
    actual: { startedAt: '2026-07-03' },
    sessions: [
      { date: '2026-07-03', pageFrom: 0, pageTo: 60 },
      { date: '2026-07-18', pageFrom: 60, pageTo: 120 },
    ],
  });

  assert.equal(dayState(patchy, '2026-07-03', '2026-07-19'), 'reading', 'a logged day is reading');
  assert.equal(dayState(patchy, '2026-07-18', '2026-07-19'), 'reading');
  // The fortnight in between was not reading; saying it was would invent a
  // fortnight of history that never happened.
  assert.equal(dayState(patchy, '2026-07-10', '2026-07-19'), 'planned');
});

/* --- starting mid-book ---------------------------------------------------- */

test('a plan can be rebased onto where you already are', async () => {
  const { startFromHerePreview, startFromHerePatch, paceFor } =
    await import('../js/logic/pacing.js');

  // The reported case: 40% through Moby-Dick before tracking began, so the
  // plan says "page 55 by tonight" while you are on page 150.
  const midway = book({
    title: 'Moby-Dick',
    pageCount: 400,
    status: 'reading',
    schedule: { start: '2026-08-09', end: '2026-08-18' },
    progress: { page: 160 },
  });

  const before = paceFor(midway, '2026-08-11', '2026-08-11');
  assert.ok(before.cumulative < 160, 'the old plan counts from page one');

  const preview = startFromHerePreview(midway, '2026-08-11');
  assert.ok(preview.ok, preview.reason);
  assert.equal(preview.currentPage, 160);
  assert.equal(preview.percent, 40);
  assert.equal(preview.remaining, 240);
  assert.equal(preview.days, 8, '11 to 18 August inclusive');
  assert.equal(preview.perDay, 30);

  const rebased = normalizeBook({ ...midway, ...startFromHerePatch(midway, '2026-08-11') }, '2026-08-11');
  const after = paceFor(rebased, '2026-08-11', '2026-08-11');
  assert.equal(after.cumulative, 190, 'targets now start from page 160');
  assert.equal(after.days, 8);

  // And the rebased targets must still land exactly on the last page.
  let total = 160;
  for (let day = 11; day <= 18; day += 1) {
    total += paceFor(rebased, `2026-08-${day}`, '2026-08-11').todayTarget;
  }
  assert.equal(total, 400);
});

test('a session needs only a position, not a duration', async () => {
  const { normalizeSession, validateSession } = await import('../js/data/schema.js');

  // Often you know you got from 40% to 60% and have no idea how long it took.
  const noMinutes = normalizeSession({ date: '2026-08-11', pageFrom: 160, pageTo: 240 });
  assert.deepEqual(validateSession(noMinutes, book({ pageCount: 400 })), {});
  assert.equal(noMinutes.minutes, null);
});
