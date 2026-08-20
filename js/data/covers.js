/**
 * Cover and metadata lookup.
 *
 * The catalogues themselves live in `providers.js`. This module is the part
 * that decides *which* of them to ask, gets the request out of the browser in
 * one piece, and turns an uploaded file into something small enough to store.
 *
 * Two settings drive it, both chosen in Settings and passed in here at boot:
 * where details come from and where art comes from. They are separate because
 * they genuinely differ — Open Library knows the page count of a 1937 printing
 * and Apple has the only cover of it worth looking at.
 *
 * Every third-party service will be slow, rate-limited or down at some point,
 * so nothing here blocks saving a book. A lookup is a convenience, never a
 * requirement.
 */

import {
  PROVIDERS, PROVIDER_ORDER, EVERY_SOURCE, providersFor, mergeFound, interleave,
  cleanIsbn, cleanDescription,
} from './providers.js';
import { hasServer } from './coverCache.js';

const TIMEOUT_MS = 8000;

/** Uploaded covers are downscaled before storage — see `fileToCoverDataUrl`. */
const UPLOAD_MAX_WIDTH = 400;
const UPLOAD_QUALITY = 0.82;

export { PROVIDERS, PROVIDER_ORDER, EVERY_SOURCE, cleanDescription };

/* --- Which sources to use -------------------------------------------------- */

let sources = { metadata: EVERY_SOURCE, covers: EVERY_SOURCE };

/**
 * Point lookups at the chosen catalogues.
 *
 * Called at boot and whenever the setting changes, rather than read from the
 * store here: this module is imported by tests and by the enrichment loop,
 * neither of which should need a populated store to run.
 */
export function configureSources(next = {}) {
  sources = {
    metadata: next.metadata || EVERY_SOURCE,
    covers: next.covers || EVERY_SOURCE,
  };
  return sources;
}


/**
 * The providers to ask for a given lookup.
 *
 * The union of both settings, because one request answers both questions: if
 * details come from Open Library and art from Apple, asking only Open Library
 * would leave every cover empty.
 */
function activeProviders() {
  const wanted = new Map();
  for (const provider of providersFor(sources.metadata)) wanted.set(provider.id, provider);
  for (const provider of providersFor(sources.covers)) wanted.set(provider.id, provider);
  return PROVIDER_ORDER.map((id) => wanted.get(id)).filter(Boolean);
}

/* --- Getting the request out ------------------------------------------------ */

/**
 * Some catalogues answer a browser directly and some do not, and which is
 * which changes without notice. When the sync server is running it will make
 * the call on our behalf, which sidesteps CORS entirely; when it isn't, we go
 * direct and accept that a provider may refuse.
 */
const throughServer = (url) => `api/lookup?url=${encodeURIComponent(url)}`;

/** fetch with a timeout, because a hung request is worse than a failed one. */
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const target = hasServer() ? throughServer(url) : url;
    const response = await fetch(target, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* --- Lookups ---------------------------------------------------------------- */

/** Direct cover URL from an ISBN. Open Library serves these without a lookup. */
export function coverUrlForIsbn(isbn, size = 'L') {
  const clean = cleanIsbn(isbn);
  if (!clean) return null;
  return PROVIDERS.openlibrary.coverForIsbn(clean, size);
}

/**
 * Look a book up by ISBN across every active provider.
 * @param {string} isbn
 * @returns {Promise<object|null>}
 */
export async function lookupByIsbn(isbn) {
  const clean = cleanIsbn(isbn);
  if (![10, 13].includes(clean.length)) {
    throw new Error('An ISBN is 10 or 13 characters.');
  }

  // Apple has no ISBN index, so it sits this one out — see providers.js.
  const asked = activeProviders().filter((provider) => provider.byIsbn);
  const settled = await Promise.allSettled(
    asked.map((provider) => provider.byIsbn(clean, fetchJson))
  );

  const found = settled
    .map((result) => (result.status === 'fulfilled' ? result.value : null))
    .filter(Boolean);

  let merged = mergeFound(found, { coverFrom: sources.covers });
  if (!merged) return null;

  // Open Library's search index has no description in it. If nothing else
  // supplied one, go and get it from the work record — the request that turns
  // "found the book, nothing to add" into an actual blurb.
  if (!merged.description || !merged.genre) {
    merged = await PROVIDERS.openlibrary.describe(merged, fetchJson).catch(() => merged);
  }

  return {
    ...merged,
    isbn: merged.isbn || clean,
    // A record with no art of its own can still fall back to Open Library's
    // ISBN endpoint, which is a different index from its search results.
    coverUrl: merged.coverUrl ?? coverUrlForIsbn(clean),
    source: merged.coverUrl ? merged.source : 'openlibrary',
  };
}

/**
 * Search by title / author when there's no ISBN to hand.
 *
 * This is the path that used to come back empty: one catalogue, and if it had
 * never heard of the book that was the end of it. Asking all of them and
 * interleaving what returns is most of the difference between "no results" and
 * a shelf of covers to choose from.
 *
 * @returns {Promise<object[]>} up to `limit` candidates, best-first
 */
export async function searchByText(query, limit = 6) {
  const term = String(query ?? '').trim();
  if (term.length < 2) return [];

  const asked = activeProviders();
  const settled = await Promise.allSettled(
    asked.map((provider) => provider.search(term, limit, fetchJson))
  );

  // Every provider refusing is a failure worth reporting; some of them
  // refusing is a Tuesday.
  if (settled.length && settled.every((result) => result.status === 'rejected')) {
    throw settled[0].reason ?? new Error('No source answered.');
  }

  const lists = settled.map((result) => (result.status === 'fulfilled' ? result.value : []));
  return interleave(lists, limit).filter((result) => result.title);
}

/**
 * Fill in what a search result left out.
 *
 * Search returns as much as an index can hold, which for Open Library does not
 * include the blurb. Fetching it for all six results of a search would be six
 * requests to show a grid of covers nobody has chosen from yet, so it happens
 * once, for the one result that is actually going to be used.
 */
export async function describeResult(result) {
  if (!result || result.source !== 'openlibrary') return result;
  if (result.description && result.genre) return result;
  try {
    return await PROVIDERS.openlibrary.describe(result, fetchJson);
  } catch {
    return result;
  }
}

/**
 * Accept a cover URL somebody pasted in.
 *
 * The escape hatch for every catalogue being wrong, and the honest answer to
 * "can we use Amazon" — right-click, copy image address, paste. Validated
 * enough to catch a page URL pasted by mistake, not so strictly that a URL
 * without a file extension is refused, because plenty of real image URLs have
 * none.
 */
export function normalizeCoverUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Paste an image address first.');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('That does not look like a web address.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('A cover address has to start with http or https.');
  }
  if (/\.(html?|php|aspx?)$/i.test(parsed.pathname)) {
    throw new Error('That is a page, not an image. Right-click the cover itself and copy its image address.');
  }

  return parsed.toString();
}

/* --- Uploads ---------------------------------------------------------------- */

/**
 * Turn an uploaded image into a storage-safe data URL.
 *
 * localStorage gives us a few megabytes total for the entire library, so a
 * handful of full-resolution phone photos would fill it and start throwing
 * quota errors on unrelated saves. Downscaling to 400px wide JPEG puts a cover
 * at roughly 20-40 KB — good enough for a 34px calendar tile and a detail
 * panel, small enough that hundreds of them fit.
 *
 * @param {File|Blob} file
 * @returns {Promise<string>} data URL
 */
export function fileToCoverDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('That file is not an image.'));
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      reject(new Error('That image is over 12 MB. Try a smaller one.'));
      return;
    }

    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, UPLOAD_MAX_WIDTH / image.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);

      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

      try {
        resolve(canvas.toDataURL('image/jpeg', UPLOAD_QUALITY));
      } catch (error) {
        reject(new Error('That image could not be processed.'));
      }
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That image could not be read.'));
    };

    image.src = url;
  });
}
