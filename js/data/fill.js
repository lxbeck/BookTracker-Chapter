/**
 * Filling in the gaps from an import.
 *
 * An import that finds a book already in the library used to skip it outright.
 * That is the safe answer and the wrong one: the reason to re-export a
 * catalogue after spending an evening writing descriptions into Calibre is
 * precisely that the books are already here and the descriptions are not.
 * "Already have it" answers a question nobody asked.
 *
 * So a second import fills. The rule is the same one enrichment uses, and it
 * is strict and one-directional: **only empty fields are written.** Anything
 * already in the record wins over anything arriving, always. A page count you
 * corrected by hand must never be replaced by a catalogue's, because every
 * pacing figure in the app is derived from it, and a description you rewrote
 * must not be reverted by the publisher's blurb.
 *
 * Two fields break that pattern deliberately, and both are additive rather
 * than destructive:
 *   shelves — tags are a set, so new ones are added and none are removed
 *   cover   — filled only when there is no art at all
 */

/** Treated as "nothing here yet". A zero page count is missing, not zero. */
export const isEmpty = (value) =>
  value == null ||
  value === '' ||
  value === 0 ||
  (Array.isArray(value) && value.length === 0);

/**
 * The fields an import may fill, in the order they are reported.
 *
 * Status, format and category are absent on purpose. Every importer guesses
 * them — a Calibre catalogue has no reading status at all — and a guess must
 * not overwrite a decision, even a default one. There is no way to tell a book
 * you deliberately marked as a physical copy from one that was never touched.
 */
export const FILLABLE = [
  { path: 'author', label: 'author' },
  { path: 'isbn', label: 'ISBN' },
  { path: 'pageCount', label: 'length' },
  { path: 'description', label: 'description' },
  { path: 'genre', label: 'genre' },
  { path: 'series.name', label: 'series' },
  { path: 'series.number', label: 'series number' },
  { path: 'series.total', label: 'series length' },
  { path: 'notes', label: 'notes' },
];

const read = (record, path) =>
  path.split('.').reduce((value, key) => (value == null ? value : value[key]), record);

/** Build the one-level-deep patch shape `updateBook` merges correctly. */
function write(patch, path, value) {
  const [head, tail] = path.split('.');
  if (!tail) {
    patch[head] = value;
    return;
  }
  patch[head] = { ...(patch[head] ?? {}), [tail]: value };
}

/**
 * What an incoming record could add to one already here.
 *
 * @param {object} existing - the book in the library
 * @param {object} incoming - the parsed row
 * @param {{cover?: boolean}} [options] - whether art is available to fill with
 * @returns {{patch: object, filled: string[]}} an empty patch means nothing was missing
 */
export function fillMissing(existing, incoming, { cover = false } = {}) {
  const patch = {};
  const filled = [];

  for (const { path, label } of FILLABLE) {
    if (!isEmpty(read(existing, path))) continue;

    const value = read(incoming, path);
    if (isEmpty(value)) continue;

    write(patch, path, value);
    filled.push(label);
  }

  // Tags are a set, not a value: a catalogue that knows this book is also
  // "borrowed" should be able to say so without erasing "to reread".
  const incomingShelves = Array.isArray(incoming.shelves) ? incoming.shelves : [];
  const newShelves = incomingShelves.filter(
    (shelf) => shelf && !existing.shelves.includes(shelf)
  );
  if (newShelves.length) {
    patch.shelves = [...existing.shelves, ...newShelves];
    filled.push(newShelves.length === 1 ? 'a tag' : `${newShelves.length} tags`);
  }

  if (cover && isEmpty(existing.cover?.url)) filled.push('cover');

  return { patch, filled };
}

/**
 * Find the record an imported row is about.
 *
 * Three rules, narrowing. An ISBN identifies an edition and is trusted first.
 * Title and author together is the everyday case. Title alone is allowed only
 * when exactly one book carries it and one of the two authors is blank —
 * which is what a comic catalogued by hand and then exported from Calibre
 * actually looks like, and is still specific enough not to merge two different
 * books that happen to share a name.
 *
 * `incoming.authors` is checked as well as `incoming.author`, because
 * catalogues disagree about the order of a collaboration. The same graphic
 * novel is "Fábio Moon & Terry Moore" in one and "Terry Moore" in the other,
 * and matching only the first credit files it twice.
 *
 * @param {object[]} library
 * @param {object} incoming
 * @returns {object|null}
 */
export function matchExisting(library, incoming) {
  const title = String(incoming.title ?? '').trim().toLowerCase();
  if (!title) return null;

  const lower = (value) => String(value ?? '').trim().toLowerCase();
  const credits = [incoming.author, ...(incoming.authors ?? [])].map(lower).filter(Boolean);
  const isbn = String(incoming.isbn ?? '').trim();

  if (isbn) {
    const byIsbn = library.find((book) => book.isbn && book.isbn === isbn);
    if (byIsbn) return byIsbn;
  }

  const sameTitle = library.filter((book) => lower(book.title) === title);
  if (!sameTitle.length) return null;

  const byAuthor = sameTitle.find((book) => credits.includes(lower(book.author)));
  if (byAuthor) return byAuthor;

  if (sameTitle.length === 1) {
    const known = lower(sameTitle[0].author);
    if (!known || !credits.length) return sameTitle[0];
  }

  return null;
}
