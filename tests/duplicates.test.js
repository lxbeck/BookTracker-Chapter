/**
 * Where the covers are, and which books are the same book.
 *
 * Both answer questions you cannot answer by looking. A cover fetched live
 * from a catalogue is pixel-identical to one sitting in the folder until the
 * day the catalogue stops serving it; two records for one book look like two
 * books until you notice the reading log is split across them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBook } from '../js/data/schema.js';
import { auditCovers, verdictFor, VERDICT_ORDER } from '../js/data/coverAudit.js';
import {
  findDuplicates, mergePlan, titleKey, authorKey, completeness,
} from '../js/data/duplicates.js';

const book = (props) => normalizeBook({ title: 'A Book', ...props }, '2026-08-19');
const sources = (props = {}) => ({ onServer: new Set(), onDevice: new Set(), ...props });

/* --- Where a cover lives --------------------------------------------------- */

test('a cover in the folder counts as stored', () => {
  const one = book({ id: 'bk-1', cover: { url: 'https://covers.example/1.jpg' } });
  assert.equal(verdictFor(one, sources({ onServer: new Set(['bk-1']) })), 'stored');
});

test('a cover held only by this browser says so', () => {
  const one = book({ id: 'bk-1', cover: { url: 'local:cover' } });
  assert.equal(verdictFor(one, sources({ onDevice: new Set(['bk-1']) })), 'device');
});

test('a cover that is only an address is linked, not saved', () => {
  // The distinction the whole report exists for: this one loads today and
  // shows a blank spine the day the catalogue reorganises its buckets.
  const one = book({ id: 'bk-1', cover: { url: 'https://covers.openlibrary.org/b/id/1-L.jpg' } });
  assert.equal(verdictFor(one, sources()), 'linked');
});

test('a record pointing at an image store that does not have it has no cover', () => {
  // The sentinel means "look in the image store"; if it is not there, the
  // record is pointing at something that no longer exists.
  const one = book({ id: 'bk-1', cover: { url: 'local:cover' } });
  assert.equal(verdictFor(one, sources()), 'none');
});

test('the folder wins over the browser copy', () => {
  // Most stored covers are cached locally too. The verdict names the strongest
  // copy, because that is what the question is asking.
  const one = book({ id: 'bk-1', cover: { url: 'https://covers.example/1.jpg' } });
  const both = sources({ onServer: new Set(['bk-1']), onDevice: new Set(['bk-1']) });
  assert.equal(verdictFor(one, both), 'stored');
});

test('an audit counts every book exactly once', () => {
  const books = [
    book({ id: 'bk-1', title: 'Stored', cover: { url: 'https://a/1.jpg' } }),
    book({ id: 'bk-2', title: 'Linked', cover: { url: 'https://a/2.jpg' } }),
    book({ id: 'bk-3', title: 'Nothing' }),
  ];

  const audit = auditCovers(books, {
    onServer: ['bk-1'], onDevice: [], files: { 'bk-1': 'stored.jpg' }, hasServer: true,
  });

  assert.equal(audit.counts.stored, 1);
  assert.equal(audit.counts.linked, 1);
  assert.equal(audit.counts.none, 1);
  assert.equal(
    VERDICT_ORDER.reduce((sum, verdict) => sum + audit.counts[verdict], 0),
    books.length
  );
});

test('the audit names the file a stored cover lives in', () => {
  const audit = auditCovers([book({ id: 'bk-1', title: 'Dune', cover: { url: 'https://a.jpg' } })], {
    onServer: ['bk-1'], files: { 'bk-1': 'dune.jpg' }, hasServer: true,
  });
  assert.equal(audit.byVerdict.stored[0].file, 'dune.jpg');
});

test('files belonging to no book are reported as orphans', () => {
  // Left behind by a book deleted on another device, or by a library restored
  // onto a server that kept its old folder. Otherwise invisible.
  const audit = auditCovers([book({ id: 'bk-1' })], {
    onServer: ['bk-1'], files: { 'bk-1': 'a.jpg', 'bk-gone': 'orphan.jpg' }, hasServer: true,
  });

  assert.equal(audit.orphans.length, 1);
  assert.equal(audit.orphans[0].file, 'orphan.jpg');
});

test('nothing is storable without a server to store it on', () => {
  const audit = auditCovers([book({ cover: { url: 'https://a/1.jpg' } })], { hasServer: false });
  assert.equal(audit.storable, 0);
});

/* --- Recognising the same book --------------------------------------------- */

test('volume markers are normalised but volume numbers are not', () => {
  assert.equal(titleKey('Rachel Rising Vol. 1'), titleKey('Rachel Rising Volume 1'));
  // Volumes 1 and 2 are emphatically not the same book.
  assert.notEqual(titleKey('Rachel Rising Vol. 1'), titleKey('Rachel Rising Vol. 2'));
});

test('a subtitle is part of the title', () => {
  assert.notEqual(
    titleKey('Rachel Rising Vol. 1: Shadow of Death'),
    titleKey('Rachel Rising Vol. 2: Fear No Malus')
  );
});

test('an author written two ways is one author', () => {
  assert.equal(authorKey('Frank Herbert'), authorKey('Herbert, Frank'));
  assert.equal(authorKey('H. G. Wells'), authorKey('Wells, H.G.'));
  // Two people sharing a surname collapse together, which is why a surname
  // match alone never merges anything — it only raises the question.
  assert.equal(authorKey('Frank Herbert'), authorKey('Brian Herbert'));
});

test('the same ISBN is the same book whatever the titles say', () => {
  const groups = findDuplicates([
    book({ id: 'a', title: 'Dune', isbn: '9780441013593' }),
    book({ id: 'b', title: 'Dune (Deluxe Edition)', isbn: '9780441013593' }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, 'isbn');
});

test('the same title and author is a duplicate', () => {
  const groups = findDuplicates([
    book({ id: 'a', title: 'The Time Machine', author: 'H. G. Wells' }),
    book({ id: 'b', title: 'the time machine', author: 'Wells, H. G.' }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, 'both');
});

test('two different books that share a title are not duplicates', () => {
  // A title collision is a real thing and merging it would be unrecoverable.
  const groups = findDuplicates([
    book({ id: 'a', title: 'Persuasion', author: 'Jane Austen' }),
    book({ id: 'b', title: 'Persuasion', author: 'Someone Else' }),
  ]);

  assert.equal(groups.length, 0);
});

test('a titled record and an untitled-author one are raised, not asserted', () => {
  const groups = findDuplicates([
    book({ id: 'a', title: 'Gideon the Ninth', author: 'Tamsyn Muir' }),
    book({ id: 'b', title: 'Gideon the Ninth', author: '' }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, 'title');
});

test('a library with no duplicates reports none', () => {
  const groups = findDuplicates([
    book({ id: 'a', title: 'The Time Machine', author: 'H. G. Wells' }),
    book({ id: 'b', title: 'The Invisible Man', author: 'H. G. Wells' }),
  ]);
  assert.deepEqual(groups, []);
});

/* --- Folding them together ------------------------------------------------- */

const withLog = book({
  id: 'full',
  title: 'Gideon the Ninth',
  author: 'Tamsyn Muir',
  pageCount: 448,
  sessions: [
    { date: '2026-08-01', minutes: 60, pageFrom: 0, pageTo: 30 },
    { date: '2026-08-02', minutes: 45, pageFrom: 30, pageTo: 60 },
  ],
  shelves: ['to reread'],
});

const sparse = book({
  id: 'thin',
  title: 'Gideon the Ninth',
  author: 'Tamsyn Muir',
  isbn: '9781250313195',
  description: 'A necromancer and her swordswoman.',
  shelves: ['borrowed'],
  sessions: [{ date: '2026-08-03', minutes: 90, pageFrom: 60, pageTo: 120 }],
});

test('the record with the reading log is the one that survives', () => {
  // A log is the only part that cannot be fetched again from a catalogue.
  assert.ok(completeness(withLog) > completeness(sparse));
  assert.equal(mergePlan([sparse, withLog]).survivor.id, 'full');
});

test('the survivor gains the fields it was missing', () => {
  const { patch, gains } = mergePlan([withLog, sparse]);

  assert.equal(patch.isbn, '9781250313195');
  assert.equal(patch.description, 'A necromancer and her swordswoman.');
  assert.ok(gains.includes('ISBN'));
});

test('nothing already on the survivor is overwritten', () => {
  const { patch } = mergePlan([withLog, sparse]);
  assert.ok(!('pageCount' in patch), 'the survivor already knew its length');
  assert.ok(!('title' in patch));
});

test('every reading session from every copy is kept', () => {
  // The entire reason merging beats deleting: a session is a fact about an
  // evening and belongs to the book, not to whichever record was open.
  const { patch } = mergePlan([withLog, sparse]);

  assert.equal(patch.sessions.length, 3);
  assert.deepEqual(patch.sessions.map((s) => s.date), ['2026-08-01', '2026-08-02', '2026-08-03']);
});

test('the same session logged on both copies is not counted twice', () => {
  const twin = book({
    id: 'twin', title: 'Gideon the Ninth', author: 'Tamsyn Muir',
    sessions: [{ date: '2026-08-01', minutes: 60, pageFrom: 0, pageTo: 30 }],
  });
  const { patch } = mergePlan([withLog, twin]);
  assert.ok(!patch.sessions || patch.sessions.length === 2);
});

test('tags from every copy come along', () => {
  const { patch } = mergePlan([withLog, sparse]);
  assert.deepEqual([...patch.shelves].sort(), ['borrowed', 'to reread']);
});

test('progress is the furthest anyone got', () => {
  const { patch } = mergePlan([withLog, sparse]);
  assert.equal(patch.progress.page, 120);
});

test('a finish date on any copy means the book was finished', () => {
  const done = book({
    id: 'done', title: 'Gideon the Ninth', author: 'Tamsyn Muir',
    status: 'finished', actual: { finishedAt: '2026-08-05' },
  });

  const { patch } = mergePlan([withLog, done]);
  assert.equal(patch.actual.finishedAt, '2026-08-05');
  assert.equal(patch.status, 'finished');
});

/* --- Bugs worth keeping fixed ---------------------------------------------- */

import { FILLABLE } from '../js/data/fill.js';

test('a duplicate is found when only one of the copies has an ISBN', () => {
  // The commonest duplicate of all, and the one the finder used to miss: an
  // import that ran before the ISBN was filled in matched nothing and added a
  // second record. Grouping by ISBN used to stop the title check running.
  const groups = findDuplicates([
    book({ id: 'a', title: 'Gideon the Ninth', author: 'Tamsyn Muir', isbn: '9781250313195' }),
    book({ id: 'b', title: 'Gideon the Ninth', author: 'Tamsyn Muir' }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].books.length, 2);
});

test('a pair matched by both ISBN and title is reported once', () => {
  const groups = findDuplicates([
    book({ id: 'a', title: 'Dune', author: 'Frank Herbert', isbn: '9780441013593' }),
    book({ id: 'b', title: 'Dune', author: 'Frank Herbert', isbn: '9780441013593' }),
  ]);

  assert.equal(groups.length, 1, 'two readings of the same pair is still one pair');
  assert.equal(groups[0].reason, 'isbn', 'the stronger claim is the one shown');
});

test('an import never fills a field the reader decided', () => {
  // Status, schedule, progress, format and category are all guessed by
  // importers. A guess must not overwrite a decision, even a default one.
  const paths = FILLABLE.map((entry) => entry.path);

  for (const forbidden of ['status', 'schedule', 'progress', 'format', 'formats', 'category']) {
    assert.ok(
      !paths.some((path) => path === forbidden || path.startsWith(`${forbidden}.`)),
      `${forbidden} must not be fillable by an import`
    );
  }
});

/* --- Judgements that have to outlive the session --------------------------- */

import { groupKey } from '../js/data/duplicates.js';

test('a dismissed pair stays dismissed', () => {
  // Held only in memory, "not duplicates" survived until the next reload and
  // then asked again — which is worse than never having asked.
  const pair = [
    book({ id: 'a', title: 'Persuasion', author: 'Jane Austen' }),
    book({ id: 'b', title: 'Persuasion', author: '' }),
  ];

  const [group] = findDuplicates(pair);
  assert.ok(group.key, 'a group needs a name to be dismissed by');

  assert.deepEqual(findDuplicates(pair, { dismissed: [group.key] }), []);
});

test('a dismissal is about the records, not their titles', () => {
  // Editing a title afterwards must not bring the question back.
  const first = [book({ id: 'a', title: 'Persuasion' }), book({ id: 'b', title: 'Persuasion' })];
  const renamed = [book({ id: 'a', title: 'Persuasion (1817)' }), book({ id: 'b', title: 'Persuasion (1817)' })];

  assert.equal(groupKey(first), groupKey(renamed));
});

test('a dismissal does not silence a different pair', () => {
  const library = [
    book({ id: 'a', title: 'Persuasion', author: 'Jane Austen' }),
    book({ id: 'b', title: 'Persuasion', author: '' }),
    book({ id: 'c', title: 'Emma', author: 'Jane Austen' }),
    book({ id: 'd', title: 'Emma', author: '' }),
  ];

  const groups = findDuplicates(library);
  assert.equal(groups.length, 2);
  assert.equal(findDuplicates(library, { dismissed: [groups[0].key] }).length, 1);
});
