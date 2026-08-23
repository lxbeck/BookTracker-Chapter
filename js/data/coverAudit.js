/**
 * Where each cover actually is.
 *
 * A cover on screen is not a cover you have. It might be a file in the covers
 * folder, or a copy in this browser's image store, or nothing at all but a URL
 * pointing at a catalogue that will answer today and 404 in three years. All
 * three look identical on the shelf, which is exactly the problem: the one
 * question you cannot answer by looking is the one that matters when a server
 * moves, a browser clears its data, or Open Library reorganises its buckets.
 *
 * So each book gets a verdict, and the verdicts are ranked by how much of the
 * image you would still have if the internet went away:
 *
 *   stored   in the covers folder on the server, as a file you can open
 *   device   in this browser's image store, and nowhere else
 *   linked   a URL and nothing more — fetched fresh every time, yours never
 *   none     no cover at all
 *
 * `stored` and `device` are not exclusive in practice — most stored covers are
 * cached locally too — but the verdict names the strongest copy, because that
 * is what the question is asking.
 */

import { LOCAL_COVER } from './coverCache.js';
import { compareTitles } from '../lib/titles.js';

export const VERDICTS = {
  stored: {
    id: 'stored',
    label: 'In the covers folder',
    hint: 'A file on the server. Survives clearing this browser, and every device sees it.',
  },
  device: {
    id: 'device',
    label: 'This browser only',
    hint: 'Held in this browser\u2019s image store. Lost if you clear site data, and invisible to your other devices.',
  },
  linked: {
    id: 'linked',
    label: 'Linked, not saved',
    hint: 'Only an address. It loads while the catalogue serves it and shows a blank spine the day it stops.',
  },
  none: { id: 'none', label: 'No cover', hint: 'Nothing to show but a typeset spine.' },
};

export const VERDICT_ORDER = ['stored', 'device', 'linked', 'none'];

/**
 * Work out where one book's cover lives.
 *
 * @param {object} book
 * @param {{onServer: Set<string>, onDevice: Set<string>}} known
 */
export function verdictFor(book, { onServer, onDevice }) {
  if (onServer.has(book.id)) return 'stored';
  if (onDevice.has(book.id)) return 'device';

  const url = book.cover?.url;
  if (!url) return 'none';
  // The sentinel means "look in the image store" — and we already know it is
  // not there, so the record is pointing at something that no longer exists.
  if (url === LOCAL_COVER) return 'none';
  return 'linked';
}

/**
 * A full report on the library's cover art.
 *
 * @param {object[]} books
 * @param {{onServer?: Iterable<string>, onDevice?: Iterable<string>,
 *   files?: Record<string, string>, hasServer?: boolean}} sources
 */
export function auditCovers(books, sources = {}) {
  const onServer = new Set(sources.onServer ?? []);
  const onDevice = new Set(sources.onDevice ?? []);
  const files = sources.files ?? {};

  const byVerdict = { stored: [], device: [], linked: [], none: [] };

  for (const book of books) {
    const verdict = verdictFor(book, { onServer, onDevice });
    byVerdict[verdict].push({
      id: book.id,
      title: book.title,
      author: book.author,
      verdict,
      file: files[book.id] ?? null,
    });
  }

  for (const list of Object.values(byVerdict)) {
    list.sort((a, b) => compareTitles(a.title, b.title));
  }

  // Files in the folder belonging to no book. Deleting a book removes its
  // cover, but a library restored from a backup onto a server that kept its
  // old folder will have some, and they are otherwise invisible.
  const known = new Set(books.map((book) => book.id));
  const orphans = Object.entries(files)
    .filter(([bookId]) => !known.has(bookId))
    .map(([bookId, file]) => ({ id: bookId, file }));

  return {
    byVerdict,
    orphans,
    counts: Object.fromEntries(
      VERDICT_ORDER.map((verdict) => [verdict, byVerdict[verdict].length])
    ),
    total: books.length,
    // What "store the missing ones" would actually act on: anything with an
    // address that is not yet a file. A book with no cover has nothing to
    // store, and no button should imply otherwise.
    storable: sources.hasServer
      ? [...byVerdict.linked, ...byVerdict.device].length
      : 0,
  };
}
