/**
 * Putting things back.
 *
 * Deleting a book has offered a way back for a while; deleting a reading list,
 * a sitting, or a book's whole log did not, and those are exactly the actions
 * people take quickly. The store side of that is tested here — the toast that
 * calls it is checked in interface.test.js — with particular attention to the
 * tombstone, because a restore that leaves one behind is undone again by the
 * next sync, on every device, silently.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  #entries = new Map();
  getItem(key) { return this.#entries.has(key) ? this.#entries.get(key) : null; }
  setItem(key, value) { this.#entries.set(key, String(value)); }
  removeItem(key) { this.#entries.delete(key); }
  clear() { this.#entries.clear(); }
}

globalThis.localStorage ??= new MemoryStorage();

const store = await import('../js/data/store.js');

beforeEach(() => {
  localStorage.clear();
  store.replaceAll([], { readingOrders: [], deleted: [] });
});

const seedBook = () => store.addBook({ title: 'A Princess of Mars', pageCount: 176 }).book;

/* --- Reading lists --------------------------------------------------------- */

test('a deleted list can be put back exactly as it was', () => {
  const book = seedBook();
  const order = store.createOrder({ name: 'Barsoom, in order', bookIds: [book.id] }).order;

  const removed = store.removeOrder(order.id);
  assert.equal(store.allOrders().length, 0);

  store.restoreOrder(removed.order);

  const back = store.getOrder(order.id);
  assert.ok(back, 'the list should be back under its own id');
  assert.equal(back.name, 'Barsoom, in order');
  assert.deepEqual(back.bookIds, [book.id], 'with its sequence intact');
});

test('restoring a list clears the tombstone that would delete it again', () => {
  const order = store.createOrder({ name: 'Doomed' }).order;
  store.removeOrder(order.id);

  assert.ok(
    store.getState().deleted.some((entry) => entry.id === order.id),
    'a delete should leave a tombstone in the first place'
  );

  store.restoreOrder(order);

  assert.equal(
    store.getState().deleted.some((entry) => entry.id === order.id),
    false,
    'a restored list must not still be marked as deleted'
  );
});

test('restoring a list twice does not duplicate it', () => {
  const order = store.createOrder({ name: 'Once' }).order;
  store.removeOrder(order.id);

  store.restoreOrder(order);
  store.restoreOrder(order);

  assert.equal(store.allOrders().filter((entry) => entry.id === order.id).length, 1);
});

/* --- Sittings -------------------------------------------------------------- */

test('a deleted sitting can be written back from what the caller held', () => {
  const book = seedBook();
  store.addSession(book.id, { date: '2026-08-16', minutes: 40, pageFrom: 0, pageTo: 60 });
  const [session] = store.getBook(book.id).sessions;

  store.removeSession(book.id, session.id);
  assert.equal(store.getBook(book.id).sessions.length, 0);

  // This is what the undo in the toast does: the record it already has in hand.
  store.updateBook(book.id, { sessions: [session] });

  const [back] = store.getBook(book.id).sessions;
  assert.equal(back.id, session.id);
  assert.equal(back.pageTo, 60);
});

test('a whole log can be cleared and put back', () => {
  const book = seedBook();
  store.addSession(book.id, { date: '2026-08-16', minutes: 40, pageFrom: 0, pageTo: 60 });
  store.addSession(book.id, { date: '2026-08-18', minutes: 30, pageFrom: 60, pageTo: 90 });

  const sessions = store.getBook(book.id).sessions;
  store.updateBook(book.id, { sessions: [] });
  assert.equal(store.getBook(book.id).sessions.length, 0);

  store.updateBook(book.id, { sessions });
  assert.equal(store.getBook(book.id).sessions.length, 2);
  assert.equal(store.getBook(book.id).progress.page, 90, 'progress follows the log back');
});

test('progress and dates can be reset and restored', () => {
  const book = seedBook();
  store.updateBook(book.id, {
    actual: { startedAt: '2026-08-01', finishedAt: '2026-08-09' },
    status: 'finished',
  });

  const before = {
    actual: { ...store.getBook(book.id).actual },
    progress: { ...store.getBook(book.id).progress },
    status: store.getBook(book.id).status,
  };

  store.updateBook(book.id, {
    actual: { startedAt: null, finishedAt: null },
    progress: { page: 0, percent: 0 },
    status: 'reading',
  });
  // A book being read has started, so the schema stamps a start date back on —
  // which is exactly why this needs an undo rather than a retype.
  assert.equal(store.getBook(book.id).actual.finishedAt, null, 'the finish stamp goes');
  assert.equal(store.getBook(book.id).progress.page, 0, 'and so does the progress');

  store.updateBook(book.id, before);

  const back = store.getBook(book.id);
  assert.equal(back.status, 'finished');
  assert.equal(back.actual.startedAt, '2026-08-01');
  assert.equal(back.actual.finishedAt, '2026-08-09');
});
