/**
 * Audiobook length tests: a running time is not a page count, a page count is
 * not a running time, and clock time is neither.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBook,
  parseHms,
  formatHms,
  listeningTime,
  SCHEMA_VERSION,
} from '../js/data/schema.js';

const audiobook = (extra = {}) =>
  normalizeBook({ title: 'Project Hail Mary', formats: ['audio'], ...extra });

/* --- Reading and writing a running time ------------------------------------ */

test('a running time is read the way a player shows it', () => {
  assert.equal(parseHms('9:45:30'), 9 * 3600 + 45 * 60 + 30);
  assert.equal(parseHms('45:30'), 45 * 60 + 30, 'two parts are minutes and seconds');
  assert.equal(parseHms('45'), 45 * 60, 'one part is minutes, which is what people type');
});

test('a length that cannot be read is nothing, not zero', () => {
  // A blank field and a nought-length book are different statements, and
  // guessing zero would silently wipe a length someone thought they had typed.
  for (const bad of ['', '   ', 'abc', '9.45.30', '1:2:3:4', '0:00']) {
    assert.equal(parseHms(bad), null, `${JSON.stringify(bad)} is not a length`);
  }
});

test('seconds come back out the way they went in', () => {
  assert.equal(formatHms(35130), '9:45:30');
  assert.equal(formatHms(2730), '45:30', 'the hours are left off when there are none');
  assert.equal(formatHms(59), '0:59');
  assert.equal(parseHms(formatHms(35130)), 35130, 'and the round trip is lossless');
});

/* --- The two lengths, kept from contradicting each other -------------------- */

test('an audiobook keeps its seconds and paces by its minutes', () => {
  const book = audiobook({ audioSeconds: '9:45:30' });

  assert.equal(book.audioSeconds, 35130, 'the recording keeps its seconds');
  // Rounded up: 45:30 is not 45 minutes, and a target that says otherwise
  // leaves you thirty seconds short every day of the plan.
  assert.equal(book.pageCount, 586, 'and pacing gets whole minutes to work with');
});

test('a record made before running times existed still has one', () => {
  // v8 saves hold whole minutes in pageCount and nothing else. Normalising
  // mirrors them back, so a phone that has not synced the change yet does not
  // hand back a book with half a length.
  const book = audiobook({ pageCount: 310 });

  assert.equal(book.audioSeconds, 18600);
  assert.equal(book.pageCount, 310, 'and the number it was paced by is untouched');
  assert.equal(SCHEMA_VERSION, 9, 'the bump is what re-runs that on an old save');
});

test('a book that is read and listened to carries both lengths at once', () => {
  const book = normalizeBook({
    title: 'Vicious',
    formats: ['physical', 'audio'],
    pageCount: 448,
    audioSeconds: '12:00:00',
  });

  assert.equal(book.pageCount, 448, 'pages stay the measure, because pages beat minutes');
  assert.equal(book.audioSeconds, 43200, 'and the recording is recorded, not converted away');
});

test('a book with no audio has no running time to speak of', () => {
  const book = normalizeBook({ title: 'Dune', formats: ['physical'], pageCount: 412 });

  assert.equal(book.audioSeconds, null);
  assert.equal(book.pageCount, 412);
});

/* --- Playback speed --------------------------------------------------------- */

test('speed is the listener’s, and turns a runtime into an evening', () => {
  const book = audiobook({ audioSeconds: '9:45:30', speed: 1.5 });

  assert.equal(book.speed, 1.5);
  assert.equal(formatHms(listeningTime(book)), '6:30:20');
  assert.equal(book.pageCount, 586, 'speed does not change how long the recording is');
});

test('a speed nobody could be listening at falls back to normal', () => {
  // Clamped rather than rejected: the length is still good, and refusing to
  // save a whole record over a stray digit in an optional field helps nobody.
  for (const bad of [0, -1, 0.1, 12, 'fast', null, undefined, NaN]) {
    assert.equal(audiobook({ speed: bad }).speed, 1, `${bad} is not a speed`);
  }
  assert.equal(audiobook({ speed: 2.75 }).speed, 2.75, 'a real one is kept');
});

test('a book with no recording has no listening time', () => {
  assert.equal(listeningTime(audiobook()), null);
  assert.equal(listeningTime({}), null);
});
