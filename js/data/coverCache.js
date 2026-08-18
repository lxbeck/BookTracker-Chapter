/**
 * Offline cover cache.
 *
 * Fetched covers are stored as URLs, which means no covers without a network.
 * This module downloads the image once and keeps the bytes in IndexedDB, so
 * the library works on a plane.
 *
 * IndexedDB rather than localStorage because cover art is measured in hundreds
 * of kilobytes and localStorage is a ~5MB budget shared with every record you
 * own. Blobs also avoid the 33% size penalty base64 imposes.
 *
 * Everything here fails soft. A cover that won't cache is a cover that still
 * loads from the network, and a browser with IndexedDB blocked still runs the
 * whole app.
 */

const DB_NAME = 'chapter-covers';
const DB_VERSION = 1;
const STORE = 'covers';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });

  return dbPromise;
}

function tx(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

/* --- Object URL bookkeeping ------------------------------------------------
 * Every createObjectURL leaks until it's revoked, and the calendar creates one
 * per cover on every render. Handing out a cached URL per book keeps the count
 * at one per book rather than one per paint.
 * -------------------------------------------------------------------------- */

const liveUrls = new Map();

/** A local blob URL for a cached cover, or null if it isn't cached. */
export async function cachedCoverUrl(bookId) {
  if (liveUrls.has(bookId)) return liveUrls.get(bookId);
  try {
    const record = await tx('readonly', (store) => store.get(bookId));
    if (!record?.blob) return null;
    const url = URL.createObjectURL(record.blob);
    liveUrls.set(bookId, url);
    return url;
  } catch {
    return null;
  }
}

/** Synchronous peek, for render paths that can't await. */
export const peekCachedCoverUrl = (bookId) => liveUrls.get(bookId) ?? null;

/**
 * Download and store one cover.
 * @returns {Promise<boolean>} whether it ended up cached
 */
export async function cacheCover(bookId, url) {
  if (!url) return false;

  // Data URLs are already local — nothing to fetch, nothing to gain.
  if (url.startsWith('data:')) return false;

  try {
    const response = await fetch(url, { mode: 'cors', cache: 'force-cache' });
    if (!response.ok) return false;
    const blob = await response.blob();
    if (!blob.size || !blob.type.startsWith('image/')) return false;

    await tx('readwrite', (store) =>
      store.put({ id: bookId, blob, url, cachedAt: new Date().toISOString() })
    );
    // Drop any stale object URL so the next read reflects the new bytes.
    releaseUrl(bookId);
    return true;
  } catch {
    // Cross-origin images without CORS headers land here. Not an error worth
    // surfacing — the cover still works online.
    return false;
  }
}

export async function removeCachedCover(bookId) {
  releaseUrl(bookId);
  try {
    await tx('readwrite', (store) => store.delete(bookId));
  } catch {
    /* nothing to do */
  }
}

function releaseUrl(bookId) {
  const url = liveUrls.get(bookId);
  if (url) {
    URL.revokeObjectURL(url);
    liveUrls.delete(bookId);
  }
}

/** Which of these books already have their art stored locally. */
export async function cachedIds(bookIds) {
  const found = new Set();
  await Promise.all(
    bookIds.map(async (id) => {
      try {
        const record = await tx('readonly', (store) => store.get(id));
        if (record?.blob) found.add(id);
      } catch {
        /* ignore */
      }
    })
  );
  return found;
}

/**
 * Cache every cover in the library that isn't already stored.
 * @param {object[]} books
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{cached: number, failed: number, skipped: number}>}
 */
export async function cacheAll(books, onProgress) {
  const candidates = books.filter((book) => book.cover?.url && !book.cover.url.startsWith('data:'));
  const already = await cachedIds(candidates.map((book) => book.id));

  let cached = 0;
  let failed = 0;
  let done = 0;

  // Sequential on purpose: firing forty image requests at Open Library at once
  // is how you get rate-limited into failing them all.
  for (const book of candidates) {
    if (!already.has(book.id)) {
      const ok = await cacheCover(book.id, book.cover.url);
      if (ok) cached += 1;
      else failed += 1;
    }
    done += 1;
    onProgress?.(done, candidates.length);
  }

  return { cached, failed, skipped: already.size };
}

/** Rough size of the cache, for the settings readout. */
export async function cacheSize() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return estimate?.usage ?? null;
  } catch {
    return null;
  }
}
