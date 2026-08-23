/**
 * Setting a book's cover, from wherever the image came from.
 *
 * Three routes in — a file dropped on the shelf, an address pasted into the
 * picker, a result chosen from a catalogue — and one place they converge, so
 * that "the cover ends up in the image store, on the server, and in the
 * record" is written once rather than three times with two of them slightly
 * wrong.
 *
 * The order matters. The image store is written first because it is the copy
 * that works offline and the one the calendar reads; the server is told next
 * because it is the copy every *other* device reads; the record is updated
 * last, because updating it is what triggers a re-render, and a re-render that
 * happens before the bytes are stored paints the old cover.
 */

import { updateBook } from './store.js';
import { fileToCoverDataUrl, normalizeCoverUrl } from './covers.js';
import {
  storeUploadedCover, storeUploadedCoverOnServer, storeCoverOnServer,
  cacheCover, LOCAL_COVER,
} from './coverCache.js';

/**
 * Use an image file as this book's cover.
 *
 * The file is downscaled first — a 4 MB phone photo of a paperback is a
 * perfectly reasonable thing to drop on a book, and storing it at full size
 * would fill the browser's quota after about a dozen of them.
 *
 * @param {object} book
 * @param {File|Blob} file
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function setCoverFromFile(book, file) {
  let dataUrl;
  try {
    dataUrl = await fileToCoverDataUrl(file);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  let url = dataUrl;
  let stored = false;
  try {
    await storeUploadedCover(book.id, dataUrl);
    url = LOCAL_COVER;
    stored = true;
  } catch {
    // No IndexedDB in this browser: keep the data URL in the record rather
    // than losing the image. Settings > Reclaim space cleans it up later.
  }

  await storeUploadedCoverOnServer(book.id, dataUrl, book.title, book.category).catch(() => false);

  const result = updateBook(book.id, { cover: { url, source: 'upload' } });
  if (!result.ok) return { ok: false, error: Object.values(result.errors)[0] };

  return { ok: true, stored };
}

/**
 * Use an image somewhere on the web as this book's cover.
 *
 * @param {object} book
 * @param {string} input - a URL, possibly with whitespace around it
 */
export async function setCoverFromUrl(book, input) {
  let url;
  try {
    url = normalizeCoverUrl(input);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const result = updateBook(book.id, { cover: { url, source: 'url' } });
  if (!result.ok) return { ok: false, error: Object.values(result.errors)[0] };

  // Both copies are attempted and neither is required: a host that blocks
  // cross-origin reads still shows its cover to an <img>, and a book with no
  // server is a book with one device.
  await Promise.allSettled([
    cacheCover(book.id, url),
    storeCoverOnServer(book.id, url, book.title, book.category),
  ]);

  return { ok: true };
}
