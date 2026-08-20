/**
 * Enrichment: what counts as missing, and the guarantee that a lookup can
 * never overwrite something you entered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBook } from '../js/data/schema.js';
import { missingFields, needsDetails, fetchMissingDetails } from '../js/data/enrich.js';

const book = (props) => normalizeBook({ title: 'A Book', ...props }, '2026-08-11');

test('an empty field is missing; a filled one is not', () => {
  const bare = book({});
  assert.deepEqual(missingFields(bare).sort(), ['ISBN', 'author', 'cover', 'description', 'genre', 'length']);

  const complete = book({
    author: 'Someone', isbn: '9780486266886', pageCount: 245,
    genre: 'Fantasy', description: 'A blurb.', cover: { url: 'https://x/y.jpg' },
  });
  assert.deepEqual(missingFields(complete), []);
  assert.ok(!needsDetails(complete));
});

test('a zero page count counts as missing, not as a real length', () => {
  assert.ok(missingFields(book({ pageCount: 0 })).includes('length'));
});

/** A fake lookup, so the test never touches the network. */
function withStubbedLookup(response, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('openlibrary') ? response.openLibrary : response.google),
  });
  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

const OPEN_LIBRARY = {
  docs: [{
    title: 'The Strange Case of Dr Jekyll and Mr Hyde', author_name: ['Robert Louis Stevenson'],
    number_of_pages_median: 245, cover_i: 123,
    first_sentence: ['The Beauty of the House is immeasurable.'],
  }],
};
const GOOGLE = {
  items: [{ volumeInfo: {
    title: 'The Strange Case of Dr Jekyll and Mr Hyde', authors: ['Robert Louis Stevenson'], pageCount: 272,
    description: 'A man lives alone in an endless house.',
    categories: ['Fiction'], imageLinks: { thumbnail: 'http://books.google/x&edge=curl' },
  } }],
};

test('a lookup fills only the empty fields', async () => {
  const partial = book({
    isbn: '9780486266886',
    author: 'My Own Spelling',
    pageCount: 999,
  });

  await withStubbedLookup({ openLibrary: OPEN_LIBRARY, google: GOOGLE }, async () => {
    const result = await fetchMissingDetails(partial);
    assert.ok(result.ok, result.reason);

    assert.equal(result.patch.author, undefined, 'an entered author must not be replaced');
    assert.equal(result.patch.pageCount, undefined, 'an entered page count must not be replaced');
    assert.ok(result.patch.description, 'the empty description should be filled');
    assert.ok(result.patch.cover?.url, 'the empty cover should be filled');
    assert.ok(result.filled.includes('description'));
    assert.ok(!result.filled.includes('length'));
  });
});

test('a book missing everything gets everything the lookup has', async () => {
  const bare = book({ isbn: '9780486266886' });

  await withStubbedLookup({ openLibrary: OPEN_LIBRARY, google: GOOGLE }, async () => {
    const result = await fetchMissingDetails(bare);
    assert.equal(result.patch.author, 'Robert Louis Stevenson');
    assert.equal(result.patch.pageCount, 245, 'the edition-specific count wins');
    assert.ok(result.patch.description);
    assert.ok(result.patch.genre);
  });
});

test('a complete book reports nothing to do rather than looking up', async () => {
  const complete = book({
    author: 'Someone', isbn: '9780486266886', pageCount: 245,
    genre: 'Fantasy', description: 'A blurb.', cover: { url: 'https://x/y.jpg' },
  });
  const result = await fetchMissingDetails(complete);
  assert.deepEqual(result.patch, {});
  assert.match(result.reason, /Nothing missing/);
});

test('a failed lookup reports why and changes nothing', async () => {
  const bare = book({ isbn: '9780486266886' });
  await withStubbedLookup({ openLibrary: { docs: [] }, google: {} }, async () => {
    const result = await fetchMissingDetails(bare);
    assert.ok(!result.ok);
    assert.deepEqual(result.patch, {});
  });
});

/* --- Descriptions that search cannot see ----------------------------------- */

/**
 * Open Library's search index has no description field.
 *
 * This is the bug that made "get details" report nothing was missing while the
 * blurb sat on a page you could open and read: the search result carries a
 * work key, and the description lives on the work record behind it.
 */
function withOpenLibraryWork({ search, work, google = { items: [] } }, run) {
  const originalFetch = globalThis.fetch;
  const called = [];

  globalThis.fetch = async (url) => {
    const target = String(url);
    called.push(target);
    const body = target.includes('/works/')
      ? work
      : target.includes('openlibrary.org/search')
        ? search
        : target.includes('itunes')
          ? { results: [] }
          : google;
    return { ok: true, json: async () => body };
  };

  return Promise.resolve(run(called)).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

const MANGA_SEARCH = {
  docs: [{
    key: '/works/OL20124372W',
    title: 'Chainsaw Man, Vol. 1',
    author_name: ['Tatsuki Fujimoto'],
    number_of_pages_median: 192,
    cover_i: 12345,
    isbn: ['9786555127331'],
  }],
};

const MANGA_WORK = {
  description: { type: '/type/text', value: 'A devil hunter and his chainsaw dog.' },
  subjects: ['Manga', 'Accessible book', 'Comic books, strips, etc'],
};

test('a description is fetched from the work record, not the search index', () =>
  withOpenLibraryWork({ search: MANGA_SEARCH, work: MANGA_WORK }, async () => {
    const record = book({ title: 'Chainsaw Man, Vol. 1', isbn: '9786555127331' });
    const result = await fetchMissingDetails(record);

    assert.ok(result.ok);
    assert.equal(result.patch.description, 'A devil hunter and his chainsaw dog.');
    assert.ok(result.filled.includes('description'));
  }));

test('a subject stands in for the genre Open Library does not have', () =>
  withOpenLibraryWork({ search: MANGA_SEARCH, work: MANGA_WORK }, async () => {
    const result = await fetchMissingDetails(book({ title: 'Chainsaw Man, Vol. 1', isbn: '9786555127331' }));
    // "Accessible book" is a cataloguing artefact and "Comic books, strips,
    // etc" is a Library of Congress heading, not a word anyone would use.
    assert.equal(result.patch.genre, 'Manga');
  }));

test('the work record is only fetched when something is still missing', () =>
  withOpenLibraryWork({ search: MANGA_SEARCH, work: MANGA_WORK }, async (called) => {
    const complete = book({
      title: 'Chainsaw Man, Vol. 1', author: 'Tatsuki Fujimoto', isbn: '9786555127331',
      pageCount: 192, genre: 'Manga', description: 'Mine.',
      cover: { url: 'https://example.com/cover.jpg' },
    });
    await fetchMissingDetails(complete);
    assert.ok(!called.some((url) => url.includes('/works/')), 'nothing missing, nothing fetched');
  }));

test('an ISBN that finds a bare record still falls back to a title search', () =>
  withOpenLibraryWork({
    // A regional printing catalogued with a title and nothing else.
    search: { docs: [{ key: '/works/OL1W', title: 'Chainsaw Man, Vol. 1' }] },
    work: {},
    google: { items: [{ volumeInfo: {
      title: 'Chainsaw Man, Vol. 1', authors: ['Tatsuki Fujimoto'],
      pageCount: 192, description: 'Denji becomes Chainsaw Man.',
    } }] },
  }, async () => {
    const result = await fetchMissingDetails(
      book({ title: 'Chainsaw Man, Vol. 1', isbn: '9786555127331' })
    );

    assert.ok(result.ok, 'the edition was thin; the work was not');
    assert.equal(result.patch.description, 'Denji becomes Chainsaw Man.');
    assert.equal(result.patch.pageCount, 192);
  }));

test('a title search never claims to have found this edition\u2019s ISBN', () =>
  withOpenLibraryWork({
    search: { docs: [{ key: '/works/OL1W', title: 'A Book', isbn: ['9780000000001'] }] },
    work: {},
  }, async () => {
    const result = await fetchMissingDetails(book({ title: 'A Book' }));
    // A text search finds the work, so its ISBN belongs to some printing and
    // not necessarily to the copy on the shelf.
    assert.ok(!result.filled.includes('ISBN'));
  }));

test('finding the book but not the gap says which gap survived', async () => {
  await withOpenLibraryWork({
    search: { docs: [{ key: '/works/OL1W', title: 'A Book', author_name: ['Someone'] }] },
    work: {},
  }, async () => {
    const result = await fetchMissingDetails(book({ title: 'A Book', author: 'Someone' }));
    assert.ok(!result.ok);
    // "The lookup had nothing this book was missing" reads as a shrug.
    assert.match(result.reason, /no .*description/i);
  });
});
