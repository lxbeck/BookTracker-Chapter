/**
 * Filling in what's missing.
 *
 * Imports arrive incomplete — a Calibre catalogue has no page count, a
 * hand-typed book has no blurb — and looking each one up by hand is the kind
 * of chore that stops people cataloguing at all.
 *
 * The rule is strict and one-directional: **only empty fields are filled.**
 * Anything you typed wins over anything a lookup returns, always. A page count
 * you corrected by hand must never be silently replaced by a different
 * edition's, because every pacing figure in the app is derived from it.
 */

import { lookupByIsbn, searchByText, describeResult, coverUrlForIsbn } from './covers.js';
// One definition of "nothing here yet", shared with the import filler. Two
// copies of this rule drifting apart is how a zero page count becomes a real
// length in one code path and a gap in the other.
import { isEmpty } from './fill.js';

/**
 * What a lookup could add to this book.
 * @returns {string[]} field names that are currently empty
 */
export function missingFields(book) {
  const gaps = [];
  if (isEmpty(book.pageCount)) gaps.push('length');
  if (isEmpty(book.description)) gaps.push('description');
  if (isEmpty(book.author)) gaps.push('author');
  if (isEmpty(book.genre)) gaps.push('genre');
  if (isEmpty(book.cover?.url)) gaps.push('cover');
  if (isEmpty(book.isbn)) gaps.push('ISBN');
  return gaps;
}

export const needsDetails = (book) => missingFields(book).length > 0;

/**
 * Look a book up and return a patch of only-missing fields.
 *
 * Searches by ISBN when there is one, since that identifies an edition and so
 * gets the page count right; falls back to title and author, which finds the
 * work but may return a different edition's length.
 *
 * @returns {Promise<{ok: boolean, patch: object, filled: string[], reason?: string}>}
 */
export async function fetchMissingDetails(book) {
  const gaps = missingFields(book);
  if (!gaps.length) return { ok: true, patch: {}, filled: [], reason: 'Nothing missing.' };

  /** Every answer we manage to get, best identifier first. */
  const answers = [];
  const tried = [];
  let failure = null;

  if (book.isbn) {
    tried.push('the ISBN');
    try {
      const found = await lookupByIsbn(book.isbn);
      if (found) answers.push(found);
    } catch (error) {
      failure = error.message;
    }
  }

  // A second look, by title, whenever the first left something out.
  //
  // An ISBN identifies one edition, and an edition that nobody has catalogued
  // fully is a dead end: a regional printing may be in the index with a title
  // and nothing else, while the work everyone else owns has a blurb, a page
  // count and a cover. Stopping at the ISBN meant reporting "the lookup had
  // nothing this book was missing" while the description sat one search away.
  const stillMissing = (field) =>
    gaps.includes(field) && !answers.some((answer) => !isEmpty(answer[fieldKey(field)]));

  const wantsMore = gaps.some((gap) => stillMissing(gap));

  if (wantsMore && book.title) {
    tried.push('the title');
    try {
      const matches = await searchByText([book.title, book.author].filter(Boolean).join(' '), 3);
      const best = matches[0];
      if (best) {
        // A text search finds the work rather than the edition, so its page
        // count belongs to some printing and not necessarily to yours. Good
        // enough to offer when the field is empty, which is the only time it
        // is ever used, and never good enough to claim as this book's ISBN.
        const described = await describeResult(best);
        answers.push({ ...described, isbn: '' });
      }
    } catch (error) {
      failure ??= error.message;
    }
  }

  if (!answers.length) {
    return {
      ok: false,
      patch: {},
      filled: [],
      reason: failure
        ? `The lookup service did not respond: ${failure}`
        : `No match for this book by ${tried.join(' or ') || 'title'}.`,
    };
  }

  const patch = {};
  const filled = [];

  /** First answer that actually has the field wins; earlier answers rank higher. */
  const bestValue = (key) => {
    for (const answer of answers) {
      if (!isEmpty(answer[key])) return answer[key];
    }
    return null;
  };

  const take = (field, value, label = field) => {
    if (isEmpty(value)) return;
    patch[field] = value;
    filled.push(label);
  };

  if (isEmpty(book.pageCount)) take('pageCount', bestValue('pageCount'), 'length');
  if (isEmpty(book.description)) take('description', bestValue('description'), 'description');
  if (isEmpty(book.author)) take('author', bestValue('author'), 'author');
  if (isEmpty(book.genre)) take('genre', bestValue('genre'), 'genre');
  if (isEmpty(book.isbn)) {
    const isbn = bestValue('isbn');
    if (isbn) take('isbn', isbn, 'ISBN');
  }

  if (isEmpty(book.cover?.url)) {
    const withCover = answers.find((answer) => answer.coverUrl);
    const url =
      withCover?.coverUrl ?? (book.isbn ? coverUrlForIsbn(book.isbn, 'L') : null);
    if (url) {
      patch.cover = { url, source: withCover?.source ?? 'openlibrary' };
      filled.push('cover');
    }
  }

  return {
    ok: filled.length > 0,
    patch,
    filled,
    // Naming the gap that survived is the difference between a message you can
    // act on and one that reads as a shrug. "No description in any catalogue"
    // tells you to write your own; "the lookup had nothing" does not.
    reason: filled.length
      ? ''
      : `Found this book, but no ${gaps.join(' or ')} in any catalogue searched.`,
  };
}

/** Result keys are not always named after the field they fill. */
const fieldKey = (gap) =>
  ({ length: 'pageCount', cover: 'coverUrl', ISBN: 'isbn' })[gap] ?? gap;

/**
 * Enrich many books, one at a time.
 *
 * Sequential with a pause between: Open Library is a free service run on
 * donations, and firing four hundred parallel requests at it is both rude and
 * the fastest way to get every one of them refused.
 *
 * @param {object[]} books
 * @param {(result: {book: object, patch: object, filled: string[], index: number}) => void} onResult
 * @param {{signal?: AbortSignal, delayMs?: number}} [options]
 */
export async function enrichAll(books, onResult, { signal, delayMs = 250 } = {}) {
  let filledCount = 0;
  let missed = 0;

  for (const [index, book] of books.entries()) {
    if (signal?.aborted) break;

    const result = await fetchMissingDetails(book);
    if (result.ok) filledCount += 1;
    else missed += 1;

    onResult({ book, patch: result.patch, filled: result.filled, index });

    if (index < books.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { filled: filledCount, missed, total: books.length };
}
