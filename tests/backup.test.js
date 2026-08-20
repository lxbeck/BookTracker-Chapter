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
  store.replaceAll([], { readingOrders: [], deleted: [] });
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

/* --- Deleting, and changing your mind later -------------------------------- */

test('a deleted book keeps a copy of itself so it can come back', () => {
  // Undo used to last exactly as long as the toast, which is fine for the
  // deletion you notice immediately and no use for the one you notice on
  // Thursday.
  const { ids } = seed();
  store.removeBook(ids[1]);

  const archived = store.recentlyDeleted();
  assert.equal(archived.length, 1);
  assert.equal(archived[0].book.title, BOOKS[1].title);
});

test('restoring brings back the whole record, not just the title', () => {
  store.replaceAll([], { readingOrders: [], deleted: [] });
  const book = store.addBook({
    title: 'The Time Machine',
    author: 'H. G. Wells',
    shelves: ['to reread'],
    sessions: [{ date: '2026-08-01', minutes: 40, pageFrom: 0, pageTo: 30 }],
  }).book;

  store.removeBook(book.id);
  assert.equal(store.allBooks().length, 0);

  store.restoreDeleted(book.id);
  const back = store.allBooks()[0];

  assert.equal(back.sessions.length, 1);
  assert.deepEqual(back.shelves, ['to reread']);
});

test('the archive is capped but every tombstone survives', () => {
  // Dropping a tombstone to save space would resurrect the book on the next
  // sync, which is the one outcome worse than losing the archive.
  store.replaceAll([], { readingOrders: [], deleted: [] });

  for (let index = 0; index < 45; index += 1) {
    const book = store.addBook({ title: `Book ${index}` }).book;
    store.removeBook(book.id);
  }

  const tombstones = store.getState().deleted;
  assert.equal(tombstones.length, 45);
  assert.equal(tombstones.filter((entry) => entry.book).length, 40);
});

test('forgetting a book keeps the tombstone and drops the copy', () => {
  store.replaceAll([], { readingOrders: [], deleted: [] });
  const book = store.addBook({ title: 'Forgettable' }).book;
  store.removeBook(book.id);

  store.forgetDeleted(book.id);

  assert.equal(store.recentlyDeleted().length, 0);
  assert.ok(store.getState().deleted.some((entry) => entry.id === book.id));
});

test('a restored book is no longer listed as deleted', () => {
  store.replaceAll([], { readingOrders: [], deleted: [] });
  const book = store.addBook({ title: 'Back again' }).book;
  store.removeBook(book.id);
  store.restoreDeleted(book.id);

  assert.equal(store.recentlyDeleted().length, 0);
  assert.ok(!store.getState().deleted.some((entry) => entry.id === book.id));
});

/* --- The reading plan as a calendar ---------------------------------------- */

const { buildIcs, icsEventCount } = await import('../js/data/ics.js');

test('a scheduled book becomes an all-day event', () => {
  const book = store.addBook({
    title: 'The Hobbit', author: 'Tolkien',
    schedule: { start: '2026-08-03', end: '2026-08-10' },
  }).book;

  const ics = buildIcs([book]);

  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260803/);
  // An all-day DTEND is exclusive: using the last day itself silently drops a
  // day off every plan in the calendar.
  assert.match(ics, /DTEND;VALUE=DATE:20260811/);
});

test('commas and semicolons in a title are escaped', () => {
  const book = store.addBook({
    title: 'The Hobbit; or, There and Back Again',
    schedule: { start: '2026-08-03' },
  }).book;

  const ics = buildIcs([book]);
  assert.match(ics, /SUMMARY:The Hobbit\\; or\\, There and Back Again/);
});

test('no line exceeds the 75-octet limit', () => {
  // Strict parsers reject a long line outright, and folding by character
  // count rather than bytes still overruns on an accented title.
  const book = store.addBook({
    title: 'Le Théâtre et son double '.repeat(6),
    schedule: { start: '2026-08-03' },
  }).book;

  for (const line of buildIcs([book]).split('\r\n')) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `too long: ${line.slice(0, 40)}`);
  }
});

test('an unscheduled book is left out rather than dropped on today', () => {
  store.replaceAll([], { readingOrders: [], deleted: [] });
  const planned = store.addBook({ title: 'Planned', schedule: { start: '2026-08-03' } }).book;
  const loose = store.addBook({ title: 'Someday' }).book;

  assert.equal(icsEventCount([planned, loose]), 1);
  assert.ok(!buildIcs([planned, loose]).includes('Someday'));
});

test('every event carries a stable id, so re-importing updates rather than doubles', () => {
  const book = store.addBook({ title: 'Stable', schedule: { start: '2026-08-03' } }).book;
  assert.ok(buildIcs([book]).includes(`UID:${book.id}@chapter`));
});

test('restoring a backup does not re-delete the books it contains', () => {
  // The latent bug: replaceAll left this device's tombstones in place, so a
  // book deleted here and then restored from a backup would be deleted again
  // by the next sync — quietly losing exactly the records you restored.
  const book = store.addBook({ title: 'Deleted then restored' }).book;
  store.removeBook(book.id);
  assert.ok(store.getState().deleted.some((entry) => entry.id === book.id));

  const backup = JSON.stringify({
    format: 'chapter-library',
    books: [{ ...book }],
    readingOrders: [],
    deleted: [],
  });

  importJson(backup, { mode: 'replace' });

  assert.equal(store.allBooks().length, 1);
  assert.ok(
    !store.getState().deleted.some((entry) => entry.id === book.id),
    'a tombstone for a book that is here again would delete it on the next sync'
  );
});

/* --- Status changes that stick --------------------------------------------- */

test('a book can be moved off Reading to any other status', () => {
  // The form used to refresh itself from the store on save, which wrote the
  // stored status back into the select a moment before it was read — so
  // choosing "On hold" saved "Reading" and the change vanished with no error.
  store.replaceAll([], { readingOrders: [], deleted: [] });
  const book = store.addBook({
    title: 'Set down',
    status: 'reading',
    schedule: { start: '2026-08-01', end: '2026-08-10' },
    pageCount: 200,
  }).book;

  for (const status of ['on-hold', 'dnf', 'finished']) {
    assert.ok(store.updateBook(book.id, { status }).ok);
    assert.equal(store.getBook(book.id).status, status);
    store.updateBook(book.id, { status: 'reading' });
  }
});

test('a did-not-finish book keeps its reason', () => {
  store.replaceAll([], { readingOrders: [], deleted: [] });
  const book = store.addBook({ title: 'Abandoned' }).book;

  store.updateBook(book.id, { status: 'dnf', dnfReason: 'Lost the thread at page 200.' });
  assert.equal(store.getBook(book.id).dnfReason, 'Lost the thread at page 200.');

  // Kept if it is picked up again: a book abandoned once and returned to is a
  // more interesting record with the first attempt still in it.
  store.updateBook(book.id, { status: 'reading' });
  assert.equal(store.getBook(book.id).dnfReason, 'Lost the thread at page 200.');
});
