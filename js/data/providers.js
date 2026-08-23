/**
 * Where book details and cover art come from.
 *
 * Open Library was the only source for a long time, and it is a good default —
 * no key, no quota, generous CORS, and a genuine public good. It is also
 * patchy: recent releases, translations, self-published titles and most comics
 * are either missing or hold a record with no art attached. A search that
 * silently returns nothing is the worst version of that, because it looks like
 * the app is broken rather than like the catalogue is thin.
 *
 * So sources are plural and swappable. Each one here answers the same two
 * questions — "what do you have for this ISBN" and "what do you have for these
 * words" — and hands back the same shape, so nothing downstream has to know
 * which catalogue a result came from.
 *
 * On Amazon, since it is the obvious thing to ask for: there is no way to do
 * it properly. Amazon's Product Advertising API needs an affiliate account
 * that has made qualifying sales, and the familiar `images-amazon.com/images/P/
 * <isbn>.jpg` trick is unsanctioned, increasingly answered with a placeholder,
 * and against their terms. Rather than ship something that breaks quietly and
 * borrows someone's bandwidth to do it, the cover picker takes a pasted URL —
 * which works with an Amazon image, a publisher's page, or anything else you
 * can right-click.
 */

/** @typedef {{title: string, author: string, pageCount: number|null,
 *   year: number|null, isbn: string, description: string, genre: string,
 *   coverUrl: string|null, source: string}} Found */

const OPEN_LIBRARY_SEARCH = 'https://openlibrary.org/search.json';
const OPEN_LIBRARY_COVER = 'https://covers.openlibrary.org/b';
const GOOGLE_BOOKS = 'https://www.googleapis.com/books/v1/volumes';
const APPLE_SEARCH = 'https://itunes.apple.com/search';

/** Hosts the sync server is willing to proxy. Keeps the proxy from being open. */
export const PROVIDER_HOSTS = [
  'openlibrary.org',
  'covers.openlibrary.org',
  'www.googleapis.com',
  'itunes.apple.com',
];

/** Blurbs arrive full of markup and boilerplate; strip it before storing. */
export function cleanDescription(raw) {
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

export const cleanIsbn = (isbn) => String(isbn ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();

const blank = {
  title: '', author: '', pageCount: null, year: null,
  isbn: '', description: '', genre: '', coverUrl: null,
  /** Open Library only: the work record a blurb can be fetched from. */
  workKey: null,
};

const shape = (source, fields) => ({ ...blank, ...fields, source });

/* --- Open Library ---------------------------------------------------------- */

const openLibraryDoc = (doc) =>
  shape('openlibrary', {
    title: doc.title ?? '',
    author: doc.author_name?.[0] ?? '',
    pageCount: doc.number_of_pages_median ?? null,
    year: doc.first_publish_year ?? null,
    isbn: doc.isbn?.[0] ?? '',
    // `first_sentence` is the opening line of the book, not a blurb, and it is
    // absent far more often than it is present. The real description lives on
    // the work record, which search does not return — see `describe`.
    description: cleanDescription(doc.first_sentence?.[0]),
    // `default=false` returns a 404 instead of a 1px placeholder, so a dead
    // cover falls through to the typeset spine instead of showing a grey dot.
    coverUrl: doc.cover_i ? `${OPEN_LIBRARY_COVER}/id/${doc.cover_i}-L.jpg` : null,
    // The work this edition belongs to, so the blurb can be fetched.
    workKey: typeof doc.key === 'string' && doc.key.startsWith('/works/') ? doc.key : null,
  });

const OPEN_LIBRARY_FIELDS =
  'key,title,author_name,number_of_pages_median,cover_i,isbn,first_publish_year,first_sentence';

const openlibrary = {
  id: 'openlibrary',
  label: 'Open Library',
  hint: 'Free and open, strongest on older and public domain titles.',
  covers: true,

  async byIsbn(isbn, fetchJson) {
    const data = await fetchJson(
      `${OPEN_LIBRARY_SEARCH}?q=isbn:${isbn}&limit=1&fields=${OPEN_LIBRARY_FIELDS}`
    );
    const doc = data?.docs?.[0];
    return doc ? { ...openLibraryDoc(doc), isbn: doc.isbn?.[0] ?? isbn } : null;
  },

  async search(query, limit, fetchJson) {
    const data = await fetchJson(
      `${OPEN_LIBRARY_SEARCH}?q=${encodeURIComponent(query)}&limit=${limit}` +
        `&fields=${OPEN_LIBRARY_FIELDS}`
    );
    return (data?.docs ?? []).map(openLibraryDoc);
  },

  /**
   * Fill in the blurb and the subjects, which search does not carry.
   *
   * This is the request that was missing. Open Library's search index holds
   * titles, authors, page counts and cover ids — but a book's description
   * lives on its *work* record, one level up from any edition, and is not a
   * field search will return however you ask for it. Without this second
   * request "get details" could look a book up, find it, and report that the
   * lookup had nothing the record was missing, while the blurb sat on a page
   * you could open in a browser and read.
   *
   * Subjects come back on the same record and stand in for a genre, which
   * Open Library does not have as a field at all.
   *
   * One extra request, made only when something is actually missing, and
   * failing soft: a work record that will not load leaves the result exactly
   * as it was.
   */
  async describe(result, fetchJson) {
    if (!result?.workKey) return result;
    if (result.description && result.genre) return result;

    try {
      const work = await fetchJson(`https://openlibrary.org${result.workKey}.json`);
      return {
        ...result,
        description: result.description || cleanDescription(work?.description),
        // Subjects run from the useful ("Manga") to the absurd ("Accessible
        // book"), and the first is reliably the most general. One is a genre;
        // twelve is a tag cloud.
        genre: result.genre || pickSubject(work?.subjects),
      };
    } catch {
      return result;
    }
  },

  /** Open Library serves cover art straight from an ISBN, with no lookup. */
  coverForIsbn(isbn, size = 'L') {
    return `${OPEN_LIBRARY_COVER}/isbn/${isbn}-${size}.jpg?default=false`;
  },
};

/**
 * Choose one subject to stand in for a genre.
 *
 * Open Library's subject lists are crowd-written and long. Cataloguing
 * artefacts ("Accessible book", "Protected DAISY", "Open Library Staff Picks")
 * say nothing about the book, and anything with a comma in it is a Library of
 * Congress heading rather than a word anyone would use.
 */
const SUBJECT_NOISE =
  /accessible book|protected daisy|in library|staff pick|internet archive|overdrive|large type|reading level|lending library|open library/i;

function pickSubject(subjects) {
  if (!Array.isArray(subjects)) return '';
  const usable = subjects
    .map((subject) => String(subject ?? '').trim())
    .filter((subject) => subject && subject.length < 40 && !SUBJECT_NOISE.test(subject))
    .filter((subject) => !subject.includes(','));
  return usable[0] ?? '';
}

/* --- Google Books ---------------------------------------------------------- */

function googleVolume(item) {
  const info = item?.volumeInfo;
  if (!info) return null;
  const links = info.imageLinks ?? {};
  const raw = links.thumbnail ?? links.smallThumbnail ?? null;
  const isbn = (info.industryIdentifiers ?? [])
    .find((entry) => entry.type === 'ISBN_13' || entry.type === 'ISBN_10')?.identifier;

  return shape('google', {
    title: info.title ?? '',
    author: info.authors?.[0] ?? '',
    pageCount: info.pageCount ?? null,
    year: Number.parseInt(String(info.publishedDate ?? '').slice(0, 4), 10) || null,
    isbn: cleanIsbn(isbn ?? ''),
    description: cleanDescription(info.description),
    genre: info.categories?.[0] ?? '',
    // Google's default thumbnails are http and drawn with a curled page edge;
    // ask for the flat https one, and for a size worth looking at.
    coverUrl: raw
      ? raw.replace(/^http:/, 'https:').replace('&edge=curl', '').replace('&zoom=1', '&zoom=2')
      : null,
  });
}

const google = {
  id: 'google',
  label: 'Google Books',
  hint: 'Broadest coverage of recent, translated and self-published books.',
  covers: true,

  async byIsbn(isbn, fetchJson) {
    const data = await fetchJson(`${GOOGLE_BOOKS}?q=isbn:${isbn}&maxResults=1`);
    return googleVolume(data?.items?.[0]);
  },

  async search(query, limit, fetchJson) {
    const data = await fetchJson(
      `${GOOGLE_BOOKS}?q=${encodeURIComponent(query)}&maxResults=${Math.min(limit, 40)}`
    );
    return (data?.items ?? []).map(googleVolume).filter(Boolean);
  },
};

/* --- Apple Books ----------------------------------------------------------- */

/**
 * Apple's store search. No key, and its artwork is the highest resolution of
 * the three, which makes it the one to reach for when a cover looks like a
 * postage stamp everywhere else.
 *
 * It has no ISBN index — searching an ISBN as free text returns whatever the
 * store thinks is close, which for a lookup meant to identify one edition is
 * worse than nothing. So `byIsbn` is absent and Apple only ever answers text
 * searches, where a wrong guess is on screen for you to reject.
 */
function appleResult(item) {
  return shape('apple', {
    title: item.trackName ?? item.collectionName ?? '',
    author: item.artistName ?? '',
    year: Number.parseInt(String(item.releaseDate ?? '').slice(0, 4), 10) || null,
    description: cleanDescription(item.description),
    genre: item.primaryGenreName ?? item.genres?.[0] ?? '',
    // artworkUrl100 is a template in all but name: the dimensions are part of
    // the path, and asking for 600 gets you 600.
    coverUrl: item.artworkUrl100
      ? String(item.artworkUrl100).replace(/\/\d+x\d+bb\./, '/600x600bb.')
      : null,
  });
}

const apple = {
  id: 'apple',
  label: 'Apple Books',
  hint: 'Large, clean artwork. Good for covers, thin on page counts.',
  covers: true,

  async search(query, limit, fetchJson) {
    const data = await fetchJson(
      `${APPLE_SEARCH}?term=${encodeURIComponent(query)}&entity=ebook&limit=${Math.min(limit, 25)}`
    );
    return (data?.results ?? []).map(appleResult).filter((result) => result.title);
  },
};

/* --- The registry ---------------------------------------------------------- */

export const PROVIDERS = { openlibrary, google, apple };

/** Tried in this order, and merged in this order when several answer. */
export const PROVIDER_ORDER = ['openlibrary', 'google', 'apple'];

/** The value meaning "ask all of them and merge what comes back". */
export const EVERY_SOURCE = 'auto';

export const SOURCE_CHOICES = [
  { id: EVERY_SOURCE, label: 'Every source', hint: 'Ask all of them and keep the best of each.' },
  ...PROVIDER_ORDER.map((id) => ({ id, label: PROVIDERS[id].label, hint: PROVIDERS[id].hint })),
];

/** Resolve a stored preference to the list of providers it means. */
export function providersFor(preference) {
  if (!preference || preference === EVERY_SOURCE) {
    return PROVIDER_ORDER.map((id) => PROVIDERS[id]);
  }
  const chosen = PROVIDERS[preference];
  // An unknown id — a setting synced from a newer version, say — falls back to
  // everything rather than to nothing.
  return chosen ? [chosen] : PROVIDER_ORDER.map((id) => PROVIDERS[id]);
}


/**
 * Fold several answers into one record.
 *
 * Field by field rather than picking a winner: Open Library knows page counts,
 * Google writes real blurbs, Apple has the best art, and taking the first
 * complete-looking result would throw away two thirds of what was found.
 *
 * `coverFrom` names the provider whose art wins when more than one has some,
 * because "which catalogue describes this book best" and "whose cover do I
 * want on my shelf" are different questions and deserve different answers.
 */
export function mergeFound(results, { coverFrom = EVERY_SOURCE } = {}) {
  const found = results.filter(Boolean);
  if (!found.length) return null;

  const first = (read) => found.map(read).find((value) => value != null && value !== '') ?? null;
  const byId = (id) => found.find((result) => result.source === id);

  // Blurbs are the one field where order is reversed: Google's are consistently
  // fuller than Open Library's opening sentence.
  const description =
    byId('google')?.description || first((r) => r.description) || '';

  const coverCandidates =
    coverFrom === EVERY_SOURCE ? found : [byId(coverFrom), ...found].filter(Boolean);
  const withCover = coverCandidates.find((result) => result.coverUrl);

  return {
    title: first((r) => r.title) ?? '',
    author: first((r) => r.author) ?? '',
    pageCount: first((r) => r.pageCount),
    year: first((r) => r.year),
    isbn: first((r) => r.isbn) ?? '',
    description,
    genre: first((r) => r.genre) ?? '',
    coverUrl: withCover?.coverUrl ?? null,
    source: withCover?.source ?? found[0].source,
    workKey: first((r) => r.workKey),
    // Kept so the UI can say where each half of an answer came from, rather
    // than making the user guess why a lookup produced a mismatched pair.
    sources: [...new Set(found.map((result) => result.source))],
  };
}

/**
 * Interleave several providers' search results, best-first, without repeats.
 *
 * Round-robin rather than concatenated: three providers concatenated means the
 * first one's six weakest matches sit above the second one's best one, and the
 * whole point of asking more than one catalogue is that the first might not
 * have the book.
 */
export function interleave(lists, limit) {
  const out = [];
  const seen = new Set();
  const depth = Math.max(0, ...lists.map((list) => list.length));

  for (let index = 0; index < depth && out.length < limit; index += 1) {
    for (const list of lists) {
      const result = list[index];
      if (!result?.title) continue;
      // Same book from two catalogues is one row, not two — but a different
      // edition with a different cover is worth keeping, so the key includes
      // neither the year nor the source.
      const key = `${result.title.toLowerCase()}|${result.author.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(result);
      if (out.length >= limit) break;
    }
  }

  return out;
}
