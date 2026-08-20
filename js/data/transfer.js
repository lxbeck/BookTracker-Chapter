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

import { SCHEMA_VERSION, normalizeBook, normalizeOrder } from './schema.js';
import {
  allBooks, getState, replaceAll, addBook, updateBook, getBook,
  allOrders, getOrder, createOrder, updateOrder,
} from './store.js';
import { coverAsDataUrl } from './snapshot.js';
import { storeUploadedCover, storeUploadedCoverOnServer, LOCAL_COVER } from './coverCache.js';
import { today } from '../lib/dates.js';

/* --- Export --------------------------------------------------------------- */

/**
 * Everything the library consists of, in one object.
 *
 * "Everything" is meant literally, and is easy to get wrong by omission: a
 * backup that quietly leaves out reading orders looks complete until the day
 * you need it. So the shape is built from the whole state rather than from a
 * hand-picked list of fields, and the parts that are not simply state —
 * tombstones, cover bytes — are named explicitly below.
 *
 * `deleted` is carried because a restore onto a device that still has a book
 * you deleted elsewhere should delete it there too. Without the tombstones a
 * restore silently resurrects everything you have ever thrown away.
 */
function libraryPayload({ covers } = {}) {
  const state = getState();
  return {
    format: 'chapter-library',
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    settingsUpdatedAt: state.settingsUpdatedAt,
    readingOrders: allOrders(),
    deleted: state.deleted ?? [],
    books: state.books,
    ...(covers ? { covers } : {}),
    counts: {
      books: state.books.length,
      readingOrders: (state.readingOrders ?? []).length,
      sessions: state.books.reduce((sum, book) => sum + book.sessions.length, 0),
      covers: covers ? Object.keys(covers).length : 0,
    },
  };
}

export function exportJson() {
  return JSON.stringify(libraryPayload(), null, 2);
}

/**
 * The same backup, with the cover art inside it.
 *
 * Uploaded covers live in this browser's image store and nowhere else — they
 * are not in the record, which holds only a sentinel. Export without them and
 * a restore on another machine comes back with every hand-picked cover gone,
 * which is the one part of a library nobody can reconstruct from memory.
 *
 * It is optional because it makes the file an order of magnitude larger, and a
 * backup you take weekly should be able to be small.
 *
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function exportJsonWithCovers(onProgress) {
  const books = allBooks();
  const covers = {};
  let done = 0;

  for (const book of books) {
    // Only art that would otherwise be lost or unreachable: a plain https URL
    // will still be a plain https URL after a restore.
    const worthKeeping =
      book.cover?.url === LOCAL_COVER ||
      book.cover?.url?.startsWith('data:') ||
      !book.cover?.url;

    if (worthKeeping) {
      const dataUrl = await coverAsDataUrl(book);
      if (dataUrl) covers[book.id] = dataUrl;
    }

    done += 1;
    onProgress?.(done, books.length);
  }

  return JSON.stringify(libraryPayload({ covers }), null, 2);
}

const CSV_COLUMNS = [
  ['title', (b) => b.title],
  ['author', (b) => b.author],
  ['isbn', (b) => b.isbn],
  ['format', (b) => b.format],
  ['formats', (b) => b.formats.join('; ')],
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
  const header = 'date,title,author,minutes,page_from,page_to,pages,via';
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
        session.via ?? '',
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
  const hasOrders = Array.isArray(parsed?.readingOrders) && parsed.readingOrders.length > 0;

  // A file with no usable books is only an error if it has nothing else to
  // give. A library that is all sequences and no records is unusual but legal,
  // and refusing it would mean a backup taken before any books were added
  // could never be restored.
  if (!books.length && !hasOrders) {
    return { ok: false, error: 'Every record in that file was empty.', added: 0, updated: 0, skipped: 0 };
  }

  if (mode === 'replace') {
    replaceAll(books, {
      settings: parsed?.settings,
      readingOrders: parsed?.readingOrders,
      // The backup's tombstones, not this device's: restoring a library means
      // adopting its record of what was thrown away, and keeping the old ones
      // would re-delete books the backup deliberately contains.
      deleted: Array.isArray(parsed?.deleted) ? parsed.deleted : [],
    });
    return {
      ok: true, added: books.length, updated: 0, skipped: 0,
      orders: (parsed?.readingOrders ?? []).length,
      covers: Object.keys(parsed?.covers ?? {}).length,
    };
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

  /** Old id -> new id, for any book that arrived under a different record. */
  const remapped = new Map();

  for (const book of books) {
    const match =
      getBook(book.id) ?? byKey.get(`${book.title.toLowerCase()}|${book.author.toLowerCase()}`);

    if (match) {
      if (match.id !== book.id) remapped.set(book.id, match.id);
      const result = updateBook(match.id, { ...book, id: match.id, createdAt: match.createdAt });
      result.ok ? (updated += 1) : (skipped += 1);
    } else {
      const result = addBook(book);
      result.ok ? (added += 1) : (skipped += 1);
    }
  }

  // Reading orders were being dropped entirely on a merge — restored only by
  // the replace path, which is the one nobody uses because it wipes the
  // library. A backup that silently loses your sequences is not a backup.
  const orders = mergeOrders(parsed?.readingOrders, remapped);

  return { ok: true, added, updated, skipped, orders, remapped };
}

/**
 * Fold imported lists into the ones already here.
 *
 * Matched by id first and by name second, the same rule books use, so
 * re-importing a backup updates the list you already have rather than leaving
 * you with two called "Poe, in order".
 *
 * Book ids are rewritten on the way in: a book matched by title and author
 * keeps the id it already had here, and a sequence still pointing at the id
 * from the exporting device would be a list of books that do not exist.
 */
function mergeOrders(incoming, remapped = new Map()) {
  if (!Array.isArray(incoming) || !incoming.length) return 0;

  const existing = allOrders();
  const byName = new Map(existing.map((order) => [order.name.toLowerCase(), order]));
  let touched = 0;

  for (const raw of incoming) {
    const order = normalizeOrder(raw);
    if (!order.name) continue;

    const bookIds = order.bookIds
      .map((id) => remapped.get(id) ?? id)
      // A sequence naming books that were not in the file and are not here is
      // a list of dead entries; drop them rather than render blanks.
      .filter((id) => getBook(id));

    const match = getOrder(order.id) ?? byName.get(order.name.toLowerCase());

    if (match) {
      // Union rather than replace: the imported sequence wins for the books it
      // knows about, and anything added here since stays on the end.
      const extra = match.bookIds.filter((id) => !bookIds.includes(id));
      updateOrder(match.id, {
        bookIds: [...bookIds, ...extra],
        description: match.description || order.description,
      });
    } else {
      createOrder({ ...order, bookIds });
    }
    touched += 1;
  }

  return touched;
}

/**
 * Put backed-up cover art back into this browser's image store.
 *
 * Separate from `importJson` and asynchronous because it touches IndexedDB and
 * the network, and the books should appear immediately rather than after every
 * cover has been written.
 *
 * @param {object} parsed - the parsed export
 * @param {Map<string, string>} [remapped] - old id -> id used here
 * @returns {Promise<{restored: number}>}
 */
export async function restoreCovers(parsed, remapped = new Map()) {
  const covers = parsed?.covers;
  if (!covers || typeof covers !== 'object') return { restored: 0 };

  let restored = 0;

  for (const [originalId, dataUrl] of Object.entries(covers)) {
    const id = remapped.get(originalId) ?? originalId;
    const book = getBook(id);
    if (!book || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) continue;

    try {
      await storeUploadedCover(id, dataUrl);
      // The record has to say the art is in the image store, or the cover sits
      // there unreferenced and the book still shows its typeset spine.
      updateBook(id, { cover: { url: LOCAL_COVER, source: book.cover?.source || 'upload' } });
      storeUploadedCoverOnServer(id, dataUrl, book.title).catch(() => null);
      restored += 1;
    } catch {
      // No image store in this browser: the book keeps whatever cover it had.
    }
  }

  return { restored };
}
