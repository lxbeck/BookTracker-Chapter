/**
 * Backups, and the sequences they used to lose.
 *
 * These run against the real store rather than against pure functions, because
 * the bug being tested for lived in the seam: `exportJson` wrote reading orders
 * out correctly and `importJson` read them back only in replace mode, which is
 * the mode nobody uses because it wipes the library first. Testing either half
 * on its own would have kept passing.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The store persists to localStorage, which node does not have.
 *
 * A Map is enough: nothing here tests the browser's quota behaviour, only that
 * a write is followed by a readable value.
 */
class MemoryStorage {
  #entries = new Map();
  getItem(key) { return this.#entries.has(key) ? this.#entries.get(key) : null; }
  setItem(key, value) { this.#entries.set(key, String(value)); }
  removeItem(key) { this.#entries.delete(key); }
  clear() { this.#entries.clear(); }
}

globalThis.localStorage ??= new MemoryStorage();

const store = await import('../js/data/store.js');
const { exportJson, importJson } = await import('../js/data/transfer.js');

const BOOKS = [
  { title: 'The Time Machine', author: 'H. G. Wells', pageCount: 118 },
  { title: 'The Island of Doctor Moreau', author: 'H. G. Wells', pageCount: 160 },
  { title: 'The Invisible Man', author: 'H. G. Wells', pageCount: 192 },
];

/** A library with one sequence in a deliberately non-alphabetical order. */
function seed() {
  store.replaceAll([]);
  const ids = BOOKS.map((book) => store.addBook(book).book.id);
  const order = store.createOrder({ name: 'Wells, in order', bookIds: ids }).order;
  return { ids, order };
}

beforeEach(() => {
  localStorage.clear();
  store.replaceAll([], { readingOrders: [] });
});

/* --- What a backup contains ------------------------------------------------ */

test('a backup carries the reading order lists', () => {
  const { order } = seed();
  const backup = JSON.parse(exportJson());

  assert.equal(backup.readingOrders.length, 1);
  assert.deepEqual(backup.readingOrders[0].bookIds, order.bookIds);
});

test('a backup carries the record of what was deleted', () => {
  // Without tombstones a restore resurrects everything ever thrown away.
  const { ids } = seed();
  store.removeBook(ids[1]);

  const backup = JSON.parse(exportJson());
  assert.ok(backup.deleted.some((entry) => entry.id === ids[1]));
});

test('a backup says how much is in it', () => {
  seed();
  const backup = JSON.parse(exportJson());

  assert.equal(backup.counts.books, 3);
  assert.equal(backup.counts.readingOrders, 1);
});

/* --- Restoring ------------------------------------------------------------- */

test('a merge import restores reading orders, not just books', () => {
  const { order } = seed();
  const backup = exportJson();

  // A fresh device: the books and the lists both have to come back.
  store.replaceAll([], { readingOrders: [] });
  const result = importJson(backup, { mode: 'merge' });

  assert.equal(result.added, 3);
  assert.equal(result.orders, 1);
  assert.equal(store.allOrders().length, 1);
  assert.deepEqual(store.allOrders()[0].bookIds, order.bookIds);
});

test('re-importing the same backup does not duplicate a list', () => {
  seed();
  const backup = exportJson();

  importJson(backup, { mode: 'merge' });
  importJson(backup, { mode: 'merge' });

  assert.equal(store.allOrders().length, 1);
  assert.equal(store.allBooks().length, 3);
});

test('a sequence follows books that were matched by title rather than by id', () => {
  const { order } = seed();
  const backup = exportJson();

  // The same books, catalogued separately on another device, so every id
  // differs. A sequence still naming the old ids would be a list of nothing.
  store.replaceAll([], { readingOrders: [] });
  const localIds = BOOKS.map((book) => store.addBook(book).book.id);

  importJson(backup, { mode: 'merge' });

  const restored = store.allOrders()[0];
  assert.deepEqual(restored.bookIds, localIds);
  assert.notDeepEqual(restored.bookIds, order.bookIds);
  assert.ok(restored.bookIds.every((id) => store.getBook(id)), 'every entry is a real book');
});

test('a list that exists here already gains the imported sequence and keeps its extras', () => {
  const { ids } = seed();
  const backup = exportJson();

  // Same list name, one extra book added since the backup was taken.
  store.replaceAll([], { readingOrders: [] });
  const localIds = BOOKS.map((book) => store.addBook(book).book.id);
  const extra = store.addBook({ title: 'The War of the Worlds', author: 'H. G. Wells' }).book.id;
  store.createOrder({ name: 'Wells, in order', bookIds: [extra] });

  importJson(backup, { mode: 'merge' });

  const merged = store.allOrders()[0];
  assert.equal(store.allOrders().length, 1, 'matched by name rather than duplicated');
  assert.deepEqual(merged.bookIds.slice(0, 3), localIds);
  assert.ok(merged.bookIds.includes(extra), 'work done since the backup is not thrown away');
  assert.ok(ids.every((id) => !merged.bookIds.includes(id)));
});

test('a sequence naming books that are not here drops the dead entries', () => {
  const { order } = seed();
  const backup = JSON.parse(exportJson());
  backup.readingOrders[0].bookIds = [...order.bookIds, 'bk-never-existed'];

  store.replaceAll([], { readingOrders: [] });
  importJson(JSON.stringify(backup), { mode: 'merge' });

  assert.ok(!store.allOrders()[0].bookIds.includes('bk-never-existed'));
});

/* --- Reordering ------------------------------------------------------------ */

test('a book can be moved to either end of a long list in one action', () => {
  const { ids, order } = seed();

  store.moveInOrder(order.id, ids[2], 0);
  assert.deepEqual(store.getOrder(order.id).bookIds, [ids[2], ids[0], ids[1]]);

  store.moveInOrder(order.id, ids[2], 99);
  assert.deepEqual(store.getOrder(order.id).bookIds, [ids[0], ids[1], ids[2]]);
});

test('a sequence can be put back exactly as it was', () => {
  const { ids, order } = seed();
  const before = [...store.getOrder(order.id).bookIds];

  store.moveInOrder(order.id, ids[0], 2);
  assert.notDeepEqual(store.getOrder(order.id).bookIds, before);

  store.setOrderSequence(order.id, before);
  assert.deepEqual(store.getOrder(order.id).bookIds, before);
});

test('putting a sequence back cannot resurrect a book removed since', () => {
  const { ids, order } = seed();
  const before = [...store.getOrder(order.id).bookIds];

  store.removeFromOrder(order.id, ids[1]);
  store.setOrderSequence(order.id, before);

  assert.ok(!store.getOrder(order.id).bookIds.includes(ids[1]));
  assert.equal(store.getOrder(order.id).bookIds.length, 2);
});

test('putting a sequence back keeps a book added since', () => {
  const { order } = seed();
  const before = [...store.getOrder(order.id).bookIds];

  const late = store.addBook({ title: 'The Sleeper Awakes', author: 'H. G. Wells' }).book.id;
  store.addToOrder(order.id, [late]);
  store.setOrderSequence(order.id, before);

  assert.ok(store.getOrder(order.id).bookIds.includes(late));
});

/* --- The order of the lists themselves ------------------------------------- */

test('a new list goes after the ones already there', () => {
  store.createOrder({ name: 'First' });
  store.createOrder({ name: 'Second' });
  store.createOrder({ name: 'Third' });

  assert.deepEqual(store.allOrders().map((order) => order.name), ['First', 'Second', 'Third']);
});

test('a list can be moved among the others', () => {
  store.createOrder({ name: 'First' });
  store.createOrder({ name: 'Second' });
  const third = store.createOrder({ name: 'Third' }).order;

  store.moveOrder(third.id, -1);
  assert.deepEqual(store.allOrders().map((order) => order.name), ['First', 'Third', 'Second']);

  store.moveOrder(third.id, -1);
  assert.deepEqual(store.allOrders().map((order) => order.name), ['Third', 'First', 'Second']);
});

test('moving a list past either end holds it there rather than wrapping', () => {
  const first = store.createOrder({ name: 'First' }).order;
  store.createOrder({ name: 'Second' });

  assert.equal(store.moveOrder(first.id, -1).moved, false);
  assert.deepEqual(store.allOrders().map((order) => order.name), ['First', 'Second']);

  store.moveOrder(first.id, 5);
  assert.deepEqual(store.allOrders().map((order) => order.name), ['Second', 'First']);
});

test('the order of the lists survives a backup', () => {
  store.createOrder({ name: 'First' });
  const second = store.createOrder({ name: 'Second' }).order;
  store.moveOrder(second.id, -1);

  const backup = exportJson();
  store.replaceAll([], { readingOrders: [] });
  importJson(backup, { mode: 'merge' });

  assert.deepEqual(store.allOrders().map((order) => order.name), ['Second', 'First']);
});
