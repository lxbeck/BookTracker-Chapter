/**
 * Calibre CSV catalogue import.
 *
 * Calibre's CSV catalogue is narrower than Goodreads': title, authors, series,
 * series_index, cover, isbn. Notably no page count and no reading status —
 * Calibre is a library, not a reading log — so everything arrives as an
 * unscheduled ebook and page counts are looked up from the ISBN afterwards.
 *
 * The `cover` column is the interesting one. It's an absolute path on the
 * machine running Calibre, which is useless to a browser but perfectly
 * readable by the sync server running on that same machine. When the server is
 * there, covers come straight off disk — no lookup, no rate limits, and it
 * works for books that were never on Open Library.
 */

import { parseCsvObjects } from '../lib/csv.js';
import { normalizeBook } from './schema.js';

const COLUMNS = {
  title: ['title', 'Title'],
  authors: ['authors', 'author', 'Authors', 'Author'],
  series: ['series', 'Series'],
  seriesIndex: ['series_index', 'Series Index'],
  cover: ['cover', 'Cover'],
  isbn: ['isbn', 'ISBN'],
  pages: ['pages', 'Number of Pages'],
  tags: ['tags', 'Tags'],
  // `comments` is Calibre's own field and comes first: it is what every
  // library has, and what the Comments box in Calibre's editor writes to.
  // The rest are fallbacks for catalogues that keep their blurbs elsewhere.
  comments: ['comments', 'description', 'blurb', 'synopsis', 'summary'],
  genre: ['genre', 'Genre', 'category', 'Category'],
  formats: ['formats', 'Formats'],
  published: ['pubdate', 'published'],
  publisher: ['publisher', 'Publisher'],
};

/**
 * Read a column, whatever this catalogue decided to call it.
 *
 * Matching is case-insensitive, ignores spaces against underscores, and
 * ignores a leading `#`, because a Calibre column can arrive as `Series
 * Index`, `series_index` or with a hash in front and mean the same thing every
 * time.
 *
 * **Candidate order decides, not column order.** Iterating the row's own keys
 * meant whichever matching column the export happened to write first won,
 * which is not a rule anyone could predict from looking at their library — a
 * catalogue carrying two columns that both hold a blurb would use whichever
 * one Calibre listed first. The names in `COLUMNS` are in preference order and
 * are now tried in that order.
 */
const normalizeHeader = (header) =>
  String(header ?? '').trim().toLowerCase().replace(/^#/, '').replace(/[\s_]+/g, '');

const pick = (row, key) => {
  const entries = Object.entries(row).map(([header, value]) => [normalizeHeader(header), value]);

  for (const candidate of COLUMNS[key].map(normalizeHeader)) {
    const found = entries.find(([header, value]) => header === candidate && value);
    if (found) return found[1];
  }
  return '';
};

const cleanIsbn = (raw) => {
  const digits = String(raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return [10, 13].includes(digits.length) ? digits : '';
};

/** Calibre joins multiple authors with ` & `; the first is the one we show. */
function splitAuthors(raw) {
  const all = String(raw ?? '')
    .split(/\s*&\s*|\s*,\s*(?=[A-Z])/)
    .map((name) => name.trim())
    .filter(Boolean);
  return { primary: all[0] ?? '', all };
}

/**
 * Where in the series this sits.
 *
 * Calibre writes every index as a float, so `5.0` is a whole number wearing a
 * float's clothing and must come back as 5. The fractional ones are real
 * though — a side story between volumes four and five is genuinely #4.5 — and
 * rounding those to a whole number files them under a volume that already
 * exists, which is worse than having no number at all.
 */
function seriesNumber(raw) {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Number.isInteger(value) ? value : Math.round(value * 100) / 100;
}

/**
 * Calibre's format column looks like `EPUB, MOBI`. Anything with an audio
 * extension is an audiobook; everything else in a Calibre library is an ebook.
 */
function detectFormat(raw) {
  const text = String(raw ?? '').toLowerCase();
  const formats = [];
  // A Calibre record can hold an EPUB and an M4B side by side, which is the
  // same book in two forms rather than a choice between them.
  if (/epub|mobi|azw|pdf|cbz|cbr/.test(text)) formats.push('ebook');
  if (/m4b|mp3|m4a|opus|aax/.test(text)) formats.push('audio');
  return formats.length ? formats : ['ebook'];
}

/**
 * Guess what kind of thing this is from the metadata Calibre carries.
 *
 * A guess, not a claim — it only ever sets the initial value, and the field is
 * editable. Getting it right for the obvious cases saves reclassifying a few
 * hundred imported comics by hand.
 */
function detectCategory(row) {
  const haystack = [
    pick(row, 'title'), pick(row, 'series'), pick(row, 'tags'), pick(row, 'publisher'),
  ].join(' ').toLowerCase();

  if (/\bmanga\b|viz media|kodansha|shonen|shoujo|seinen|yen press/.test(haystack)) return 'manga';
  if (/graphic novel|\bomnibus\b|compendium/.test(haystack)) return 'graphicNovel';
  // "Vol. 3", "Volume 3" and "#3" all mean the same thing to a reader and
  // should mean the same thing here; only the abbreviation was matched before.
  if (/\bcomics?\b|\bvol(?:\.|ume)?\s*\d|#\d|dc comics|marvel|image comics|dark horse|boom!|idw/.test(haystack)) {
    return 'comic';
  }
  if (/anthology|collected (stories|tales)/.test(haystack)) return 'anthology';
  return 'book';
}

/**
 * The series this book belongs to, if it belongs to one.
 *
 * Calibre writes a series index of 1.0 for every book whether or not it is in
 * a series, so a number with no name attached is an artefact of the export
 * rather than a fact about the book — and a library full of standalone titles
 * all claiming to be volume one is worse than one claiming nothing.
 */
function seriesOf(row) {
  const name = pick(row, 'series').trim();
  return {
    name,
    number: name ? seriesNumber(pick(row, 'seriesIndex')) : null,
    total: null,
  };
}

export function rowToBook(row) {
  const title = pick(row, 'title').trim();
  if (!title) return null;

  const { primary, all } = splitAuthors(pick(row, 'authors'));
  const coverPath = pick(row, 'cover').trim();
  const pages = Number.parseInt(pick(row, 'pages'), 10);

  return {
    title,
    author: primary,
    isbn: cleanIsbn(pick(row, 'isbn')),
    // Calibre catalogues carry no page count by default. Left empty rather
    // than guessed; an ISBN lookup can fill it in later, and a wrong length
    // would poison every pacing figure that depends on it.
    pageCount: Number.isFinite(pages) && pages > 0 ? pages : null,
    formats: detectFormat(pick(row, 'formats')),
    // A Calibre catalogue is what you own, not what you have scheduled.
    status: 'backlog',
    category: detectCategory(row),
    genre: pick(row, 'genre').split(',')[0].trim(),
    description: pick(row, 'comments').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000),
    series: seriesOf(row),
    shelves: pick(row, 'tags').split(',').map((tag) => tag.trim()).filter(Boolean),
    // Second and subsequent credits go in their own field. Notes are yours.
    coAuthors: all.slice(1),
    // Carried alongside the record, not stored on it — see importCalibre.
    _coverPath: coverPath,
    // Every author, not just the one shown. A collaboration is credited in a
    // different order by different catalogues — "Fábio Moon & Terry Moore"
    // here, "Terry Moore" in a record typed by hand — and matching on only the
    // first name would file the same book twice.
    _authors: all,
  };
}

/**
 * @returns {{ok: boolean, error?: string, books: object[], paths: Map<string,string>,
 *   authors: Map<string,string[]>, skipped: number, withCovers: number,
 *   withIsbn: number, withDescriptions: number}}
 */
export function parseCalibreCsv(text) {
  const { headers, rows } = parseCsvObjects(text);

  if (!headers.length) {
    return {
      ok: false, error: 'That file is empty.',
      books: [], paths: new Map(), authors: new Map(),
      skipped: 0, withCovers: 0, withIsbn: 0, withDescriptions: 0,
    };
  }

  const hasTitle = headers.some(
    (header) => normalizeHeader(header) === 'title'
  );
  if (!hasTitle) {
    return {
      ok: false,
      error: `That does not look like a Calibre catalogue — no title column. Found: ${headers.slice(0, 6).join(', ')}`,
      books: [], paths: new Map(), authors: new Map(),
      skipped: 0, withCovers: 0, withIsbn: 0, withDescriptions: 0,
    };
  }

  const books = [];
  const paths = new Map();
  const authors = new Map();
  let skipped = 0;

  for (const row of rows) {
    const mapped = rowToBook(row);
    if (!mapped) {
      skipped += 1;
      continue;
    }
    const { _coverPath, _authors, ...rest } = mapped;
    const book = normalizeBook(rest);
    if (_coverPath) paths.set(book.id, _coverPath);
    if (_authors?.length) authors.set(book.id, _authors);
    books.push(book);
  }

  return {
    ok: true,
    books,
    paths,
    authors,
    skipped,
    withCovers: paths.size,
    withIsbn: books.filter((book) => book.isbn).length,
    withDescriptions: books.filter((book) => book.description).length,
  };
}
