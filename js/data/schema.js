/**
 * The Book record.
 *
 * Two date pairs live on every book and they mean different things:
 *   schedule.{start,end}  the *plan* — what the calendar lays out and what
 *                         pacing targets are derived from
 *   actual.{startedAt,finishedAt}  what really happened
 * Keeping them apart is what lets the calendar say "planned" vs "in progress"
 * vs "finished that day", and lets pacing report whether you're behind.
 *
 * Fields for later phases (sessions, notes, shelves, rating, series) are
 * declared here from the start so the store's migration path stays boring.
 */

import { isValidKey, today } from '../lib/dates.js';

export const SCHEMA_VERSION = 2;

/** @type {Record<string, {id: string, label: string, hint: string}>} */
export const STATUSES = {
  planned: { id: 'planned', label: 'Planned', hint: 'On the shelf, dated to start' },
  reading: { id: 'reading', label: 'Reading', hint: 'Checked out and in progress' },
  finished: { id: 'finished', label: 'Finished', hint: 'Read to the end' },
  dnf: { id: 'dnf', label: 'Did not finish', hint: 'Set down for good' },
  'on-hold': { id: 'on-hold', label: 'On hold', hint: 'Paused, will return' },
};

export const STATUS_ORDER = ['reading', 'planned', 'on-hold', 'finished', 'dnf'];

export const FORMATS = {
  physical: { id: 'physical', label: 'Physical', unit: 'pages' },
  ebook: { id: 'ebook', label: 'Ebook', unit: 'pages' },
  audio: { id: 'audio', label: 'Audiobook', unit: 'minutes' },
};

/** Spine colours for the coverless fallback — deterministic per title. */
const SPINE_COLORS = ['#2c3a34', '#3d2f4a', '#4a3428', '#243a4a', '#4a2f38', '#33422a'];

export function spineColor(seed = '') {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return SPINE_COLORS[Math.abs(hash) % SPINE_COLORS.length];
}

export function newId(prefix = 'bk') {
  const rand =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ??
    Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** A blank book, ready for the add form. */
export function blankBook(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: newId(),
    title: '',
    author: '',
    isbn: '',
    pageCount: null,
    genre: '',
    format: 'physical',
    status: 'planned',
    series: { name: '', number: null, total: null },
    cover: { url: null, source: null },
    schedule: { start: null, end: null },
    actual: { startedAt: null, finishedAt: null },
    progress: { page: 0, percent: 0 },
    sessions: [],
    shelves: [],
    notes: '',
    rating: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/* --- Reading sessions ------------------------------------------------------
 *
 * A session is one sitting: a date, how long, and optionally where you got to.
 * Minutes and pages are both optional individually but a session with neither
 * records nothing, so validation requires at least one.
 * -------------------------------------------------------------------------- */

export function blankSession(overrides = {}) {
  return {
    id: newId('se'),
    date: null,
    minutes: null,
    pageFrom: null,
    pageTo: null,
    note: '',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function normalizeSession(input = {}) {
  const base = blankSession();
  const minutes = toInt(input.minutes);
  let pageFrom = toInt(input.pageFrom);
  let pageTo = toInt(input.pageTo);

  // Pages entered backwards are a slip, not an intent to read in reverse.
  if (pageFrom != null && pageTo != null && pageTo < pageFrom) {
    [pageFrom, pageTo] = [pageTo, pageFrom];
  }

  return {
    ...base,
    ...input,
    id: input.id || base.id,
    date: cleanKey(input.date),
    minutes: minutes != null && minutes > 0 ? minutes : null,
    pageFrom: pageFrom != null && pageFrom >= 0 ? pageFrom : null,
    pageTo: pageTo != null && pageTo >= 0 ? pageTo : null,
    note: String(input.note ?? '').trim(),
    createdAt: input.createdAt || base.createdAt,
  };
}

/** @returns {Record<string, string>} field -> message; empty means valid */
export function validateSession(session, book = null) {
  const errors = {};
  if (!session.date) errors.date = 'Pick the day you read.';
  if (session.minutes == null && session.pageTo == null) {
    errors.minutes = 'Record minutes, a page you reached, or both.';
  }
  if (session.minutes != null && session.minutes > 1440) {
    errors.minutes = 'That is more than a day of reading.';
  }
  if (book?.pageCount && session.pageTo != null && session.pageTo > book.pageCount) {
    errors.pageTo = `This book only has ${book.pageCount} ${FORMATS[book.format].unit}.`;
  }
  return errors;
}

/** Pages covered by a session, when it recorded enough to say. */
export function sessionPages(session) {
  if (session.pageTo == null) return 0;
  if (session.pageFrom == null) return 0;
  return Math.max(0, session.pageTo - session.pageFrom);
}

const toInt = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
};

const cleanKey = (value) => (isValidKey(value) ? value : null);

/**
 * Coerce arbitrary input (form values, imported JSON, an older record) into a
 * valid Book. Never throws — anything unusable becomes a sane default, so a
 * single corrupt field can't take down the whole library.
 *
 * @param {object} input
 * @param {string} [todayKey] - injectable "now" so this stays a pure function
 *   and the status rules can be tested without mocking the clock.
 */
export function normalizeBook(input = {}, todayKey = today()) {
  const base = blankBook();
  const title = String(input.title ?? '').trim();

  const pageCount = toInt(input.pageCount);
  const start = cleanKey(input.schedule?.start);
  let end = cleanKey(input.schedule?.end);
  // An end before the start is a slip of the finger, not an intent.
  if (start && end && end < start) end = start;

  const status = STATUSES[input.status] ? input.status : base.status;

  const book = {
    ...base,
    ...input,
    id: input.id || base.id,
    title,
    author: String(input.author ?? '').trim(),
    isbn: String(input.isbn ?? '').replace(/[^0-9Xx]/g, '').toUpperCase(),
    pageCount: pageCount && pageCount > 0 ? pageCount : null,
    genre: String(input.genre ?? '').trim(),
    format: FORMATS[input.format] ? input.format : base.format,
    status,
    series: {
      name: String(input.series?.name ?? '').trim(),
      number: toInt(input.series?.number),
      total: toInt(input.series?.total),
    },
    cover: {
      url: input.cover?.url || null,
      source: input.cover?.source || null,
    },
    schedule: { start, end },
    actual: {
      startedAt: cleanKey(input.actual?.startedAt),
      finishedAt: cleanKey(input.actual?.finishedAt),
    },
    progress: {
      page: Math.max(0, toInt(input.progress?.page) ?? 0),
      percent: Math.min(100, Math.max(0, Number(input.progress?.percent) || 0)),
    },
    sessions: (Array.isArray(input.sessions) ? input.sessions : [])
      .map(normalizeSession)
      .filter((session) => session.date)
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)),
    shelves: Array.isArray(input.shelves) ? input.shelves : [],
    notes: String(input.notes ?? ''),
    rating: toInt(input.rating),
    createdAt: input.createdAt || base.createdAt,
    updatedAt: new Date().toISOString(),
  };

  return applyStatusRules(book, todayKey);
}

/**
 * Keep status and dates from contradicting each other.
 * Marking a book finished logs today's date if none was given; un-finishing it
 * clears that stamp so a stale finish date can't linger and skew stats.
 */
export function applyStatusRules(book, todayKey = today()) {
  const day = todayKey;
  const next = { ...book, actual: { ...book.actual } };

  if (next.status === 'finished') {
    next.actual.finishedAt ??= day;
    next.actual.startedAt ??= next.schedule.start ?? next.actual.finishedAt;
    if (next.pageCount) next.progress = { page: next.pageCount, percent: 100 };
  } else {
    next.actual.finishedAt = null;
  }

  if (next.status === 'reading') {
    next.actual.startedAt ??= next.schedule.start ?? day;
  }

  // The log is the source of truth for how far in you are. Enforcing it here
  // rather than only on the store's write path means a book loaded from disk,
  // imported, or migrated can never disagree with its own sessions. Deleting a
  // session doesn't walk progress backwards — the page field stays editable
  // for the rare case where that's actually wanted.
  const furthestLogged = (next.sessions ?? []).reduce(
    (max, session) => Math.max(max, session.pageTo ?? 0),
    0
  );
  if (furthestLogged > next.progress.page) {
    next.progress = { ...next.progress, page: furthestLogged, percent: 0 };
  }

  // Derive whichever half of progress the user didn't supply.
  if (next.pageCount && next.status !== 'finished') {
    if (next.progress.page > 0) {
      next.progress.percent = Math.min(100, (next.progress.page / next.pageCount) * 100);
    } else if (next.progress.percent > 0) {
      next.progress.page = Math.round((next.progress.percent / 100) * next.pageCount);
    }
  }

  return next;
}

/**
 * Validate a book for saving.
 * @returns {Record<string, string>} field name -> message. Empty means valid.
 */
export function validateBook(book) {
  const errors = {};

  if (!book.title?.trim()) errors.title = 'A title is required.';
  if (book.pageCount != null && (book.pageCount < 1 || book.pageCount > 50000)) {
    errors.pageCount = 'Enter a length between 1 and 50,000.';
  }
  if (book.isbn && ![10, 13].includes(book.isbn.length)) {
    errors.isbn = 'An ISBN is 10 or 13 characters.';
  }
  if (book.schedule.start && book.schedule.end && book.schedule.end < book.schedule.start) {
    errors['schedule.end'] = 'The finish date falls before the start date.';
  }
  if (book.rating != null && (book.rating < 1 || book.rating > 5)) {
    errors.rating = 'Rate between 1 and 5.';
  }

  return errors;
}
