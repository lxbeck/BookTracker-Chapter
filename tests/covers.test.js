/**
 * Covers: what the files are called, which catalogues get asked, and how
 * several answers fold into one.
 *
 * The naming rules are tested hardest because they touch a real filesystem on
 * someone's machine. A collision that silently overwrites the wrong file loses
 * a cover, and a rename rule that fires on every restart churns the folder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  slugifyTitle, coverFileName, nameMatchesTitle, COVER_EXTENSIONS,
} from '../js/data/coverNames.js';
import {
  PROVIDERS, PROVIDER_ORDER, EVERY_SOURCE, providersFor, mergeFound, interleave,
  cleanIsbn,
} from '../js/data/providers.js';
import { configureSources, searchByText, normalizeCoverUrl } from '../js/data/covers.js';

/* --- Names on disk --------------------------------------------------------- */

test('a title becomes a readable filename', () => {
  assert.equal(slugifyTitle('The Hobbit'), 'the-hobbit');
  assert.equal(slugifyTitle('The Strange Case of Dr Jekyll and Mr Hyde'),
    'the-strange-case-of-dr-jekyll-and-mr-hyde');
});

test('accents are folded rather than dropped', () => {
  // les-misrables would be the result of stripping instead of folding, and is
  // no more readable than an id.
  assert.equal(slugifyTitle('Les Misérables'), 'les-miserables');
  assert.equal(slugifyTitle('Kafka på stranden'), 'kafka-pa-stranden');
});

test('punctuation and ampersands survive as words, not as gaps', () => {
  assert.equal(slugifyTitle("Alice's Adventures in Wonderland"),
    'alices-adventures-in-wonderland');
  assert.equal(slugifyTitle('Sense & Sensibility'), 'sense-and-sensibility');
});

test('a very long title is cut to something a filesystem accepts', () => {
  const name = slugifyTitle('a'.repeat(300));
  assert.ok(name.length <= 70, `70 characters at most, got ${name.length}`);
  assert.ok(!name.endsWith('-'), 'a trailing hyphen is a cut mid-word');
});

test('a book with no usable title still gets a file', () => {
  const name = coverFileName({}, 'bk-9f2c1a04', '', '.jpg');
  assert.match(name, /^untitled-bk-9f2c1a04\.jpg$/);
});

test('the same title twice does not overwrite the first book', () => {
  const index = {};
  index['bk-1'] = coverFileName(index, 'bk-1', 'Dune', '.jpg');
  index['bk-2'] = coverFileName(index, 'bk-2', 'Dune', '.jpg');
  index['bk-3'] = coverFileName(index, 'bk-3', 'Dune', '.jpg');

  assert.deepEqual(Object.values(index), ['dune.jpg', 'dune-2.jpg', 'dune-3.jpg']);
});

test('a collision is caught across extensions, not just within one', () => {
  // dune.jpg and dune.png in one folder is exactly the confusion that naming
  // by title is meant to remove.
  const index = { 'bk-1': 'dune.jpg' };
  assert.equal(coverFileName(index, 'bk-2', 'Dune', '.png'), 'dune-2.png');
});

test('a book keeps its own name when its cover is replaced', () => {
  const index = { 'bk-1': 'dune.jpg' };
  // Re-filing the same book must not push it to dune-2 — that would leave the
  // old file orphaned and rename the cover for no reason.
  assert.equal(coverFileName(index, 'bk-1', 'Dune', '.jpg'), 'dune.jpg');
  assert.equal(coverFileName(index, 'bk-1', 'Dune', '.png'), 'dune.png');
});

test('a file is only renamed when the title actually changed', () => {
  assert.ok(nameMatchesTitle('dune.jpg', 'Dune'));
  assert.ok(nameMatchesTitle('dune-2.jpg', 'Dune'), 'a disambiguated name still matches');
  assert.ok(!nameMatchesTitle('dune.jpg', 'Dune Messiah'));
});

test('an untitled book is never renamed on a restart', () => {
  // Otherwise every boot would rename it, since the slug of '' is ''.
  assert.ok(nameMatchesTitle('untitled-bk-1.jpg', ''));
});

test('every extension we write is one we can also find again', () => {
  assert.deepEqual(COVER_EXTENSIONS, ['.jpg', '.png', '.webp', '.gif']);
  for (const extension of COVER_EXTENSIONS) {
    assert.ok(coverFileName({}, 'bk-1', 'Dune', extension).endsWith(extension));
  }
});

/* --- Which catalogues get asked -------------------------------------------- */

test('the default asks every catalogue', () => {
  assert.deepEqual(providersFor(EVERY_SOURCE).map((p) => p.id), PROVIDER_ORDER);
  assert.deepEqual(providersFor(undefined).map((p) => p.id), PROVIDER_ORDER);
});

test('naming one catalogue asks only that one', () => {
  assert.deepEqual(providersFor('google').map((p) => p.id), ['google']);
});

test('an unknown source falls back to everything, not to nothing', () => {
  // A setting synced from a newer version must not silently disable lookups.
  assert.deepEqual(providersFor('some-future-source').map((p) => p.id), PROVIDER_ORDER);
});

test('Apple is excluded from ISBN lookups because it has no ISBN index', () => {
  assert.ok(!PROVIDERS.apple.byIsbn, 'searching an ISBN as free text returns the wrong edition');
  assert.ok(PROVIDERS.openlibrary.byIsbn && PROVIDERS.google.byIsbn);
});

test('an ISBN is cleaned of the punctuation people paste with it', () => {
  assert.equal(cleanIsbn('978-0-486-26688-6'), '9780486266886');
  assert.equal(cleanIsbn('080442957x'), '080442957X');
});

/* --- Folding several answers into one -------------------------------------- */

const answer = (source, fields) => ({
  title: '', author: '', pageCount: null, year: null, isbn: '',
  description: '', genre: '', coverUrl: null, source, ...fields,
});

test('each field comes from whichever catalogue actually has it', () => {
  const merged = mergeFound([
    answer('openlibrary', { title: 'Dune', pageCount: 412 }),
    answer('google', { title: 'Dune', description: 'A long blurb.', genre: 'Fiction' }),
    answer('apple', { title: 'Dune', coverUrl: 'https://apple/large.jpg' }),
  ]);

  assert.equal(merged.pageCount, 412, 'Open Library knows page counts');
  assert.equal(merged.description, 'A long blurb.');
  assert.equal(merged.genre, 'Fiction');
  assert.equal(merged.coverUrl, 'https://apple/large.jpg');
});

test('Google wins the blurb even when Open Library has one', () => {
  // Open Library's is the opening sentence of the book; Google's is the
  // publisher's description. They are not the same kind of thing.
  const merged = mergeFound([
    answer('openlibrary', { title: 'Dune', description: 'It was a warm night.' }),
    answer('google', { title: 'Dune', description: 'Set on the desert planet Arrakis.' }),
  ]);
  assert.equal(merged.description, 'Set on the desert planet Arrakis.');
});

test('the cover setting decides whose art wins, independently of the details', () => {
  const found = [
    answer('openlibrary', { title: 'Dune', pageCount: 412, coverUrl: 'https://ol/small.jpg' }),
    answer('apple', { title: 'Dune', coverUrl: 'https://apple/large.jpg' }),
  ];

  assert.equal(mergeFound(found, { coverFrom: 'apple' }).coverUrl, 'https://apple/large.jpg');
  assert.equal(mergeFound(found, { coverFrom: 'openlibrary' }).coverUrl, 'https://ol/small.jpg');
  // Details still come from wherever they exist, whichever cover was chosen.
  assert.equal(mergeFound(found, { coverFrom: 'apple' }).pageCount, 412);
});

test('a chosen cover source with no art falls through rather than blanking', () => {
  const merged = mergeFound([
    answer('openlibrary', { title: 'Dune', coverUrl: 'https://ol/small.jpg' }),
    answer('apple', { title: 'Dune' }),
  ], { coverFrom: 'apple' });

  assert.equal(merged.coverUrl, 'https://ol/small.jpg');
});

test('nothing found is null, not an empty record', () => {
  assert.equal(mergeFound([]), null);
  assert.equal(mergeFound([null, undefined]), null);
});

test('the merged record says which catalogues answered', () => {
  const merged = mergeFound([
    answer('openlibrary', { title: 'Dune' }),
    answer('google', { title: 'Dune' }),
  ]);
  assert.deepEqual(merged.sources, ['openlibrary', 'google']);
});

/* --- Search results across catalogues -------------------------------------- */

test('results are interleaved, so a second catalogue can beat a first', () => {
  // Concatenating would bury Google's best match under Open Library's worst.
  const openLibrary = [answer('openlibrary', { title: 'A' }), answer('openlibrary', { title: 'B' })];
  const google = [answer('google', { title: 'C' }), answer('google', { title: 'D' })];

  assert.deepEqual(
    interleave([openLibrary, google], 4).map((r) => r.title),
    ['A', 'C', 'B', 'D']
  );
});

test('the same book from two catalogues appears once', () => {
  const lists = [
    [answer('openlibrary', { title: 'Dune', author: 'Frank Herbert' })],
    [answer('google', { title: 'dune', author: 'FRANK HERBERT' })],
  ];
  assert.equal(interleave(lists, 6).length, 1);
});

test('a catalogue that returned nothing does not leave a gap', () => {
  const lists = [[], [answer('google', { title: 'Dune' })], []];
  assert.deepEqual(interleave(lists, 6).map((r) => r.title), ['Dune']);
});

test('the limit is honoured across all catalogues together', () => {
  const many = (source) =>
    Array.from({ length: 10 }, (_, i) => answer(source, { title: `${source}-${i}` }));
  assert.equal(interleave([many('openlibrary'), many('google')], 6).length, 6);
});

/* --- Parsing each catalogue's shape ---------------------------------------- */

const stub = (payload) => async () => payload;

test('Open Library results carry a cover and a page count', async () => {
  const [result] = await PROVIDERS.openlibrary.search('dune', 5, stub({
    docs: [{
      title: 'Dune', author_name: ['Frank Herbert'], number_of_pages_median: 412,
      cover_i: 9876, first_publish_year: 1965, isbn: ['9780441013593'],
    }],
  }));

  assert.equal(result.title, 'Dune');
  assert.equal(result.author, 'Frank Herbert');
  assert.equal(result.pageCount, 412);
  assert.equal(result.year, 1965);
  assert.match(result.coverUrl, /covers\.openlibrary\.org\/b\/id\/9876-L\.jpg$/);
  assert.equal(result.source, 'openlibrary');
});

test('Google thumbnails are asked for flat, secure and larger', async () => {
  const [result] = await PROVIDERS.google.search('dune', 5, stub({
    items: [{ volumeInfo: {
      title: 'Dune', authors: ['Frank Herbert'], pageCount: 412, publishedDate: '1965-08-01',
      categories: ['Fiction'], description: '<p>On Arrakis.</p>',
      industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780441013593' }],
      imageLinks: { thumbnail: 'http://books.google.com/img?id=1&zoom=1&edge=curl' },
    } }],
  }));

  assert.ok(result.coverUrl.startsWith('https:'), 'an http image is blocked on an https page');
  assert.ok(!result.coverUrl.includes('edge=curl'), 'the curled page edge is not part of the art');
  assert.ok(result.coverUrl.includes('zoom=2'));
  assert.equal(result.description, 'On Arrakis.', 'markup is stripped before storage');
  assert.equal(result.isbn, '9780441013593');
  assert.equal(result.year, 1965);
});

test('Apple artwork is requested at a size worth looking at', async () => {
  const [result] = await PROVIDERS.apple.search('dune', 5, stub({
    results: [{
      trackName: 'Dune', artistName: 'Frank Herbert', releaseDate: '1965-08-01T07:00:00Z',
      primaryGenreName: 'Sci-Fi & Fantasy',
      artworkUrl100: 'https://is1.mzstatic.com/image/thumb/abc/100x100bb.jpg',
    }],
  }));

  assert.equal(result.coverUrl, 'https://is1.mzstatic.com/image/thumb/abc/600x600bb.jpg');
  assert.equal(result.genre, 'Sci-Fi & Fantasy');
  assert.equal(result.source, 'apple');
});

test('an empty response from any catalogue is an empty list, not a crash', async () => {
  for (const id of PROVIDER_ORDER) {
    assert.deepEqual(await PROVIDERS[id].search('nothing', 5, stub({})), []);
  }
});

/* --- The setting actually changes who gets asked --------------------------- */

/** Record every host a search reaches for, without touching the network. */
function withRecordedFetch(run, { failing = [] } = {}) {
  const original = globalThis.fetch;
  const called = [];

  globalThis.fetch = async (url) => {
    const host = new URL(String(url)).hostname;
    called.push(host);
    if (failing.includes(host)) throw new Error(`${host} is down`);
    return {
      ok: true,
      json: async () =>
        host.includes('googleapis')
          ? { items: [{ volumeInfo: { title: 'From Google', authors: ['G'] } }] }
          : host.includes('itunes')
            ? { results: [{ trackName: 'From Apple', artistName: 'A' }] }
            : { docs: [{ title: 'From Open Library', author_name: ['O'] }] },
    };
  };

  return Promise.resolve(run(called)).finally(() => {
    globalThis.fetch = original;
    configureSources({});
  });
}

test('the default search asks all three catalogues', () =>
  withRecordedFetch(async (called) => {
    configureSources({ metadata: EVERY_SOURCE, covers: EVERY_SOURCE });
    const results = await searchByText('dune');

    assert.equal(called.length, 3);
    assert.deepEqual(results.map((r) => r.source).sort(), ['apple', 'google', 'openlibrary']);
  }));

test('narrowing the source stops the others being asked', () =>
  withRecordedFetch(async (called) => {
    configureSources({ metadata: 'google', covers: 'google' });
    await searchByText('dune');

    assert.deepEqual(called, ['www.googleapis.com']);
  }));

test('details and art can come from different catalogues at once', () =>
  withRecordedFetch(async (called) => {
    // Asking only Open Library would leave every cover empty, so the union of
    // the two settings is what gets queried.
    configureSources({ metadata: 'openlibrary', covers: 'apple' });
    await searchByText('dune');

    assert.deepEqual(called.sort(), ['itunes.apple.com', 'openlibrary.org']);
  }));

test('one catalogue being down does not sink the search', () =>
  withRecordedFetch(async () => {
    configureSources({ metadata: EVERY_SOURCE, covers: EVERY_SOURCE });
    const results = await searchByText('dune');

    assert.ok(results.length >= 2, 'the surviving catalogues still answer');
    assert.ok(!results.some((r) => r.source === 'openlibrary'));
  }, { failing: ['openlibrary.org'] }));

test('every catalogue being down is reported rather than read as no results', () =>
  withRecordedFetch(async () => {
    configureSources({ metadata: EVERY_SOURCE, covers: EVERY_SOURCE });
    // "Nothing found" and "nothing answered" need different messages: one
    // means try another title, the other means try again later.
    await assert.rejects(() => searchByText('dune'));
  }, { failing: ['openlibrary.org', 'www.googleapis.com', 'itunes.apple.com'] }));

test('a search too short to mean anything never leaves the browser', () =>
  withRecordedFetch(async (called) => {
    assert.deepEqual(await searchByText('a'), []);
    assert.equal(called.length, 0);
  }));

/* --- Pasted addresses ------------------------------------------------------ */

test('a pasted image address is accepted', () => {
  assert.equal(
    normalizeCoverUrl('  https://example.com/covers/dune.jpg  '),
    'https://example.com/covers/dune.jpg'
  );
});

test('a pasted page address is refused with an explanation', () => {
  // Copying the link rather than the image is the mistake everyone makes once.
  assert.throws(() => normalizeCoverUrl('https://example.com/books/dune.html'), /page, not an image/);
});

test('a cover address has to be http or https', () => {
  assert.throws(() => normalizeCoverUrl('file:///Users/me/dune.jpg'), /http/);
  assert.throws(() => normalizeCoverUrl('not a url'), /web address/);
  assert.throws(() => normalizeCoverUrl(''), /Paste an image address/);
});
