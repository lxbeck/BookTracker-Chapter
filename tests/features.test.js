/**
 * The additions: an installable shell, a timer, a book's own history, a year
 * summed up, and shifting a set of plans at once.
 *
 * The parts worth testing here are the arithmetic and the manifest — the shape
 * of the interface that carries them is checked in interface.test.js, and the
 * drawing is checked by looking at it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeBook } from '../js/data/schema.js';
import { yearInReview, yearsWithReading } from '../js/logic/stats.js';
import { progressTrail } from '../js/logic/pacing.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const TODAY = '2026-08-21';
const book = (props) => normalizeBook({ title: 'x', ...props }, TODAY);

/* --- Installable ----------------------------------------------------------- */

test('the manifest is valid JSON and names the app', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));

  assert.match(manifest.name, /Chapter/);
  assert.equal(manifest.short_name, 'Chapter');
  assert.equal(manifest.display, 'standalone');
});

test('the manifest is relative, so the app can live in a subdirectory', () => {
  // `/` would break the moment this is served from example.com/chapter/, which
  // is exactly where a demo of it ends up.
  const manifest = JSON.parse(read('manifest.webmanifest'));

  assert.equal(manifest.start_url.startsWith('.'), true, `start_url is ${manifest.start_url}`);
  assert.equal(manifest.scope.startsWith('.'), true, `scope is ${manifest.scope}`);
  for (const icon of manifest.icons) {
    assert.equal(icon.src.startsWith('/'), false, `${icon.src} is absolute`);
  }
  for (const shortcut of manifest.shortcuts ?? []) {
    assert.equal(shortcut.url.startsWith('/'), false, `${shortcut.url} is absolute`);
  }
});

test('every icon the manifest promises is really there', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));

  for (const icon of manifest.icons) {
    const path = join(ROOT, icon.src);
    assert.ok(existsSync(path), `${icon.src} is listed but missing`);
    assert.ok(statSync(path).size > 100, `${icon.src} is suspiciously empty`);
  }

  // Android crops a maskable icon to a circle; without one it crops the square
  // icon instead and takes a bite out of the mark.
  assert.ok(manifest.icons.some((icon) => icon.purpose?.includes('maskable')));
});

test('the page links the manifest, an icon and an apple touch icon', () => {
  const html = read('index.html');

  assert.match(html, /rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html, /rel="icon"/);
  assert.match(html, /rel="apple-touch-icon"/);
});

test('the service worker precaches the manifest and its icons', () => {
  // An installed app that opens offline to a missing icon looks broken in the
  // one place — the home screen — where it is meant to look like an app.
  const sw = read('sw.js');

  for (const path of ['./manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png']) {
    assert.ok(sw.includes(`'${path}'`), `sw.js does not precache ${path}`);
  }
});

/* --- The timer ------------------------------------------------------------- */

test('a timer reports whole minutes, and never zero', async () => {
  const { timerMinutes } = await import('../js/views/sessionLog.js');

  assert.equal(timerMinutes(0, 34 * 60000), 34);
  assert.equal(timerMinutes(0, 34.4 * 60000), 34, 'rounded, not floored');
  assert.equal(timerMinutes(0, 34.6 * 60000), 35);
  // A sitting happened, so it is not nothing.
  assert.equal(timerMinutes(0, 5000), 1);
  assert.equal(timerMinutes(0, 0), 1);
});

/* --- A book's own history --------------------------------------------------- */

const patchy = () =>
  book({
    title: 'A Princess of Mars',
    pageCount: 176,
    status: 'reading',
    schedule: { start: '2026-08-15', end: '2026-08-25' },
    actual: { startedAt: '2026-08-15' },
    sessions: [
      { date: '2026-08-16', minutes: 40, pageFrom: 0, pageTo: 41 },
      { date: '2026-08-18', minutes: 70, pageFrom: 41, pageTo: 71 },
      { date: '2026-08-20', minutes: 35, pageFrom: 71, pageTo: 85 },
    ],
  });

test('the trail runs from the start of the plan to today', () => {
  const trail = progressTrail(patchy(), TODAY);

  assert.equal(trail.ok, true);
  assert.equal(trail.points[0].day, '2026-08-15');
  assert.equal(trail.points.at(-1).day, '2026-08-25', 'to the end of the plan');
  assert.equal(trail.total, 176);
});

test('the record is the furthest page reached, not a running sum', () => {
  // Two sittings that both ended on page 90 did not cover 180 pages.
  const twice = book({
    pageCount: 300,
    status: 'reading',
    schedule: { start: '2026-08-18', end: '2026-08-22' },
    sessions: [
      { date: '2026-08-18', minutes: 20, pageFrom: 0, pageTo: 90 },
      { date: '2026-08-18', minutes: 20, pageFrom: 80, pageTo: 90 },
    ],
  });

  const trail = progressTrail(twice, TODAY);
  const day = trail.points.find((point) => point.day === '2026-08-18');
  assert.equal(day.actual, 90);
});

test('a day with nothing logged holds the line rather than dropping to zero', () => {
  const trail = progressTrail(patchy(), TODAY);
  const at = (day) => trail.points.find((point) => point.day === day);

  assert.equal(at('2026-08-16').actual, 41);
  assert.equal(at('2026-08-17').actual, 41, 'a day off is not a day of un-reading');
  assert.equal(at('2026-08-18').actual, 71);
});

test('the plan climbs to the page count and stops', () => {
  const trail = progressTrail(patchy(), TODAY);

  assert.equal(trail.points[0].planned > 0, true);
  assert.equal(trail.points.at(-1).planned, 176, 'the plan ends at the last page');
  for (const point of trail.points) {
    if (point.planned != null) assert.ok(point.planned <= 176, 'and never past it');
  }
});

test('a book with no length has nothing to draw', () => {
  const vague = book({ status: 'reading', schedule: { start: '2026-08-15', end: '2026-08-20' } });
  assert.equal(progressTrail(vague, TODAY).ok, false);
});

/* --- The year in review ----------------------------------------------------- */

const yearLibrary = () => [
  book({
    title: 'The Time Machine',
    author: 'H. G. Wells',
    genre: 'Science fiction',
    pageCount: 118,
    rating: 5,
    status: 'finished',
    actual: { startedAt: '2026-01-02', finishedAt: '2026-01-09' },
    sessions: [
      { date: '2026-01-02', minutes: 60, pageFrom: 0, pageTo: 60 },
      { date: '2026-01-03', minutes: 30, pageFrom: 60, pageTo: 118 },
    ],
  }),
  book({
    title: 'The War of the Worlds',
    author: 'H. G. Wells',
    genre: 'Science fiction',
    pageCount: 192,
    rating: 4,
    status: 'finished',
    actual: { startedAt: '2026-03-01', finishedAt: '2026-03-14' },
    sessions: [{ date: '2026-03-04', minutes: 120, pageFrom: 0, pageTo: 192 }],
  }),
  book({
    title: 'Last year’s book',
    author: 'Someone Else',
    pageCount: 400,
    status: 'finished',
    actual: { startedAt: '2025-11-01', finishedAt: '2025-12-20' },
    sessions: [{ date: '2025-12-01', minutes: 90, pageFrom: 0, pageTo: 400 }],
  }),
];

test('the year counts only what that year finished', () => {
  const review = yearInReview(yearLibrary(), 2026);

  assert.equal(review.books, 2);
  assert.equal(review.pages, 118 + 192);
  assert.equal(review.minutes, 60 + 30 + 120, 'and only that year’s sittings');
  assert.equal(review.daysRead, 3);
});

test('the year names what was read most of', () => {
  const review = yearInReview(yearLibrary(), 2026);

  assert.equal(review.authors[0].label, 'H. G. Wells');
  assert.equal(review.authors[0].value, 2);
  assert.equal(review.genres[0].label, 'Science fiction');
  assert.equal(review.longest.title, 'The War of the Worlds');
  assert.equal(review.averageRating, 4.5);
});

test('the busiest month is measured in time at the page', () => {
  // Not in books finished: finishing is when a book ends, not when it was read.
  const review = yearInReview(yearLibrary(), 2026);

  assert.equal(review.busiestMonth.label, 'March');
  assert.equal(review.busiestMonth.minutes, 120);
});

test('a consecutive run is counted, and a gap ends it', () => {
  const review = yearInReview(yearLibrary(), 2026);
  assert.equal(review.streak, 2, '2 and 3 January are consecutive; March is not');
});

test('a year with nothing in it reports zeroes rather than throwing', () => {
  const review = yearInReview(yearLibrary(), 2024);

  assert.equal(review.books, 0);
  assert.equal(review.minutes, 0);
  assert.equal(review.streak, 0);
  assert.equal(review.busiestMonth, null);
  assert.equal(review.averageRating, null);
});

test('the years offered are the years with something in them, newest first', () => {
  assert.deepEqual(yearsWithReading(yearLibrary()), [2026, 2025]);
  assert.deepEqual(yearsWithReading([]), []);
});
