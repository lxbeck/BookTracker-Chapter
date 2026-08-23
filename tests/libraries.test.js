/**
 * More than one library on one device, and where a copy came from.
 *
 * The libraries are the riskier half: they change which key the store writes
 * to, and getting that wrong means writing one collection over another. The
 * tests that matter are the ones about separation — that switching really does
 * swap everything, and that the first library keeps the key it has always had,
 * so an existing reader's books are exactly where they were.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  #entries = new Map();
  getItem(key) { return this.#entries.has(key) ? this.#entries.get(key) : null; }
  setItem(key, value) { this.#entries.set(key, String(value)); }
  removeItem(key) { this.#entries.delete(key); }
  clear() { this.#entries.clear(); }
  get keys() { return [...this.#entries.keys()]; }
}

const storage = new MemoryStorage();
globalThis.localStorage ??= storage;

const store = await import('../js/data/store.js');
const { SOURCES, allSources, configureSourceList, sourceLabel, sourcesPresent } =
  await import('../js/data/sources.js');
const { normalizeBook } = await import('../js/data/schema.js');

beforeEach(() => {
  localStorage.clear();
  store.init();
  store.replaceAll([], { readingOrders: [], deleted: [] });
});

/* --- Separate libraries ---------------------------------------------------- */

test('there is one library to begin with, and it is the one that was always there', () => {
  const { active, libraries } = store.allLibraries();

  assert.equal(active, 'main');
  assert.equal(libraries.length, 1);
  assert.equal(store.isDefaultLibrary(), true);
  assert.equal(store.storageStatus().key, 'chapter.library.v1',
    'the original key, so an existing reader notices nothing');
});

test('a second library is a second library, not a filter', () => {
  store.addBook({ title: 'The Time Machine' });
  const made = store.createLibrary('Work reading');

  store.switchLibrary(made.library.id);
  assert.deepEqual(store.allBooks().map((book) => book.title), [], 'a new library starts empty');

  store.addBook({ title: 'Refactoring' });
  assert.deepEqual(store.allBooks().map((book) => book.title), ['Refactoring']);

  store.switchLibrary('main');
  assert.deepEqual(store.allBooks().map((book) => book.title), ['The Time Machine'],
    'and the first one is untouched');
});

test('each library gets its own key, and the first keeps the original', () => {
  const made = store.createLibrary('Sandbox');
  store.addBook({ title: 'Left in main' });

  store.switchLibrary(made.library.id);
  store.addBook({ title: 'Left in the sandbox' });

  assert.equal(store.storageStatus().key, `chapter.library.v1.${made.library.id}`);
  store.switchLibrary('main');
  assert.equal(store.storageStatus().key, 'chapter.library.v1');
});

test('only the first library syncs, because the server holds one', () => {
  const made = store.createLibrary('Private');

  assert.equal(store.isDefaultLibrary(), true);
  store.switchLibrary(made.library.id);
  assert.equal(store.isDefaultLibrary(), false, 'a second library must not be pushed at the server');
});

test('a library can be renamed, and the first cannot be deleted', () => {
  const made = store.createLibrary('Typo');
  store.renameLibrary(made.library.id, 'Fixed');

  assert.equal(
    store.allLibraries().libraries.find((entry) => entry.id === made.library.id).name,
    'Fixed'
  );

  assert.equal(store.deleteLibrary('main').ok, false, 'there has to be somewhere to land');
  assert.equal(store.deleteLibrary(made.library.id).ok, true);
  assert.equal(store.allLibraries().libraries.length, 1);
});

test('deleting the open library lands you back in the first one', () => {
  store.addBook({ title: 'Home' });
  const made = store.createLibrary('Temporary');
  store.switchLibrary(made.library.id);
  store.addBook({ title: 'Away' });

  store.deleteLibrary(made.library.id);

  assert.equal(store.allLibraries().active, 'main');
  assert.deepEqual(store.allBooks().map((book) => book.title), ['Home']);
});

test('two libraries with the same name still get separate ids', () => {
  const first = store.createLibrary('Shared');
  const second = store.createLibrary('Shared');

  assert.notEqual(first.library.id, second.library.id);
});

/* --- Where a copy came from ------------------------------------------------ */

test('a book remembers where it came from', () => {
  const book = normalizeBook({ title: 'A gift', source: 'gift' });
  assert.equal(book.source, 'gift');
  assert.equal(sourceLabel(book.source), 'Gift');
});

test('not stated is a real answer, and the default one', () => {
  assert.equal(normalizeBook({ title: 'Unknown provenance' }).source, '');
  assert.equal(sourceLabel(''), '');
});

test('a source is not confused with where the cover came from', () => {
  const book = normalizeBook({
    title: 'Both',
    source: 'library',
    cover: { url: 'https://example.com/c.jpg', source: 'openlibrary' },
  });

  assert.equal(book.source, 'library');
  assert.equal(book.cover.source, 'openlibrary');
});

test('invented sources join the built-in ones', () => {
  configureSourceList([{ id: 'reviewCopy', label: 'Review copy' }]);

  assert.equal(sourceLabel('reviewCopy'), 'Review copy');
  assert.ok(allSources().some((source) => source.id === 'purchased'), 'built-ins stay');
  assert.ok(allSources().length > Object.keys(SOURCES).length);

  configureSourceList([]);
  // A record filed under a source this device has not heard of is shown as an
  // unfamiliar name rather than quietly refiled as something it isn't.
  assert.equal(sourceLabel('reviewCopy'), 'Review Copy');
});

test('a source that no longer exists is still counted where it is used', () => {
  configureSourceList([]);
  const books = [
    normalizeBook({ title: 'a', source: 'gift' }),
    normalizeBook({ title: 'b', source: 'gift' }),
    normalizeBook({ title: 'c', source: 'inherited' }),
    normalizeBook({ title: 'd' }),
  ];

  const counts = sourcesPresent(books);
  assert.deepEqual(counts.map((entry) => [entry.id, entry.count]), [['gift', 2], ['inherited', 1]]);
});
