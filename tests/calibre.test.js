/**
 * Calibre catalogue import.
 *
 * The fixture is a real Calibre CSV catalogue in shape — byte-order mark,
 * quoted fields, a comma inside a title, a float series index, a missing ISBN,
 * two authors joined with an ampersand — built from public domain comics so
 * the repository carries no one's actual library.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseCalibreCsv, rowToBook } from '../js/data/calibre.js';

const REAL = readFileSync(new URL('./fixtures/calibre-catalogue.csv', import.meta.url), 'utf8');

test('a Calibre catalogue parses', () => {
  const result = parseCalibreCsv(REAL);
  assert.ok(result.ok, result.error);
  assert.equal(result.books.length, 4);
  assert.equal(result.skipped, 0);
});

test('the byte-order mark does not swallow the title column', () => {
  const { books } = parseCalibreCsv(REAL);
  assert.equal(books[0].title, 'Little Nemo, Volume 1');
  assert.ok(books.every((book) => book.title), 'a title came through empty');
});

test('everything from Calibre is an ebook', () => {
  const { books } = parseCalibreCsv(REAL);
  assert.ok(books.every((book) => book.format === 'ebook'));
});

test('series name and index survive the float', () => {
  const { books } = parseCalibreCsv(REAL);
  const strip = books.find((book) => book.title.startsWith('Krazy Kat, Volume 3'));
  assert.equal(strip.series.name, 'Krazy Kat');
  assert.equal(strip.series.number, 3, '"3.0" should be 3, not 3.0 or NaN');
});

test('ISBNs are read, and a missing one is empty rather than junk', () => {
  const { books, withIsbn } = parseCalibreCsv(REAL);
  assert.equal(books[0].isbn, '9780486400914');
  assert.equal(books.find((book) => book.title === 'Gasoline Alley, Vol. 1').isbn, '');
  assert.equal(withIsbn, 3);
});

test('a title containing a comma is not split into two fields', () => {
  const { books } = parseCalibreCsv(REAL);
  assert.ok(books.some((book) => book.title === 'Gasoline Alley, Vol. 1'), 'comma in title broke parsing');
});

test('cover paths are kept beside the books, not on them', () => {
  const { books, paths, withCovers } = parseCalibreCsv(REAL);
  assert.equal(withCovers, 4);
  assert.match(paths.get(books[0].id), /cover\.jpg$/);
  assert.ok(!('_coverPath' in books[0]), 'the path leaked onto the record');
});

test('imported books land in the backlog, unscheduled and unread', () => {
  const { books } = parseCalibreCsv(REAL);
  for (const book of books) {
    // Backlog, not planned: a catalogue of what you own carries no dates, and
    // burying a real plan under it would make the planned shelf useless.
    assert.equal(book.status, 'backlog');
    assert.equal(book.schedule.start, null);
    assert.equal(book.pageCount, null, 'Calibre carries no page count; none should be invented');
  }
});

test('multiple authors keep the first and record the rest as co-authors', () => {
  const book = rowToBook({ title: 'Co-written', authors: 'Charles Nordhoff & James Norman Hall' });

  assert.equal(book.author, 'Charles Nordhoff', 'one name is shown and sorted by');
  assert.deepEqual(book.coAuthors, ['James Norman Hall']);
});

test('an import never writes in your notes', () => {
  // Co-authors used to be flattened into "Also by ...", which is finding the
  // importer's handwriting in your own margin.
  // Checked on the finished record rather than the raw row, since notes only
  // gets its default once the record is normalised.
  const { books } = parseCalibreCsv('title,authors\n"Co-written","A Writer & B Writer & C Writer"');

  assert.equal(books[0].notes, '');
  assert.deepEqual(books[0].coAuthors, ['B Writer', 'C Writer']);
});

test('an audio format column is detected', () => {
  assert.deepEqual(rowToBook({ title: 'Listened', formats: 'M4B' }).formats, ['audio']);
  assert.deepEqual(rowToBook({ title: 'Read', formats: 'EPUB, MOBI' }).formats, ['ebook']);
});

test('a Calibre record holding both an ebook and an audiobook keeps both', () => {
  // One entry with an EPUB and an M4B beside it is the same book in two
  // forms, not a choice between them.
  assert.deepEqual(
    rowToBook({ title: 'Both', formats: 'EPUB, M4B' }).formats,
    ['ebook', 'audio']
  );
});

test('a file that is not a Calibre catalogue is rejected with a reason', () => {
  const result = parseCalibreCsv('foo,bar\n1,2');
  assert.ok(!result.ok);
  assert.match(result.error, /no title column/);
});

test('comics are recognised from the metadata rather than all filed as books', () => {
  const { books } = parseCalibreCsv(REAL);
  const nemo = books.find((book) => book.title.startsWith('Little Nemo'));
  assert.equal(nemo.category, 'comic', 'a numbered volume should read as a comic');
});
