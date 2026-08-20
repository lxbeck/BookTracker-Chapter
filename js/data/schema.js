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

export const SCHEMA_VERSION = 8;

/** @type {Record<string, {id: string, label: string, hint: string}>} */
export const STATUSES = {
  // "Planned" means dated. Everything you own but haven't scheduled needs its
  // own home — lumping an unscheduled backlog in with a dated plan makes the
  // planned shelf useless as a picture of what's actually coming up.
  backlog: { id: 'backlog', label: 'Backlog', hint: 'Owned, not yet scheduled' },
  planned: { id: 'planned', label: 'Planned', hint: 'On the shelf, dated to start' },
  reading: { id: 'reading', label: 'Reading', hint: 'Checked out and in progress' },
  finished: { id: 'finished', label: 'Finished', hint: 'Read to the end' },
  dnf: { id: 'dnf', label: 'Did not finish', hint: 'Set down for good' },
  'on-hold': { id: 'on-hold', label: 'On hold', hint: 'Paused, will return' },
};

export const STATUS_ORDER = ['reading', 'planned', 'backlog', 'on-hold', 'finished', 'dnf'];

/**
 * What kind of thing this is, as distinct from how you read it.
 *
 * Format answers "paper, screen or ears"; category answers "is this a novel or
 * a single issue". Both matter and neither implies the other — a manga volume
 * can be physical or an ebook — so a stats line reading "8 books finished" is
 * misleading when four are single comics.
 */
export const CATEGORIES = {
  book: { id: 'book', label: 'Book', plural: 'books' },
  comic: { id: 'comic', label: 'Comic', plural: 'comics' },
  manga: { id: 'manga', label: 'Manga', plural: 'manga volumes' },
  graphicNovel: { id: 'graphicNovel', label: 'Graphic novel', plural: 'graphic novels' },
  anthology: { id: 'anthology', label: 'Anthology', plural: 'anthologies' },
  nonfiction: { id: 'nonfiction', label: 'Non-fiction', plural: 'non-fiction' },
};

export const CATEGORY_ORDER = ['book', 'nonfiction', 'comic', 'graphicNovel', 'manga', 'anthology'];

/**
 * Whether a book passes the current selection.
 *
 * An empty selection, or one with everything in it, means no filtering —
 * "everything" is the absence of a choice rather than a fourth switch, so
 * turning the last one off can never leave an empty calendar with no way back.
 */
export function matchesKinds(book, selected) {
  if (!selected || selected.size === 0) return true;
  // Categories, not groups. Collapsing graphic novels into comics and
  // non-fiction into books was a reasonable simplification when there were six
  // fixed kinds and no way to add more; it stops being reasonable the moment
  // someone shelves research papers and finds them filed as "Books" with no
  // way to see them on their own.
  return selected.has(book.category);
}

export const FORMATS = {
  physical: { id: 'physical', label: 'Physical', unit: 'pages' },
  ebook: { id: 'ebook', label: 'Ebook', unit: 'pages' },
  audio: { id: 'audio', label: 'Audiobook', unit: 'minutes' },
};

/**
 * Books have formats, plural.
 *
 * Reading the paperback with the audiobook playing is one book being read one
 * time, not two books — the same story, the same progress, the same finish
 * date. Two records for it would double every count, split the reading log in
 * half, and need the schedule kept in step by hand.
 *
 * (A comic and its audio drama are a different matter and should stay two
 * records: different scripts, different lengths, different things.)
 */
export const FORMAT_PRIORITY = ['physical', 'ebook', 'audio'];

/**
 * The format that decides how this book is measured.
 *
 * Pages beat minutes. A book being read on paper while its audiobook plays has
 * a page count that means something and a running time that is a property of
 * one recording, and progress you can check against the object in your hands
 * is the one worth tracking.
 */
export const primaryFormat = (book) =>
  FORMAT_PRIORITY.find((id) => book?.formats?.includes(id)) ?? book?.format ?? 'physical';

/** Pages or minutes, for every label and every pacing figure. */
export const formatUnit = (book) => FORMATS[primaryFormat(book)]?.unit ?? 'pages';

export const hasFormat = (book, id) =>
  Array.isArray(book?.formats) ? book.formats.includes(id) : book?.format === id;

/** "Physical and audiobook", for a card that has room for one line. */
export const formatLabel = (book) => {
  const ids = book?.formats?.length ? book.formats : [book?.format].filter(Boolean);
  const labels = FORMAT_PRIORITY.filter((id) => ids.includes(id)).map((id) => FORMATS[id].label);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1].toLowerCase()}`;
};

/**
 * Spine colours for the coverless fallback — deterministic per title, so a
 * book keeps the same spine every time you see it.
 *
 * Drawn from the blue-slate chrome rather than against it: these sit next to
 * real cover art on the calendar, so they should read as "a book we have no
 * picture of" rather than as an error state.
 */
const SPINE_COLORS = [
  '#2b4257', // slate blue
  '#334a63', // lighter slate
  '#3a3f63', // indigo
  '#2f4a5c', // teal-slate
  '#443a5e', // muted violet
  '#25384a', // deep navy
];

export function spineColor(seed = '') {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return SPINE_COLORS[Math.abs(hash) % SPINE_COLORS.length];
}

function newId(prefix = 'bk') {
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
    description: '',
    format: 'physical',
    formats: ['physical'],
    category: 'book',
    status: 'planned',
    series: { name: '', number: null, total: null },
    cover: { url: null, source: null },
    // `rebase` is what "catch me up" writes: from that day, the remaining
    // pages are spread over the remaining days instead of the original plan.
    schedule: { start: null, end: null, rebase: null },
    actual: { startedAt: null, finishedAt: null },
    progress: { page: 0, percent: 0 },
    sessions: [],
    shelves: [],
    notes: '',
    quotes: [],
    rating: null,
    review: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/* --- Reading orders --------------------------------------------------------
 *
 * A named, ordered list of books: "Poe tales, in publication order",
 * "manga backlog", "the Barsoom reread". Separate from shelves because a
 * shelf is a set and this is a sequence — the whole point is position.
 *
 * A book can sit in any number of orders at once, so membership lives on the
 * order rather than on the book. Putting a `readingOrders: []` array on each
 * book instead would mean the position of book #7 is stored on book #7, and
 * reordering a fifty-book list would touch fifty records on every drag.
 * -------------------------------------------------------------------------- */

function blankOrder(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: newId('ro'),
    name: '',
    description: '',
    bookIds: [],
    // Where this list sits among the others. Null means "not placed yet" and
    // sorts to the end, which is where a newly made list belongs.
    position: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function normalizeOrder(input = {}) {
  const base = blankOrder();
  return {
    ...base,
    ...input,
    id: input.id || base.id,
    name: String(input.name ?? '').trim().slice(0, 120),
    description: String(input.description ?? '').trim().slice(0, 500),
    // Duplicates would make "position in the list" ambiguous, and a book can
    // only be in one place in a sequence.
    bookIds: [...new Set((Array.isArray(input.bookIds) ? input.bookIds : []).map(String))],
    position: Number.isFinite(input.position) ? input.position : null,
    createdAt: input.createdAt || base.createdAt,
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

export function validateOrder(order) {
  const errors = {};
  if (!order.name?.trim()) errors.name = 'Give this list a name.';
  return errors;
}

/* --- Reading sessions ------------------------------------------------------
 *
 * A session is one sitting: a date, how long, and optionally where you got to.
 * Minutes and pages are both optional individually but a session with neither
 * records nothing, so validation requires at least one.
 * -------------------------------------------------------------------------- */

function blankSession(overrides = {}) {
  return {
    id: newId('se'),
    via: null,
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
    // How this sitting happened, when the book is more than one thing. Null
    // means "not stated", which is every session logged before the field
    // existed and every book that only comes in one form.
    via: FORMATS[input.via] ? input.via : null,
    createdAt: input.createdAt || base.createdAt,
  };
}

/** @returns {Record<string, string>} field -> message; empty means valid */
export function validateSession(session, book = null) {
  const errors = {};
  if (!session.date) errors.date = 'Pick the day you read.';
  if (session.minutes == null && session.pageTo == null) {
    // Minutes are optional on purpose: often you know you got from 40% to 60%
    // and have no idea how long it took. One or the other is enough.
    errors.minutes = 'Record where you got to, or how long you read \u2014 either will do.';
  }
  if (session.minutes != null && session.minutes > 1440) {
    errors.minutes = 'That is more than a day of reading.';
  }
  if (book?.pageCount && session.pageTo != null && session.pageTo > book.pageCount) {
    errors.pageTo = `This book only has ${book.pageCount} ${formatUnit(book)}.`;
  }
  return errors;
}

/** Pages covered by a session, when it recorded enough to say. */
export function sessionPages(session) {
  if (session.pageTo == null) return 0;
  if (session.pageFrom == null) return 0;
  return Math.max(0, session.pageTo - session.pageFrom);
}

/**
 * The formats a record claims, as a clean list.
 *
 * Accepts either shape, because a book saved before formats were plural has
 * only `format`, and an import may carry either. An empty list is impossible:
 * a book with no format at all has no unit, and every pacing figure derived
 * from it would silently fall back to pages anyway.
 */
function cleanFormats(input = {}) {
  const listed = Array.isArray(input.formats)
    ? input.formats.filter((id) => FORMATS[id])
    : null;

  // The list wins outright when there is one. Merging `format` into it — which
  // is what this used to do — made unticking a box impossible: a save carrying
  // formats ['ebook'] was patched over a record whose stale `format` still
  // said 'physical', the two were combined, and the book came back with both
  // boxes ticked again. The primary is *derived* from the list, so it can
  // never be evidence about the list.
  const list = listed?.length
    ? listed
    : FORMATS[input.format] ? [input.format] : [];

  const unique = FORMAT_PRIORITY.filter((id) => list.includes(id));
  return unique.length ? unique : ['physical'];
}

/** A kind id: safe to put in a class name, a filter and a settings list. */
export const cleanCategory = (value) =>
  String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 40);

const toInt = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * A place in a series, which may be fractional.
 *
 * Kept to two decimals: 4.5 is the everyday case, 4.25 exists, and anything
 * finer is a floating-point artefact rather than a number anyone typed.
 * Negative is meaningless — a prequel is #0 or #0.5, not #-1.
 */
const toSeriesNumber = (value) => {
  if (value === '' || value == null) return null;
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
};

const cleanKey = (value) => (isValidKey(value) ? value : null);

/** A rebase is only meaningful with both a day and a page to start from. */
function cleanRebase(rebase) {
  const at = cleanKey(rebase?.at);
  const page = Number.parseInt(rebase?.page, 10);
  if (!at || !Number.isFinite(page) || page < 0) return null;
  // originalStart is kept so the record can still say when you first meant to
  // begin, even though the plan itself now starts later.
  return { at, page, originalStart: cleanKey(rebase?.originalStart) };
}

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
    description: String(input.description ?? '').trim().slice(0, 2000),
    formats: cleanFormats(input),
    // Kept in step with `formats` rather than stored independently: two fields
    // that can disagree about the same fact will eventually disagree.
    format: primaryFormat({ formats: cleanFormats(input), format: input.format }),
    // Not checked against the built-in list any more: kinds are extensible in
    // Settings, and a record naming a kind this device has not heard of yet
    // (added on another device, arriving by sync) must keep it rather than be
    // silently reclassified as a book.
    category: cleanCategory(input.category) || base.category,
    status,
    series: {
      name: String(input.series?.name ?? '').trim(),
      // Not an integer: half-numbered volumes are real and common. A side
      // story published between books four and five is #4.5, an omnibus of
      // the first three is sometimes #1-3, and rounding either to a whole
      // number puts it in the wrong place in every sequence it appears in.
      number: toSeriesNumber(input.series?.number),
      total: toInt(input.series?.total),
    },
    cover: {
      url: input.cover?.url || null,
      source: input.cover?.source || null,
    },
    schedule: { start, end, rebase: cleanRebase(input.schedule?.rebase) },
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
    shelves: (Array.isArray(input.shelves) ? input.shelves : [])
      .map((shelf) => String(shelf).trim())
      .filter(Boolean)
      // Shelf names are matched case-insensitively but kept as typed, so
      // "Book Club" and "book club" never become two shelves.
      .filter((shelf, index, all) =>
        all.findIndex((other) => other.toLowerCase() === shelf.toLowerCase()) === index
      ),
    notes: String(input.notes ?? ''),
    quotes: (Array.isArray(input.quotes) ? input.quotes : [])
      .map((quote) => ({
        id: quote.id || newId('qt'),
        text: String(quote.text ?? '').trim(),
        page: toInt(quote.page),
        createdAt: quote.createdAt || new Date().toISOString(),
      }))
      .filter((quote) => quote.text),
    rating: toInt(input.rating),
    review: String(input.review ?? '').trim().slice(0, 4000),
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

  // Planned means dated. Removing the dates from a planned book drops it back
  // to the backlog rather than leaving it claiming a plan it hasn't got.
  if (next.status === 'planned' && !next.schedule.start) next.status = 'backlog';
  if (next.status === 'backlog' && next.schedule.start) next.status = 'planned';

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

/* --- Progress ---------------------------------------------------------------
 *
 * Progress can be given either way round: a page number, or a percentage for
 * when you're reading something without page numbers, or just eyeballing the
 * thickness of what's left. Both halves are stored, always consistent.
 * -------------------------------------------------------------------------- */

/**
 * @param {object} book
 * @param {{page?: number, percent?: number}} input - supply one; the other follows
 * @returns {{page: number, percent: number}}
 */
export function resolveProgress(book, input) {
  const total = book.pageCount ?? 0;

  if (input.percent != null && input.percent !== '') {
    const percent = Math.min(100, Math.max(0, Number(input.percent) || 0));
    return {
      percent,
      // Without a length there is no page to derive, and inventing one would
      // put a fictional number into every pacing figure downstream.
      page: total ? Math.round((percent / 100) * total) : 0,
    };
  }

  const page = Math.max(0, Number.parseInt(input.page, 10) || 0);
  return {
    page: total ? Math.min(page, total) : page,
    percent: total ? Math.min(100, (page / total) * 100) : 0,
  };
}
