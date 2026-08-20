/**
 * Re-importing a catalogue you have already imported.
 *
 * The case that matters: books are in the library, the catalogue has since
 * gained descriptions, and importing again should deliver them without
 * disturbing anything entered by hand. The old behaviour skipped a book it
 * recognised, which meant the second import did nothing at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { normalizeBook } from '../js/data/schema.js';
import { parseCalibreCsv } from '../js/data/calibre.js';
import { fillMissing, matchExisting, isEmpty } from '../js/data/fill.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const book = (props) => normalizeBook({ title: 'A Book', ...props }, '2026-08-19');

/* --- Custom columns -------------------------------------------------------- */

test('a description comes from the comments field', () => {
  // Calibre's own field, and what the Comments box in its editor writes to.
  const { books } = parseCalibreCsv(
    'title,comments\n"Little Nemo, Volume 1","Collects the Sunday pages."'
  );
  assert.equal(books[0].description, 'Collects the Sunday pages.');
});

test('comments wins when a catalogue carries more than one blurb column', () => {
  // Reading whichever column the export listed first is not a rule anyone
  // could predict from looking at their library.
  const { books } = parseCalibreCsv(
    'title,description,comments\n"Alex + Ada Vol. 1","The other one.","The comments field."'
  );
  assert.equal(books[0].description, 'The comments field.');
});

test('a catalogue with no comments column still finds a blurb elsewhere', () => {
  const { books } = parseCalibreCsv(
    'title,synopsis\n"Alex + Ada Vol. 1","Kept somewhere else."'
  );
  assert.equal(books[0].description, 'Kept somewhere else.');
});

test('column names are matched whatever case and spacing they arrive in', () => {
  const { books } = parseCalibreCsv(
    'Title,Series,Series Index,Genre\n"Dune","Dune","4.5","Science Fiction"'
  );
  assert.equal(books[0].title, 'Dune');
  assert.equal(books[0].series.number, 4.5);
  assert.equal(books[0].genre, 'Science Fiction');
});

test('a volume number with no series attached is not invented', () => {
  // Calibre writes an index of 1.0 for every book whether or not it is in a
  // series. A library of standalones all claiming to be volume one is worse
  // than one claiming nothing.
  const { books } = parseCalibreCsv('title,series,series_index\n"A Standalone","","1.0"');
  assert.equal(books[0].series.number, null);
});

test('a byte-order mark does not hide the title column', () => {
  // Excel and Calibre both write one, and it used to turn `title` into a
  // header that matched nothing, failing the whole file.
  const parsed = parseCalibreCsv('\uFEFFtitle,authors\n"Dune","Frank Herbert"');
  assert.ok(parsed.ok);
  assert.equal(parsed.books[0].title, 'Dune');
});

/* --- Fractional series numbers --------------------------------------------- */

test('a half-numbered volume keeps its half', () => {
  // A side story published between books four and five is genuinely #4.5.
  // Rounding it to 4 or 5 files it under a volume that already exists.
  const { books } = parseCalibreCsv('title,series,series_index\n"Interlude","Vorkosigan","4.5"');
  assert.equal(books[0].series.number, 4.5);
});

test('Calibre writing 5.0 still means five', () => {
  const { books } = parseCalibreCsv('title,series,series_index\n"Vol. 5","A Run","5.0"');
  assert.equal(books[0].series.number, 5);
});

test('a series number typed by hand may be fractional too', () => {
  assert.equal(book({ series: { number: '2.5' } }).series.number, 2.5);
  assert.equal(book({ series: { number: 0.5 } }).series.number, 0.5);
  // Prequels are #0, not #-1.
  assert.equal(book({ series: { number: -3 } }).series.number, null);
  assert.equal(book({ series: { number: '' } }).series.number, null);
  assert.equal(book({ series: { number: 'four' } }).series.number, null);
});

test('a series number is kept to two decimals, not to floating-point noise', () => {
  assert.equal(book({ series: { number: 4.5678 } }).series.number, 4.57);
});

test('how many books are in a series is still a whole number', () => {
  // You can have a volume 4.5; you cannot own 4.5 volumes in total.
  assert.equal(book({ series: { total: '7.6' } }).series.total, 7);
});

test('fractional volumes sort between their neighbours', () => {
  const volumes = [3, 4, 4.5, 5].map((number) => book({ series: { name: 'S', number } }));
  const sorted = [...volumes].sort((a, b) => a.series.number - b.series.number);
  assert.deepEqual(sorted.map((entry) => entry.series.number), [3, 4, 4.5, 5]);
});

/* --- Matching a book already here ------------------------------------------ */

const LIBRARY = [
  book({ title: 'Little Nemo, Volume 1', author: 'Winsor McCay' }),
  book({ title: 'Krazy Kat, Volume 3', author: 'George Herriman', isbn: '9780486236216' }),
  book({ title: 'Untitled Sketchbook', author: '' }),
];

test('a book is matched on title and author', () => {
  const match = matchExisting(LIBRARY, {
    title: 'little nemo, volume 1', author: 'WINSOR MCCAY',
  });
  assert.equal(match?.author, 'Winsor McCay');
});

test('a book is matched on ISBN even when the title was edited', () => {
  const match = matchExisting(LIBRARY, {
    title: 'Krazy Kat, Volume 3 (Dover reprint)', author: 'Herriman, George',
    isbn: '9780486236216',
  });
  assert.equal(match?.title, 'Krazy Kat, Volume 3');
});

test('a collaboration credited in a different order still matches', () => {
  // A catalogue crediting an inker first and the record here crediting the
  // artist would file the same book twice if only the first name were read.
  const match = matchExisting(LIBRARY, {
    title: 'Little Nemo, Volume 1',
    author: 'Traced Uncredited',
    authors: ['Traced Uncredited', 'Winsor McCay'],
  });
  assert.equal(match?.author, 'Winsor McCay');
});

test('a title alone matches only when one side has no author at all', () => {
  assert.ok(matchExisting(LIBRARY, { title: 'Untitled Sketchbook', author: 'Someone' }));
  // Two different books can share a title; a bare title is not enough to
  // merge them when both name an author.
  assert.equal(matchExisting(LIBRARY, { title: 'Krazy Kat, Volume 3', author: 'Someone Else' }), null);
});

test('a book that is not here is not matched', () => {
  assert.equal(matchExisting(LIBRARY, { title: 'Something Else', author: 'Nobody' }), null);
});

/* --- Filling only what is missing ------------------------------------------ */

const existing = book({
  title: 'Little Nemo, Volume 2',
  author: 'Winsor McCay',
  pageCount: 144,
  description: 'My own note about this one.',
  status: 'reading',
  shelves: ['to reread'],
  schedule: { start: '2026-09-01', end: '2026-09-07' },
});

const incoming = {
  title: 'Little Nemo, Volume 2',
  author: 'Winsor McCay',
  pageCount: 999,
  description: "The publisher's blurb.",
  genre: 'Comics',
  isbn: '9780486400914',
  series: { name: 'Little Nemo', number: 2, total: null },
  shelves: ['comics', 'to reread'],
  status: 'backlog',
};

test('empty fields are filled', () => {
  const { patch, filled } = fillMissing(existing, incoming);

  assert.equal(patch.genre, 'Comics');
  assert.equal(patch.isbn, '9780486400914');
  assert.equal(patch.series.name, 'Little Nemo');
  assert.equal(patch.series.number, 2);
  assert.ok(filled.includes('genre'));
  assert.ok(filled.includes('series'));
});

test('nothing already entered is overwritten', () => {
  const { patch } = fillMissing(existing, incoming);

  assert.ok(!('pageCount' in patch), 'a corrected length must survive a re-import');
  assert.ok(!('description' in patch), 'a description you wrote is not reverted to the blurb');
  assert.ok(!('author' in patch));
});

test('a status and a schedule are never touched by an import', () => {
  const { patch } = fillMissing(existing, incoming);
  assert.ok(!('status' in patch), 'a catalogue has no idea what you are reading');
  assert.ok(!('schedule' in patch));
  assert.ok(!('progress' in patch));
});

test('tags are added rather than replaced', () => {
  const { patch, filled } = fillMissing(existing, incoming);
  assert.deepEqual(patch.shelves, ['to reread', 'comics']);
  assert.ok(filled.some((label) => label.includes('tag')));
});

test('a book with nothing missing produces no patch at all', () => {
  const complete = book({
    title: 'Complete', author: 'Someone', isbn: '9780441013593', pageCount: 100,
    description: 'Blurb.', genre: 'Fiction', notes: 'Notes.', shelves: ['comics'],
    series: { name: 'S', number: 1, total: 3 },
  });
  const { patch, filled } = fillMissing(complete, {
    ...incoming, title: 'Complete', shelves: ['comics'],
  });

  assert.deepEqual(patch, {});
  assert.deepEqual(filled, []);
});

test('a zero length counts as missing, not as a real length', () => {
  const { patch } = fillMissing(book({ pageCount: 0 }), { pageCount: 144 });
  assert.equal(patch.pageCount, 144);
  assert.ok(isEmpty(0) && isEmpty('') && isEmpty(null) && isEmpty([]));
});

test('a field missing from the catalogue leaves the record alone', () => {
  const { patch } = fillMissing(book({}), { title: 'A Book' });
  assert.deepEqual(patch, {});
});

/* --- The real catalogue ---------------------------------------------------- */

test('a catalogue with descriptions imports, then fills on a second pass', () => {
  const parsed = parseCalibreCsv(fixture('calibre-with-descriptions.csv'));
  assert.ok(parsed.ok);
  assert.equal(parsed.books.length, 7);
  assert.equal(parsed.withDescriptions, 7, 'every row has a description to give');
  assert.equal(parsed.withCovers, 6, 'one row has no cover path');

  // First pass: a library that already holds these as bare records, the way
  // they would be if they had been catalogued by hand.
  const library = parsed.books.map((entry) =>
    book({ title: entry.title, author: entry.author, status: 'backlog' })
  );

  let filledBooks = 0;
  for (const entry of parsed.books) {
    const incomingWithCredits = { ...entry, authors: parsed.authors.get(entry.id) ?? [] };
    const match = matchExisting(library, incomingWithCredits);
    assert.ok(match, `${entry.title} should match the record already here`);

    const { patch, filled } = fillMissing(match, incomingWithCredits);
    if (filled.length) filledBooks += 1;

    assert.ok(patch.description, 'the description is what this re-import is for');
  }

  assert.equal(filledBooks, 7);
});

test('an interlude volume keeps its place between two whole numbers', () => {
  const { books } = parseCalibreCsv(fixture('calibre-with-descriptions.csv'));
  const nemo = books
    .filter((entry) => entry.series.name === 'Little Nemo')
    .map((entry) => entry.series.number)
    .sort((a, b) => a - b);

  assert.deepEqual(nemo, [1, 2, 2.5, 3]);
});

test('an import never guesses a kind from the books around it', () => {
  // A catalogue row says what it says. Inferring "this one is a comic because
  // its neighbours are" silently rewrites a field the reader owns, and being
  // quietly wrong about six books is worse than being blank about one — the
  // library view can sort by recently added and set them all in one action.
  const { books } = parseCalibreCsv(fixture('calibre-with-descriptions.csv'));
  const interlude = books.find((entry) => entry.title.includes('Interlude'));

  assert.equal(interlude.category, 'book', 'nothing in its own row says comic');
});

/* --- One book, more than one form ------------------------------------------ */

import { formatUnit, primaryFormat, formatLabel, hasFormat, normalizeSession } from '../js/data/schema.js';

test('a book can be read and listened to at once', () => {
  // Gideon the Ninth in print with the audiobook playing is one book being
  // read one time — same progress, same finish date — not two records.
  const both = book({ formats: ['physical', 'audio'] });

  assert.deepEqual(both.formats, ['physical', 'audio']);
  assert.ok(hasFormat(both, 'physical') && hasFormat(both, 'audio'));
  assert.equal(formatLabel(both), 'Physical and audiobook');
});

test('pages beat minutes when a book is both', () => {
  // A page count is a property of the book; a running time is a property of
  // one recording. Progress you can check against the object in your hands is
  // the one worth tracking.
  assert.equal(formatUnit(book({ formats: ['physical', 'audio'] })), 'pages');
  assert.equal(formatUnit(book({ formats: ['ebook', 'audio'] })), 'pages');
  assert.equal(formatUnit(book({ formats: ['audio'] })), 'minutes');
});

test('formats are stored in a stable order however they arrive', () => {
  assert.deepEqual(book({ formats: ['audio', 'physical'] }).formats, ['physical', 'audio']);
  assert.deepEqual(book({ formats: ['audio', 'ebook'] }).formats, ['ebook', 'audio']);
});

test('a book saved before formats were plural still works', () => {
  // Everything catalogued up to now has `format` and no `formats`.
  const old = book({ format: 'audio' });
  assert.deepEqual(old.formats, ['audio']);
  assert.equal(formatUnit(old), 'minutes');
  assert.equal(primaryFormat(old), 'audio');
});

test('a book always has at least one format', () => {
  // No format means no unit, and every pacing figure silently falling back to
  // pages while the record claims otherwise.
  assert.deepEqual(book({ formats: [] }).formats, ['physical']);
  assert.deepEqual(book({ formats: ['nonsense'] }).formats, ['physical']);
});

test('the primary format is kept in step with the list', () => {
  // Two fields that can disagree about the same fact eventually will.
  const both = book({ formats: ['audio', 'physical'], format: 'audio' });
  assert.equal(both.format, 'physical', 'the primary follows the list, not the other way round');
});

test('a sitting can record which way it happened', () => {
  const session = normalizeSession({ date: '2026-08-19', minutes: 45, via: 'audio' });
  assert.equal(session.via, 'audio');
  // Not stated is the honest default: every session logged before the field
  // existed, and every book that only comes in one form.
  assert.equal(normalizeSession({ date: '2026-08-19', minutes: 45 }).via, null);
  assert.equal(normalizeSession({ date: '2026-08-19', minutes: 45, via: 'papyrus' }).via, null);
});
