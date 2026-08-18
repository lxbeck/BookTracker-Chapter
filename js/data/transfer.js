/**
 * Export and import.
 *
 * JSON is the real backup: it round-trips every field, including sessions,
 * quotes and shelves. CSV is the lossy one people actually open in a
 * spreadsheet, so it flattens to one row per book and says so.
 *
 * Import is deliberately additive by default. Someone restoring a backup onto
 * a library they've since added to should not silently lose the additions, so
 * merge is the default and replace has to be asked for.
 */

import { SCHEMA_VERSION, normalizeBook } from './schema.js';
import { allBooks, getState, replaceAll, addBook, updateBook, getBook } from './store.js';
import { today } from '../lib/dates.js';

/* --- Export --------------------------------------------------------------- */

export function exportJson() {
  const state = getState();
  return JSON.stringify(
    {
      format: 'chapter-library',
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      books: state.books,
    },
    null,
    2
  );
}

const CSV_COLUMNS = [
  ['title', (b) => b.title],
  ['author', (b) => b.author],
  ['isbn', (b) => b.isbn],
  ['format', (b) => b.format],
  ['status', (b) => b.status],
  ['genre', (b) => b.genre],
  ['shelves', (b) => b.shelves.join('; ')],
  ['series', (b) => b.series.name],
  ['series_number', (b) => b.series.number ?? ''],
  ['length', (b) => b.pageCount ?? ''],
  ['current_page', (b) => b.progress.page || ''],
  ['percent', (b) => (b.progress.percent ? Math.round(b.progress.percent) : '')],
  ['planned_start', (b) => b.schedule.start ?? ''],
  ['planned_end', (b) => b.schedule.end ?? ''],
  ['started', (b) => b.actual.startedAt ?? ''],
  ['finished', (b) => b.actual.finishedAt ?? ''],
  ['sessions', (b) => b.sessions.length],
  ['minutes_logged', (b) => b.sessions.reduce((sum, s) => sum + (s.minutes ?? 0), 0)],
  ['rating', (b) => b.rating ?? ''],
  ['notes', (b) => b.notes],
];

/** Quote anything that could break a cell; double up embedded quotes. */
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportCsv(books = allBooks()) {
  const header = CSV_COLUMNS.map(([name]) => name).join(',');
  const rows = books.map((book) =>
    CSV_COLUMNS.map(([, read]) => csvCell(read(book))).join(',')
  );
  return [header, ...rows].join('\n');
}

/** One row per session, for anyone who wants to chart their own log. */
export function exportSessionsCsv(books = allBooks()) {
  const header = 'date,title,author,minutes,page_from,page_to,pages';
  const rows = books.flatMap((book) =>
    book.sessions.map((session) =>
      [
        session.date,
        csvCell(book.title),
        csvCell(book.author),
        session.minutes ?? '',
        session.pageFrom ?? '',
        session.pageTo ?? '',
        session.pageFrom != null && session.pageTo != null ? session.pageTo - session.pageFrom : '',
      ].join(',')
    )
  );
  return [header, ...rows].join('\n');
}

/** Trigger a download without leaving the page. */
export function download(filename, content, type = 'application/json') {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const backupFilename = (extension) => `chapter-library-${today()}.${extension}`;

/* --- Import --------------------------------------------------------------- */

/**
 * @param {string} text - file contents
 * @param {{mode?: 'merge'|'replace'}} [options]
 * @returns {{ok: boolean, added: number, updated: number, skipped: number, error?: string}}
 */
export function importJson(text, { mode = 'merge' } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not valid JSON.', added: 0, updated: 0, skipped: 0 };
  }

  const incoming = Array.isArray(parsed) ? parsed : parsed?.books;
  if (!Array.isArray(incoming)) {
    return {
      ok: false,
      error: 'No books found in that file. Expected a Chapter export.',
      added: 0,
      updated: 0,
      skipped: 0,
    };
  }

  const books = incoming.map((book) => normalizeBook(book)).filter((book) => book.title);
  if (!books.length) {
    return { ok: false, error: 'Every record in that file was empty.', added: 0, updated: 0, skipped: 0 };
  }

  if (mode === 'replace') {
    replaceAll(books, { settings: parsed?.settings });
    return { ok: true, added: books.length, updated: 0, skipped: 0 };
  }

  // Merge: match on id first, then on title + author, so re-importing a backup
  // updates records rather than creating a second copy of every book.
  const existing = allBooks();
  const byKey = new Map(
    existing.map((book) => [`${book.title.toLowerCase()}|${book.author.toLowerCase()}`, book])
  );

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const book of books) {
    const match =
      getBook(book.id) ?? byKey.get(`${book.title.toLowerCase()}|${book.author.toLowerCase()}`);

    if (match) {
      const result = updateBook(match.id, { ...book, id: match.id, createdAt: match.createdAt });
      result.ok ? (updated += 1) : (skipped += 1);
    } else {
      const result = addBook(book);
      result.ok ? (added += 1) : (skipped += 1);
    }
  }

  return { ok: true, added, updated, skipped };
}
