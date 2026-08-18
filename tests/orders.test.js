/**
 * Reading orders: sequence operations, series sorting, percent progress, and
 * how orders behave when two devices edit them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOrder, validateOrder, normalizeBook, resolveProgress } from '../js/data/schema.js';
import { mergeLibraries } from '../js/data/merge.js';

/* --- shape ---------------------------------------------------------------- */

test('a list needs a name', () => {
  assert.ok(validateOrder(normalizeOrder({ name: '  ' })).name);
  assert.deepEqual(validateOrder(normalizeOrder({ name: 'Poe tales' })), {});
});

test('a book cannot appear twice in one sequence', () => {
  const order = normalizeOrder({ name: 'Comics', bookIds: ['a', 'b', 'a', 'c', 'b'] });
  assert.deepEqual(order.bookIds, ['a', 'b', 'c']);
});

test('the stated order is preserved exactly', () => {
  const ids = ['chilling', 'terrifying', 'cursed-library', 'prelude'];
  assert.deepEqual(normalizeOrder({ name: 'Poe tales', bookIds: ids }).bookIds, ids);
});

/* --- sequence maths ------------------------------------------------------- */

/** The reordering rule, extracted so it can be checked without a store. */
function moved(ids, id, toIndex) {
  const next = [...ids];
  const from = next.indexOf(id);
  next.splice(from, 1);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, id);
  return next;
}

test('moving a book up and down lands where expected', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moved(ids, 'c', 0), ['c', 'a', 'b', 'd']);
  assert.deepEqual(moved(ids, 'a', 3), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moved(ids, 'b', 2), ['a', 'c', 'b', 'd']);
});

test('moving past the end clamps rather than losing the book', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(moved(ids, 'a', 99), ['b', 'c', 'a']);
  assert.deepEqual(moved(ids, 'c', -5), ['c', 'a', 'b']);
  assert.equal(moved(ids, 'a', 99).length, 3, 'no book may be dropped');
});

/* --- series sort ---------------------------------------------------------- */

const book = (props) => normalizeBook({ title: 'x', ...props }, '2026-08-11');

/** Mirrors the comparator in library.js. */
const bySeries = (a, b) => {
  const an = a.series.name || '';
  const bn = b.series.name || '';
  if (an && !bn) return -1;
  if (!an && bn) return 1;
  return (
    an.localeCompare(bn) ||
    (a.series.number ?? Infinity) - (b.series.number ?? Infinity) ||
    a.title.localeCompare(b.title)
  );
};

test('series sort keeps runs together and in index order', () => {
  const books = [
    book({ title: 'Krazy Kat, Volume 3', series: { name: 'Krazy Kat', number: 3 } }),
    book({ title: 'Standalone' }),
    book({ title: 'Krazy Kat, Volume 1', series: { name: 'Krazy Kat', number: 1 } }),
    book({ title: 'Little Nemo 1', series: { name: 'Little Nemo', number: 1 } }),
    book({ title: 'Krazy Kat, Volume 2', series: { name: 'Krazy Kat', number: 2 } }),
  ];

  const titles = [...books].sort(bySeries).map((b) => b.title);
  assert.deepEqual(titles, ['Krazy Kat, Volume 1', 'Krazy Kat, Volume 2', 'Krazy Kat, Volume 3', 'Little Nemo 1', 'Standalone']);
});

test('standalones sort after every series, not alphabetically among them', () => {
  const books = [
    book({ title: 'Aardvark' }),
    book({ title: 'Little Nemo 1', series: { name: 'Little Nemo', number: 1 } }),
  ];
  assert.deepEqual([...books].sort(bySeries).map((b) => b.title), ['Little Nemo 1', 'Aardvark']);
});

/* --- percent progress ----------------------------------------------------- */

test('a percentage converts to a page and back', () => {
  const novel = book({ pageCount: 440 });
  assert.deepEqual(resolveProgress(novel, { percent: 18 }), { percent: 18, page: 79 });

  const byPage = resolveProgress(novel, { page: 79 });
  assert.equal(byPage.page, 79);
  assert.equal(Math.round(byPage.percent), 18);
});

test('a percentage is clamped to a real range', () => {
  const b = book({ pageCount: 200 });
  assert.equal(resolveProgress(b, { percent: 140 }).percent, 100);
  assert.equal(resolveProgress(b, { percent: -5 }).percent, 0);
  assert.equal(resolveProgress(b, { page: 9999 }).page, 200, 'cannot pass the last page');
});

test('a percentage without a page count yields no invented page', () => {
  const unknown = book({ pageCount: null });
  const progress = resolveProgress(unknown, { percent: 50 });
  assert.equal(progress.percent, 50);
  assert.equal(progress.page, 0, 'a fictional page number would poison every pace figure');
});

/* --- syncing orders ------------------------------------------------------- */

const order = (id, updatedAt, bookIds) => ({
  id, name: 'Poe tales', description: '', bookIds,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt,
});

test('the newer sequence wins whole, rather than interleaving', () => {
  const { state } = mergeLibraries(
    { books: [], settings: {}, readingOrders: [order('ro_1', '2026-08-01', ['a', 'b'])] },
    { books: [], settings: {}, readingOrders: [order('ro_1', '2026-08-05', ['b', 'a', 'c'])] }
  );
  assert.deepEqual(state.readingOrders[0].bookIds, ['b', 'a', 'c']);
});

test('a list made on one device arrives on the other', () => {
  const { state, changed } = mergeLibraries(
    { books: [], settings: {}, readingOrders: [] },
    { books: [], settings: {}, readingOrders: [order('ro_2', '2026-08-05', ['a'])] }
  );
  assert.equal(state.readingOrders.length, 1);
  assert.ok(changed);
});

test('a deleted list is not resurrected by a device that never saw the delete', () => {
  const deletedAt = new Date().toISOString();
  const { state } = mergeLibraries(
    { books: [], settings: {}, readingOrders: [], deleted: [{ id: 'ro_3', at: deletedAt }] },
    { books: [], settings: {}, readingOrders: [order('ro_3', '2026-08-01', ['a'])] }
  );
  assert.equal(state.readingOrders.length, 0);
});
