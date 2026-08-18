/**
 * CSV parsing, Goodreads mapping, and the sync merge rules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, parseCsvObjects } from '../js/lib/csv.js';
import { parseGoodreadsCsv, rowToBook } from '../js/data/goodreads.js';
import { mergeLibraries, mergeTombstones, libraryRevision } from '../js/data/merge.js';

/* --- CSV ------------------------------------------------------------------ */

test('quoted commas do not split a field', () => {
  const rows = parseCsv('a,"b,c",d');
  assert.deepEqual(rows, [['a', 'b,c', 'd']]);
});

test('escaped quotes survive', () => {
  assert.deepEqual(parseCsv('"She said ""no""",x'), [['She said "no"', 'x']]);
});

test('a newline inside a quoted review does not start a new row', () => {
  const rows = parseCsv('title,review\n"Book","line one\nline two"');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], 'line one\nline two');
});

test('CRLF line endings and a byte-order mark are handled', () => {
  const { headers, rows } = parseCsvObjects('\uFEFFTitle,Author\r\nJekyll and Hyde,Stevenson\r\n');
  assert.deepEqual(headers, ['Title', 'Author']);
  assert.equal(rows[0].Title, 'Jekyll and Hyde');
});

test('a trailing newline does not produce a phantom row', () => {
  const { rows } = parseCsvObjects('Title\nA\nB\n');
  assert.equal(rows.length, 2);
});

/* --- Goodreads ------------------------------------------------------------ */

const GOODREADS = [
  'Book Id,Title,Author,ISBN,ISBN13,My Rating,Number of Pages,Binding,Date Read,Date Added,Bookshelves,Exclusive Shelf,My Review,Read Count',
  '1,The Strange Case of Dr Jekyll and Mr Hyde,Robert Louis Stevenson,"=""0486266885""","=""9780486266886""",5,245,Hardcover,2026/03/09,2026/02/01,"favourites, book-club",read,"Quietly astonishing.",1',
  '2,A Princess of Mars,Edgar Rice Burroughs,"=""""","=""9780486436173""",0,448,Paperback,,2026/01/15,to-read,to-read,,0',
  '3,The War of the Worlds,H. G. Wells,"=""""","=""9780486295060""",4,,Audible Audio,2026/04/02,2026/03/20,,read,"Great listen.",2',
  '4,Currently Going,Some Author,"=""""","=""""",0,300,Kindle Edition,,2026/05/01,,currently-reading,,0',
].join('\n');

test('a Goodreads export maps onto book records', () => {
  const result = parseGoodreadsCsv(GOODREADS);
  assert.ok(result.ok, result.error);
  assert.equal(result.books.length, 4);
  assert.equal(result.source, 'Goodreads');
  assert.deepEqual(result.counts, { finished: 2, planned: 1, reading: 1 });
});

test('the ="..." ISBN wrapper is stripped', () => {
  const { books } = parseGoodreadsCsv(GOODREADS);
  assert.equal(books[0].isbn, '9780486266886');
  assert.equal(books[1].isbn, '9780486436173');
});

test('an empty ISBN column does not become junk', () => {
  const { books } = parseGoodreadsCsv(GOODREADS);
  assert.equal(books[3].isbn, '');
});

test('shelf names become status, and extra shelves become shelves', () => {
  const { books } = parseGoodreadsCsv(GOODREADS);
  assert.equal(books[0].status, 'finished');
  assert.deepEqual(books[0].shelves, ['favourites', 'book-club']);
  assert.equal(books[1].status, 'planned');
  assert.equal(books[3].status, 'reading');
});

test('read dates convert from slashes to day keys', () => {
  const { books } = parseGoodreadsCsv(GOODREADS);
  assert.equal(books[0].actual.finishedAt, '2026-03-09');
  assert.equal(books[1].actual.finishedAt, null, 'an unread book has no finish date');
});

test('a zero rating means unrated, not one star', () => {
  const { books } = parseGoodreadsCsv(GOODREADS);
  assert.equal(books[0].rating, 5);
  assert.equal(books[1].rating, null);
});

test('bindings map to formats', () => {
  const { books } = parseGoodreadsCsv(GOODREADS);
  assert.equal(books[0].format, 'physical');
  assert.equal(books[2].format, 'audio', 'Audible Audio is an audiobook');
  assert.equal(books[3].format, 'ebook', 'Kindle Edition is an ebook');
});

test('a re-read is noted rather than silently lost', () => {
  const { books } = parseGoodreadsCsv(GOODREADS);
  assert.match(books[2].notes, /Read 2 times/);
  assert.equal(books[0].notes, '', 'a single read needs no note');
});

test('imported books arrive unscheduled', () => {
  const { books } = parseGoodreadsCsv(GOODREADS);
  assert.ok(books.every((book) => book.schedule.start === null), 'something landed on the calendar');
});

test('a file that is not a Goodreads export is rejected with a reason', () => {
  const result = parseGoodreadsCsv('name,email\nBob,bob@example.com');
  assert.ok(!result.ok);
  assert.match(result.error, /no Title column/);
});

test('rows without a title are skipped, not imported blank', () => {
  const result = parseGoodreadsCsv('Title,Author\n,Nobody\nReal Book,Someone');
  assert.equal(result.books.length, 1);
  assert.equal(result.skipped, 1);
});

/* --- Merge ---------------------------------------------------------------- */

const rec = (id, updatedAt, extra = {}) => ({ id, updatedAt, createdAt: '2026-01-01', ...extra });

test('the newer copy of a record wins', () => {
  const { state } = mergeLibraries(
    { books: [rec('a', '2026-01-01', { title: 'Old' })], settings: {} },
    { books: [rec('a', '2026-02-01', { title: 'New' })], settings: {} }
  );
  assert.equal(state.books[0].title, 'New');
});

test('a stale device cannot delete records it simply has not seen', () => {
  const { state } = mergeLibraries(
    { books: [rec('a', '2026-01-01'), rec('b', '2026-01-01')], settings: {} },
    { books: [rec('a', '2026-01-01')], settings: {} }
  );
  assert.equal(state.books.length, 2, 'a missing record is not a deletion');
});

test('a tombstone removes a record everywhere', () => {
  const now = new Date().toISOString();
  const { state } = mergeLibraries(
    { books: [rec('a', '2026-01-01')], settings: {} },
    { books: [], settings: {}, deleted: [{ id: 'a', at: now }] }
  );
  assert.equal(state.books.length, 0);
});

test('editing a book after deleting it elsewhere brings it back', () => {
  const deleted = new Date(Date.now() - 60000).toISOString();
  const edited = new Date().toISOString();
  const { state } = mergeLibraries(
    { books: [rec('a', edited)], settings: {} },
    { books: [], settings: {}, deleted: [{ id: 'a', at: deleted }] }
  );
  assert.equal(state.books.length, 1, 'a deliberate edit lost to an older delete');
});

test('tombstones older than the retention window are pruned', () => {
  const ancient = new Date(Date.now() - 200 * 86400000).toISOString();
  const recent = new Date().toISOString();
  const merged = mergeTombstones([{ id: 'old', at: ancient }], [{ id: 'new', at: recent }]);
  assert.deepEqual(merged.map((entry) => entry.id), ['new']);
});

test('the revision only changes when the library does', () => {
  const one = { books: [rec('a', '2026-01-01')], settings: {} };
  const same = { books: [rec('a', '2026-01-01')], settings: {} };
  const different = { books: [rec('a', '2026-02-01')], settings: {} };
  assert.equal(libraryRevision(one), libraryRevision(same));
  assert.notEqual(libraryRevision(one), libraryRevision(different));
});
