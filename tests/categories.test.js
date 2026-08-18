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
  assert.equal(book({ category: 'nonsense' }).category, 'book', 'unknown kinds fall back');
  assert.equal(book({ category: 'manga' }).category, 'manga');
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
