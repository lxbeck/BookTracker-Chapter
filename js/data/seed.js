/**
 * Sample library.
 *
 * Loaded on demand from the empty state — never automatically, because
 * silently inventing someone's data is a bad first impression. Dates are
 * generated relative to today so the calendar always has something on it,
 * whenever the app is opened.
 */

import { addDays, today } from '../lib/dates.js';
import { replaceAll } from './store.js';
import { coverUrlForIsbn } from './covers.js';

const withCover = (isbn) => ({ url: coverUrlForIsbn(isbn, 'L'), source: 'openlibrary' });

export function sampleBooks(from = today()) {
  const day = (offset) => addDays(from, offset);

  return [
    {
      title: 'A Princess of Mars',
      author: 'Edgar Rice Burroughs',
      isbn: '9780486436173',
      pageCount: 176,
      genre: 'Adventure',
      format: 'physical',
      status: 'reading',
      series: { name: 'Barsoom', number: 1, total: 3 },
      cover: withCover('9780486436173'),
      schedule: { start: day(-6), end: day(4) },
      sessions: [
        { date: day(-6), minutes: 55, pageFrom: 0, pageTo: 24 },
        { date: day(-5), minutes: 40, pageFrom: 24, pageTo: 41 },
        { date: day(-3), minutes: 70, pageFrom: 41, pageTo: 71 },
        { date: day(-1), minutes: 35, pageFrom: 71, pageTo: 85 },
      ],
    },
    {
      title: 'The Gods of Mars',
      author: 'Edgar Rice Burroughs',
      isbn: '9780486450896',
      pageCount: 192,
      genre: 'Adventure',
      format: 'physical',
      status: 'planned',
      series: { name: 'Barsoom', number: 2, total: 3 },
      cover: withCover('9780486450896'),
      schedule: { start: day(5), end: day(17) },
    },
    {
      title: 'The War of the Worlds',
      author: 'H. G. Wells',
      isbn: '9780486295060',
      pageCount: 192,
      genre: 'Science fiction',
      format: 'audio',
      status: 'reading',
      cover: withCover('9780486295060'),
      schedule: { start: day(-2), end: day(8) },
      sessions: [
        { date: day(-2), minutes: 95, pageFrom: 0, pageTo: 18 },
        { date: day(-1), minutes: 115, pageFrom: 18, pageTo: 41 },
      ],
    },
    {
      title: 'The Time Machine',
      author: 'H. G. Wells',
      isbn: '9780486284729',
      pageCount: 118,
      genre: 'Fantasy',
      format: 'ebook',
      status: 'planned',
      cover: withCover('9780486284729'),
      schedule: { start: day(1), end: day(3) },
    },
    {
      title: 'Jane Eyre',
      author: 'Charlotte Bronte',
      isbn: '9780141441146',
      pageCount: 532,
      genre: 'Fantasy',
      format: 'physical',
      status: 'planned',
      cover: withCover('9780141441146'),
      schedule: { start: day(2), end: day(12) },
    },
    {
      title: 'The Strange Case of Dr Jekyll and Mr Hyde',
      author: 'Robert Louis Stevenson',
      isbn: '9780486266886',
      pageCount: 141,
      genre: 'Gothic',
      format: 'physical',
      status: 'finished',
      cover: withCover('9780486266886'),
      schedule: { start: day(-20), end: day(-12) },
      actual: { startedAt: day(-20), finishedAt: day(-11) },
      sessions: [
        { date: day(-20), minutes: 50, pageFrom: 0, pageTo: 35 },
        { date: day(-16), minutes: 65, pageFrom: 35, pageTo: 83 },
        { date: day(-11), minutes: 80, pageFrom: 83, pageTo: 141 },
      ],
      rating: 5,
    },
    {
      title: 'The Warlord of Mars',
      author: 'Edgar Rice Burroughs',
      isbn: '9780486456461',
      pageCount: 160,
      genre: 'Adventure',
      format: 'physical',
      status: 'planned',
      series: { name: 'Barsoom', number: 3, total: 3 },
      cover: withCover('9780486456461'),
      schedule: { start: day(18), end: day(30) },
    },
    {
      title: 'The Turn of the Screw',
      author: 'Henry James',
      isbn: '9780486266848',
      pageCount: 121,
      genre: 'Gothic',
      format: 'ebook',
      status: 'on-hold',
      cover: withCover('9780486266848'),
      schedule: { start: null, end: null },
      progress: { page: 30 },
    },
  ];
}

/** Replaces the current library. The caller is responsible for confirming. */
export function loadSampleLibrary() {
  replaceAll(sampleBooks());
}
