/**
 * Goodreads CSV import.
 *
 * Goodreads exports a wide, quirky CSV: ISBNs arrive wrapped as `="0765335344"`
 * because that's how you stop a spreadsheet eating a leading zero, dates are
 * US-formatted, and shelves are comma-separated inside an already
 * comma-separated file. All of that is handled here so the rest of the app
 * never learns Goodreads exists.
 *
 * StoryGraph's export uses different headers for mostly the same fields, so
 * the column lookup is by alias rather than by exact name.
 */

import { parseCsvObjects } from '../lib/csv.js';
import { normalizeBook } from './schema.js';

/** Goodreads header -> what we call it. First match wins. */
const COLUMNS = {
  title: ['Title'],
  author: ['Author', 'Authors'],
  isbn13: ['ISBN13'],
  isbn: ['ISBN'],
  pages: ['Number of Pages', 'Number of pages'],
  rating: ['My Rating', 'Star Rating'],
  shelf: ['Exclusive Shelf', 'Read Status'],
  shelves: ['Bookshelves', 'Tags'],
  review: ['My Review', 'Review'],
  notes: ['Private Notes'],
  dateRead: ['Date Read', 'Last Date Read'],
  dateAdded: ['Date Added'],
  binding: ['Binding', 'Format'],
  readCount: ['Read Count', 'Read Count'],
  publisher: ['Publisher'],
};

const pick = (row, key) => {
  for (const header of COLUMNS[key]) {
    const value = row[header];
    if (value != null && value !== '') return value;
  }
  return '';
};

/** `="9780486266848"` and `0765335344` both become a clean ISBN. */
function cleanIsbn(raw) {
  const digits = String(raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return [10, 13].includes(digits.length) ? digits : '';
}

/** Goodreads writes `2024/03/17`; StoryGraph writes `2024-03-17`. */
function toDayKey(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const slash = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slash) {
    const [, y, m, d] = slash;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
}

/**
 * Goodreads shelves onto our statuses.
 *
 * "to-read" becomes backlog rather than planned: it records intent, not a
 * date, and a nine-hundred-book to-read shelf landing on the planned shelf
 * would bury the handful of things actually scheduled.
 */
const STATUS_BY_SHELF = {
  read: 'finished',
  'currently-reading': 'reading',
  'to-read': 'backlog',
  'did-not-finish': 'dnf',
  dnf: 'dnf',
  finished: 'finished',
  reading: 'reading',
};

/** Audiobook bindings, so the length is read as minutes rather than pages. */
const AUDIO = /audio|audible/i;
const EBOOK = /kindle|ebook|e-book|digital/i;

/**
 * Convert one exported row into a book.
 * @returns {object|null} null when the row has nothing usable
 */
export function rowToBook(row) {
  const title = pick(row, 'title').trim();
  if (!title) return null;

  const shelf = pick(row, 'shelf').trim().toLowerCase();
  const status = STATUS_BY_SHELF[shelf] ?? 'backlog';
  const binding = pick(row, 'binding');
  const dateRead = toDayKey(pick(row, 'dateRead'));
  const rating = Number.parseInt(pick(row, 'rating'), 10);

  // Goodreads writes 0 for "not rated", which is not a one-star review.
  const stars = Number.isFinite(rating) && rating > 0 ? rating : null;

  const shelves = pick(row, 'shelves')
    .split(',')
    .map((shelf_) => shelf_.trim())
    // The exclusive shelves are status, not shelves; they'd be noise as tags.
    .filter((shelf_) => shelf_ && !['read', 'to-read', 'currently-reading'].includes(shelf_));

  const readCount = Number.parseInt(pick(row, 'readCount'), 10);
  const notes = [
    pick(row, 'notes'),
    Number.isFinite(readCount) && readCount > 1 ? `Read ${readCount} times per Goodreads.` : '',
  ].filter(Boolean).join('\n\n');

  return {
    title,
    author: pick(row, 'author').trim(),
    isbn: cleanIsbn(pick(row, 'isbn13')) || cleanIsbn(pick(row, 'isbn')),
    pageCount: Number.parseInt(pick(row, 'pages'), 10) || null,
    format: AUDIO.test(binding) ? 'audio' : EBOOK.test(binding) ? 'ebook' : 'physical',
    status,
    shelves,
    rating: stars,
    review: pick(row, 'review'),
    notes,
    // A finished book with no date is common in old Goodreads data; leave the
    // date empty rather than inventing one, and let it show as finished.
    actual: {
      startedAt: status === 'finished' ? dateRead : null,
      finishedAt: status === 'finished' ? dateRead : null,
    },
    createdAt: toDayKey(pick(row, 'dateAdded'))
      ? `${toDayKey(pick(row, 'dateAdded'))}T12:00:00.000Z`
      : undefined,
  };
}

/**
 * Parse a whole export.
 *
 * Returns everything rather than importing it, so the caller can show a
 * summary and let someone back out — dropping 900 books into a library
 * unannounced is not a thing to do without asking.
 *
 * @param {string} text
 * @returns {{ok: boolean, error?: string, books: object[], skipped: number,
 *   counts: Record<string, number>, source: string}}
 */
export function parseGoodreadsCsv(text) {
  const { headers, rows } = parseCsvObjects(text);

  if (!headers.length) {
    return { ok: false, error: 'That file is empty.', books: [], skipped: 0, counts: {}, source: '' };
  }
  if (!headers.some((header) => COLUMNS.title.includes(header))) {
    return {
      ok: false,
      error: `That does not look like a Goodreads export — no Title column. Found: ${headers.slice(0, 5).join(', ')}`,
      books: [],
      skipped: 0,
      counts: {},
      source: '',
    };
  }

  const source = headers.includes('Exclusive Shelf') ? 'Goodreads' : 'a reading tracker';
  const books = [];
  let skipped = 0;

  for (const row of rows) {
    const mapped = rowToBook(row);
    if (!mapped) {
      skipped += 1;
      continue;
    }
    books.push(normalizeBook(mapped));
  }

  const counts = books.reduce((tally, book) => {
    tally[book.status] = (tally[book.status] ?? 0) + 1;
    return tally;
  }, {});

  return { ok: true, books, skipped, counts, source };
}
