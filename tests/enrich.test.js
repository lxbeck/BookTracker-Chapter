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
