/**
 * Cover art lookup.
 *
 * Two providers, tried in order:
 *   Open Library — no key, no quota, generous CORS. First choice.
 *   Google Books — no key for basic volume search. Fills Open Library's gaps,
 *                  especially for recent and self-published titles.
 *
 * Both are third-party services that will be slow, rate-limited, or down at
 * some point, so every path here has a manual fallback and nothing blocks the
 * user from saving a book. A lookup is a convenience, never a requirement.
 */

const OPEN_LIBRARY_SEARCH = 'https://openlibrary.org/search.json';
const OPEN_LIBRARY_COVER = 'https://covers.openlibrary.org/b';
const GOOGLE_BOOKS = 'https://www.googleapis.com/books/v1/volumes';

const TIMEOUT_MS = 8000;

/** Uploaded covers are downscaled before storage — see `fileToCoverDataUrl`. */
const UPLOAD_MAX_WIDTH = 400;
const UPLOAD_QUALITY = 0.82;

/** @typedef {{title?: string, author?: string, pageCount?: number|null,
 *   coverUrl?: string|null, isbn?: string, description?: string,
 *   genre?: string, source: string}} CoverResult */

/** Blurbs arrive full of markup and boilerplate; strip it before storing. */
function cleanDescription(raw) {
  if (!raw) return '';
  const text = typeof raw === 'object' ? (raw.value ?? '') : String(raw);
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1')
    .replace(/\(\[?source[^)]*\)?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

/** fetch with a timeout, because a hung request is worse than a failed one. */
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const cleanIsbn = (isbn) => String(isbn ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();

/** Direct cover URL from an ISBN. Open Library serves these without a lookup. */
export function coverUrlForIsbn(isbn, size = 'L') {
  const clean = cleanIsbn(isbn);
  if (!clean) return null;
  // `default=false` returns 404 instead of a 1px placeholder, so the <img>
  // error handler can fall back to the typeset spine.
  return `${OPEN_LIBRARY_COVER}/isbn/${clean}-${size}.jpg?default=false`;
}

/**
 * Look a book up by ISBN across both providers.
 * @param {string} isbn
 * @returns {Promise<CoverResult|null>}
 */
export async function lookupByIsbn(isbn) {
  const clean = cleanIsbn(isbn);
  if (![10, 13].includes(clean.length)) {
    throw new Error('An ISBN is 10 or 13 characters.');
  }

  const [openLibrary, google] = await Promise.allSettled([
    fetchJson(`${OPEN_LIBRARY_SEARCH}?q=isbn:${clean}&limit=1&fields=title,author_name,number_of_pages_median,cover_i,isbn,first_sentence`),
    fetchJson(`${GOOGLE_BOOKS}?q=isbn:${clean}&maxResults=1`),
  ]);

  const fromOl = openLibrary.status === 'fulfilled' ? parseOpenLibrary(openLibrary.value) : null;
  const fromGb = google.status === 'fulfilled' ? parseGoogle(google.value) : null;

  if (!fromOl && !fromGb) return null;

  // Merge: prefer whichever provider actually has each field, rather than
  // making one of them win outright and dropping good data.
  // Google's blurbs are consistently fuller than Open Library's, so it wins
  // this field even though Open Library wins the others.
  const description = fromGb?.description || fromOl?.description || '';

  return {
    title: fromOl?.title || fromGb?.title || '',
    author: fromOl?.author || fromGb?.author || '',
    pageCount: fromOl?.pageCount ?? fromGb?.pageCount ?? null,
    coverUrl: fromOl?.coverUrl || fromGb?.coverUrl || coverUrlForIsbn(clean),
    description,
    genre: fromGb?.genre || '',
    isbn: clean,
    source: fromOl?.coverUrl ? 'openlibrary' : fromGb?.coverUrl ? 'google' : 'openlibrary',
  };
}

/**
 * Search by title / author when there's no ISBN to hand.
 * @returns {Promise<CoverResult[]>} up to `limit` candidates
 */
export async function searchByText(query, limit = 6) {
  const term = String(query ?? '').trim();
  if (term.length < 2) return [];

  const data = await fetchJson(
    `${OPEN_LIBRARY_SEARCH}?q=${encodeURIComponent(term)}&limit=${limit}` +
      '&fields=title,author_name,number_of_pages_median,cover_i,isbn,first_publish_year'
  );

  return (data?.docs ?? [])
    .map((doc) => ({
      title: doc.title ?? '',
      author: doc.author_name?.[0] ?? '',
      pageCount: doc.number_of_pages_median ?? null,
      year: doc.first_publish_year ?? null,
      isbn: doc.isbn?.[0] ?? '',
      description: cleanDescription(doc.first_sentence?.[0]),
      coverUrl: doc.cover_i ? `${OPEN_LIBRARY_COVER}/id/${doc.cover_i}-M.jpg` : null,
      key: doc.key ?? null,
      source: 'openlibrary',
    }))
    .filter((result) => result.title);
}

function parseOpenLibrary(data) {
  const doc = data?.docs?.[0];
  if (!doc) return null;
  return {
    title: doc.title ?? '',
    author: doc.author_name?.[0] ?? '',
    pageCount: doc.number_of_pages_median ?? null,
    description: cleanDescription(doc.first_sentence?.[0]),
    coverUrl: doc.cover_i ? `${OPEN_LIBRARY_COVER}/id/${doc.cover_i}-L.jpg` : null,
  };
}

function parseGoogle(data) {
  const info = data?.items?.[0]?.volumeInfo;
  if (!info) return null;
  const links = info.imageLinks ?? {};
  const raw = links.thumbnail ?? links.smallThumbnail ?? null;
  return {
    title: info.title ?? '',
    author: info.authors?.[0] ?? '',
    pageCount: info.pageCount ?? null,
    description: cleanDescription(info.description),
    genre: info.categories?.[0] ?? '',
    // Google's default thumbnails are http and curled; ask for the flat, https one.
    coverUrl: raw ? raw.replace(/^http:/, 'https:').replace('&edge=curl', '') : null,
  };
}

/**
 * Turn an uploaded image into a storage-safe data URL.
 *
 * localStorage gives us a few megabytes total for the entire library, so a
 * handful of full-resolution phone photos would fill it and start throwing
 * quota errors on unrelated saves. Downscaling to 400px wide JPEG puts a cover
 * at roughly 20-40 KB — good enough for a 34px calendar tile and a detail
 * panel, small enough that hundreds of them fit.
 *
 * @param {File} file
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
