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
 *
 * When the sync server is present it does this job better — it can fetch hosts
 * that send no CORS headers, and one download serves every device — so
 * `serverCoverUrl` takes priority and this becomes the fallback for the static,
 * serverless setup.
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

/** Set once at boot, when a sync server answers. */
let serverAvailable = false;
export const setServerCovers = (available) => {
  serverAvailable = available;
  return available;
};

/** The server's copy of a cover, if there is a server to ask. */
export const serverCoverUrl = (bookId) =>
  serverAvailable ? `api/covers/${encodeURIComponent(bookId)}` : null;

/**
 * Post to the cover endpoint.
 *
 * The title rides along with every write. The server files cover art by title
 * rather than by record id — `the-hobbit.jpg` rather than `bk-9f2c1a04.jpg` —
 * and it can only do that if it is told the title at the moment the bytes
 * arrive. Sending it here means the folder is readable even for a book the
 * server has never seen in a library push.
 */
async function postCover(bookId, payload) {
  if (!serverAvailable) return false;
  try {
    const response = await fetch(`api/covers/${encodeURIComponent(bookId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    return Boolean(body?.ok);
  } catch {
    return false;
  }
}

/**
 * Ask the server to fetch and keep a cover.
 * @returns {Promise<boolean>}
 */
export async function storeCoverOnServer(bookId, url, title) {
  if (!url || url.startsWith('data:') || url === 'local:cover') return false;
  return postCover(bookId, { url, title });
}

/**
 * Send an image we already have the bytes of — an upload, or something dropped
 * onto a book — to the server, so every other device gets it too.
 */
export async function storeUploadedCoverOnServer(bookId, dataUrl, title) {
  if (!dataUrl?.startsWith('data:')) return false;
  return postCover(bookId, { dataUrl, title });
}

/** Forget the server's copy — used when a cover is removed rather than replaced. */
export async function deleteCoverOnServer(bookId) {
  if (!serverAvailable) return false;
  try {
    const response = await fetch(`api/covers/${encodeURIComponent(bookId)}`, { method: 'DELETE' });
    const body = await response.json();
    return Boolean(body?.ok);
  } catch {
    return false;
  }
}

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
 * Load every stored cover's blob URL before the first paint.
 *
 * Without this, `peekCachedCoverUrl` is empty on a fresh load, every cover
 * starts as a network request, and the offline copy is only swapped in a beat
 * later — or never, if the app is offline and the request fails first. Warming
 * the map up front is the difference between covers that work offline and
 * covers that merely exist offline.
 */
export async function warmCoverCache(bookIds) {
  try {
    await Promise.all(bookIds.map((id) => cachedCoverUrl(id)));
  } catch {
    /* a cold cache is not an error */
  }
  return liveUrls.size;
}

/**
 * Download and store one cover.
 * @returns {Promise<boolean>} whether it ended up cached
 */
export async function cacheCover(bookId, url) {
  if (!url) return false;

  // Data URLs and the local sentinel are already in the image store.
  if (url.startsWith('data:') || url === 'local:cover') return false;

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
      // Ask the server first: it can reach hosts the browser can't, and its
      // copy is the one every other device will use.
      const onServer = await storeCoverOnServer(book.id, book.cover.url, book.title);
      const inBrowser = await cacheCover(book.id, book.cover.url);
      if (onServer || inBrowser) cached += 1;
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

/* --- Getting images out of localStorage -----------------------------------
 *
 * The quota error people hit is almost always this: an uploaded cover was
 * stored as a base64 data URL *inside the library record*, which lives in
 * localStorage. Base64 inflates bytes by a third, localStorage is around 5 MB
 * for everything you own, and a handful of uploads eats it. Once it's full,
 * every unrelated save fails — logging a page, renaming a book, anything.
 *
 * Images belong in IndexedDB, which is measured in hundreds of megabytes.
 * `LOCAL_COVER` is the sentinel left behind in the record: a few bytes saying
 * "the art is in the image store, under this book's id".
 * -------------------------------------------------------------------------- */

export const LOCAL_COVER = 'local:cover';

export const isLocalCover = (url) => url === LOCAL_COVER;

/** Turn a data URL into a blob without a network round trip. */
function dataUrlToBlob(dataUrl) {
  const [header, encoded] = dataUrl.split(',');
  const type = header.match(/data:([^;]+)/)?.[1] ?? 'image/jpeg';
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Store an uploaded image and hand back the sentinel to save in the record. */
export async function storeUploadedCover(bookId, dataUrl) {
  const blob = dataUrlToBlob(dataUrl);
  await tx('readwrite', (store) =>
    store.put({ id: bookId, blob, url: LOCAL_COVER, cachedAt: new Date().toISOString() })
  );
  releaseUrl(bookId);
  return LOCAL_COVER;
}

/**
 * Move any data URLs already sitting in the library out of localStorage.
 *
 * Run once at startup. Someone whose storage is already full got that way
 * before this code existed, and telling them to delete their own covers would
 * be a poor answer when the bytes can simply be moved somewhere they fit.
 *
 * @param {object[]} books
 * @returns {Promise<{moved: number, freedBytes: number, ids: string[]}>}
 */
export async function evacuateDataUrls(books) {
  const offenders = books.filter((book) => book.cover?.url?.startsWith('data:'));
  if (!offenders.length) return { moved: 0, freedBytes: 0, ids: [] };

  let moved = 0;
  let freedBytes = 0;
  const ids = [];

  for (const book of offenders) {
    try {
      await storeUploadedCover(book.id, book.cover.url);
      freedBytes += book.cover.url.length;
      ids.push(book.id);
      moved += 1;
    } catch {
      // If IndexedDB is unavailable there is nowhere better to put it; leaving
      // the data URL where it is beats losing the cover entirely.
    }
  }

  return { moved, freedBytes, ids };
}

/** Ask the server to copy a cover in from a local path (Calibre imports). */
export async function storeLocalCoverOnServer(bookId, path, title) {
  if (!path) return false;
  return postCover(bookId, { path, title });
}

/** Whether a sync server is answering, for features that depend on one. */
export const hasServer = () => serverAvailable;
