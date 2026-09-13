/**
 * A schema bump, or a restored backup, must not fabricate edit history.
 *
 * Sync trusts a book's `updatedAt` completely to decide whose copy of a
 * record is newest (see merge.js). `migrate()` re-normalises every book on
 * whichever device next opens the app after a version bump, whether or not
 * that particular book actually changed — a phone that had not opened Chapter
 * since before a bump used to have every book's timestamp reset to the moment
 * it next launched, making a week-old, pre-migration copy look like the
 * freshest thing in the library. A sync right after let it silently overwrite
 * real reading logged everywhere else since. `applyRemote`'s doc comment in
 * store.js already explains why the live sync path dodges this; migration and
 * backup restore did not, until now.
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

/* --- Schema migration -------------------------------------------------------- */

test('a version bump does not stamp every book as just edited', () => {
  const key = store.storageStatus().key;
  const honestTimestamp = '2026-09-03T14:22:00.000Z';

  // Shaped like a save from before the current schema version, the way a
  // phone that has not opened the app in a while would actually have one.
  localStorage.setItem(key, JSON.stringify({
    version: 1,
    books: [{
      id: 'b1',
      title: 'Project Hail Mary',
      pageCount: 476,
      format: 'physical',
      formats: ['physical'],
      sessions: [{ id: 's1', date: '2026-09-03', minutes: 40, pageTo: 120 }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: honestTimestamp,
    }],
    settings: {},
    deleted: [],
  }));

  store.init();

  const book = store.allBooks().find((b) => b.id === 'b1');
  assert.ok(book, 'the book survives the migration');
  assert.equal(book.updatedAt, honestTimestamp,
    'its real edit time is kept, not reset to the moment it happened to migrate');
  assert.equal(book.sessions.length, 1, 'and the reading logged against it is untouched');
});

test('a book with nothing to preserve still gets a real timestamp', () => {
  const { migrateBook } = store;
  // A record with no prior `updatedAt` at all — nothing honest to keep, so it
  // is stamped like any other new arrival rather than left without one.
  const clean = migrateBook({ id: 'b2', title: 'New Arrival' });
  assert.ok(clean.updatedAt, 'it still gets a timestamp');
});

/* --- Restoring a backup ------------------------------------------------------ */

test('restoring a backup keeps its own history, not the moment you restored it', () => {
  const oldTimestamp = '2025-11-02T09:00:00.000Z';

  store.replaceAll(
    [{
      id: 'b3', title: 'A Memory Called Empire', pageCount: 464,
      createdAt: oldTimestamp, updatedAt: oldTimestamp,
    }],
    { readingOrders: [], deleted: [] }
  );

  const book = store.allBooks().find((b) => b.id === 'b3');
  assert.equal(book.updatedAt, oldTimestamp,
    'a restored book keeps its own history, so it cannot falsely outrank a ' +
    'genuinely newer copy on another device the next time the two sync');
});

test('seed data with no history of its own is still stamped', () => {
  store.replaceAll([{ id: 'b4', title: 'Freshly Seeded', pageCount: 200 }], {});
  const book = store.allBooks().find((b) => b.id === 'b4');
  assert.ok(book.updatedAt, 'sample data still gets a normal, honest timestamp');
});
