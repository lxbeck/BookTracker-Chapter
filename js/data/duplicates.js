/**
 * The same book, twice.
 *
 * Libraries collect duplicates the way drawers collect keys. An import runs
 * before an ISBN is filled in and matches nothing; a book is catalogued by
 * hand on a phone and again on a laptop before sync is set up; a series is
 * added under "Vol. 1" once and "Volume 1" the next time. None of these is
 * anyone's mistake exactly, and all of them cost the same thing: a reading log
 * split across two records, so neither one is true.
 *
 * Finding them is the easy half. Merging them without losing anything is the
 * half that has to be right, because there is no undo for a book you deleted
 * on the assumption its sessions were already somewhere else.
 */

import { sessionPages } from './schema.js';

/**
 * Reduce a title to the part that identifies it.
 *
 * Volume markers are normalised rather than removed: "Vol. 1", "Volume 1" and
 * "v1" are the same book, while volumes 1 and 2 are emphatically not, so the
 * number has to survive. Subtitles after a colon are kept, since "Rachel
 * Rising Vol. 1: Shadow of Death" and "Rachel Rising Vol. 2: Fear No Malus"
 * would otherwise collapse into one.
 */
export function titleKey(title) {
  return String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(vol|volume|v)\.?\s*(\d+)/g, 'vol$2')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Authors are written every which way; compare the surname. */
export function authorKey(author) {
  const clean = String(author ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s,.]/g, ' ')
    .trim();
  if (!clean) return '';

  // "Herbert, Frank" and "Frank Herbert" are one person written two ways.
  const surname = clean.includes(',')
    ? clean.split(',')[0]
    : clean.split(/\s+/).filter(Boolean).pop();

  return String(surname ?? '').replace(/\./g, '').trim();
}

/**
 * Every set of records that look like the same book.
 *
 * Three rules, each reported so the reason can be shown rather than asserted:
 *
 *   isbn   the same ISBN is the same edition, whatever the titles say
 *   both   same title and same author, the everyday case
 *   title  same title where only one of them names an author — enough to
 *          raise, never enough to merge without being asked
 *
 * Deliberately *not* fuzzy beyond this. A near-match finder that suggests
 * merging two volumes of a series is worse than no finder at all, because the
 * one thing worse than a split reading log is a merged one.
 *
 * @param {object[]} books
 * @returns {{reason: string, books: object[]}[]}
 */
/**
 * A stable name for a set of records, so a dismissal can outlive the session.
 *
 * Built from the ids rather than from the titles: "not duplicates" is a
 * judgement about *these two records*, and a title edited afterwards must not
 * bring the question back.
 */
export const groupKey = (books) => books.map((book) => book.id).sort().join('|');

/**
 * @param {object[]} books
 * @param {{dismissed?: string[]}} [options] - group keys already judged
 */
export function findDuplicates(books, { dismissed = [] } = {}) {
  const groups = new Map();

  const add = (key, reason, book) => {
    if (!groups.has(key)) groups.set(key, { reason, books: [] });
    groups.get(key).books.push(book);
  };

  for (const book of books) {
    const isbn = String(book.isbn ?? '').trim();
    if (isbn) add(`isbn:${isbn}`, 'isbn', book);

    // Not an `else`. A record grouped by ISBN still has to be grouped by
    // title, because the commonest duplicate of all is a book catalogued
    // twice where only one of the copies ever got an ISBN — an import that
    // ran before the field was filled in, matching nothing and adding a
    // second record. Stopping at the ISBN made exactly that case invisible.
    const title = titleKey(book.title);
    if (!title) continue;

    const author = authorKey(book.author);
    add(author ? `both:${title}|${author}` : `title:${title}`, author ? 'both' : 'title', book);
  }

  // A group whose books are all inside a larger one says nothing new: two
  // copies matched by both ISBN and title should be reported once.
  const raw = [...groups.values()].filter((group) => group.books.length > 1);
  const found = raw.filter(
    (group) =>
      !raw.some(
        (other) =>
          other !== group &&
          other.books.length >= group.books.length &&
          group.books.every((book) => other.books.includes(book)) &&
          // Keep the ISBN reading of an identical pair, since it is the
          // stronger claim and the better thing to show.
          (other.books.length > group.books.length || other.reason === 'isbn')
      )
  );

  // A book with no author matches a titled group it would otherwise miss —
  // caught here rather than in the loop above, so an untitled record cannot
  // pull two properly distinct books together.
  const titled = new Map();
  for (const book of books) {
    const title = titleKey(book.title);
    if (!title) continue;
    if (!titled.has(title)) titled.set(title, []);
    titled.get(title).push(book);
  }

  for (const [title, run] of titled) {
    if (run.length < 2) continue;
    const authors = new Set(run.map((book) => authorKey(book.author)));
    // Only interesting when some name an author and some do not; a run where
    // every author differs is a title collision, not a duplicate.
    if (!authors.has('') || authors.size < 2) continue;

    const already = found.some((group) =>
      run.every((book) => group.books.includes(book))
    );
    if (!already) found.push({ reason: 'title', books: run });
  }

  const ignored = new Set(dismissed);

  return found
    .map((group) => ({
      ...group,
      books: [...group.books].sort((a, b) => completeness(b) - completeness(a)),
    }))
    .map((group) => ({ ...group, key: groupKey(group.books) }))
    // A pair you have already said is not a duplicate stays not a duplicate.
    // Keeping that judgement only in memory meant it survived until the next
    // reload and then asked again, which is worse than never having asked.
    .filter((group) => !ignored.has(group.key));
}

/**
 * How much a record actually holds.
 *
 * Used to pick which copy survives a merge. A reading log outweighs everything
 * — it is the only part that cannot be fetched again from a catalogue — and
 * after that it is simply how many fields have something in them.
 */
export function completeness(book) {
  const sessions = book.sessions?.length ?? 0;
  const fields = [
    book.author, book.isbn, book.pageCount, book.description, book.genre,
    book.notes, book.series?.name, book.cover?.url, book.rating,
  ].filter((value) => value != null && value !== '' && value !== 0).length;

  const dated = [book.schedule?.start, book.actual?.finishedAt].filter(Boolean).length;

  return sessions * 100 + fields * 10 + dated * 5 + book.shelves.length;
}

/** Two sittings are the same sitting if everything about them matches. */
const sessionKey = (session) =>
  `${session.date}|${session.minutes ?? ''}|${session.pageFrom ?? ''}|${session.pageTo ?? ''}`;

/**
 * How to fold a group of duplicates into one record.
 *
 * The survivor keeps everything it has; the others contribute only what it is
 * missing. Reading logs are the exception and are combined, because a session
 * is a fact about an evening and belongs to the book however many records were
 * open at the time — which is the entire reason merging beats deleting.
 *
 * Returns a plan rather than performing it, so the same calculation can be
 * shown to the person before anything is destroyed.
 *
 * @param {object[]} group - most complete first
 * @returns {{survivor: object, absorbed: object[], patch: object, gains: string[]}}
 */
export function mergePlan(group) {
  const [survivor, ...absorbed] = [...group].sort((a, b) => completeness(b) - completeness(a));
  const patch = {};
  const gains = [];

  const empty = (value) => value == null || value === '' || value === 0;

  const fillFrom = (path, label) => {
    const read = (book) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), book);
    if (!empty(read(survivor))) return;

    const donor = absorbed.find((book) => !empty(read(book)));
    if (!donor) return;

    const [head, tail] = path.split('.');
    if (tail) patch[head] = { ...(patch[head] ?? survivor[head]), [tail]: read(donor) };
    else patch[head] = read(donor);
    gains.push(label);
  };

  for (const [path, label] of [
    ['author', 'author'], ['isbn', 'ISBN'], ['pageCount', 'length'],
    ['description', 'description'], ['genre', 'genre'], ['notes', 'notes'],
    ['rating', 'rating'], ['series.name', 'series'], ['series.number', 'series number'],
    ['cover.url', 'cover'],
  ]) {
    fillFrom(path, label);
  }

  // Sessions from every copy, in date order, with exact repeats dropped —
  // importing the same backup twice should not double an evening's reading.
  const seen = new Set();
  const sessions = [];
  for (const book of [survivor, ...absorbed]) {
    for (const session of book.sessions ?? []) {
      const key = sessionKey(session);
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push(session);
    }
  }
  sessions.sort((a, b) => a.date.localeCompare(b.date));

  if (sessions.length > (survivor.sessions?.length ?? 0)) {
    patch.sessions = sessions;
    const extra = sessions.length - (survivor.sessions?.length ?? 0);
    gains.push(`${extra} reading ${extra === 1 ? 'session' : 'sessions'}`);
  }

  // Tags are a set; every copy's contribute.
  const shelves = [...new Set([survivor, ...absorbed].flatMap((book) => book.shelves ?? []))];
  if (shelves.length > survivor.shelves.length) {
    patch.shelves = shelves;
    gains.push('tags');
  }

  // Progress is the furthest anyone got, which is the same rule the app uses
  // within a single book's log.
  const furthest = Math.max(
    ...[survivor, ...absorbed].map((book) =>
      Math.max(
        book.progress?.page ?? 0,
        ...(book.sessions ?? []).map((session) => session.pageTo ?? sessionPages(session) ?? 0)
      )
    )
  );
  if (furthest > (survivor.progress?.page ?? 0)) {
    patch.progress = { ...survivor.progress, page: furthest };
    gains.push('progress');
  }

  // A finish date on any copy means the book was finished.
  const finished = [survivor, ...absorbed]
    .map((book) => book.actual?.finishedAt)
    .filter(Boolean)
    .sort()[0];
  if (finished && !survivor.actual?.finishedAt) {
    patch.actual = { ...survivor.actual, finishedAt: finished };
    patch.status = 'finished';
    gains.push('finish date');
  }

  return { survivor, absorbed, patch, gains };
}
