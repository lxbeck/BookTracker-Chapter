/**
 * The store: one in-memory library, persisted to localStorage, with a
 * subscribe/notify loop that views re-render from.
 *
 * Everything mutating goes through `commit`, which is the only place that
 * writes to disk and the only place that notifies. That single choke point is
 * what makes swapping localStorage for IndexedDB — or for a real API when this
 * grows a backend — a change to one function rather than a rewrite.
 */

import {
  SCHEMA_VERSION,
  normalizeBook,
  applyStatusRules,
  validateBook,
  normalizeSession,
  validateSession,
} from './schema.js';
import { addDays, daysBetween } from '../lib/dates.js';

const STORAGE_KEY = 'chapter.library.v1';

/** @type {{version: number, books: Object[], settings: Object}} */
let state = { version: SCHEMA_VERSION, books: [], settings: { weekStartsOn: 0 } };

/** @type {Set<(state: object) => void>} */
const listeners = new Set();

let persistFailed = false;
let lastSavedAt = null;

/* --- Persistence ---------------------------------------------------------- */

function load() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing, blocked storage. The app still runs, in memory only.
    persistFailed = true;
    return;
  }
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);
    state = migrate(parsed);
  } catch (error) {
    console.error('[chapter] Could not read the saved library.', error);
    // Keep the unreadable copy rather than silently overwriting someone's data.
    try {
      localStorage.setItem(`${STORAGE_KEY}.recovered.${Date.now()}`, raw);
    } catch {
      /* nothing more we can do */
    }
  }
}

/** Bring an older saved shape up to the current schema. */
function migrate(saved) {
  const version = Number(saved?.version) || 0;
  const books = Array.isArray(saved?.books) ? saved.books : [];
  // v0 -> v1: straight normalise.
  // v1 -> v2: sessions array gained real structure; normalizeBook handles it,
  //           and a v1 record's empty sessions array survives untouched.
  if (version < SCHEMA_VERSION) {
    return {
      version: SCHEMA_VERSION,
      settings: { weekStartsOn: 0, ...saved?.settings },
      books: books.map(normalizeBook),
    };
  }
  return {
    version: SCHEMA_VERSION,
    settings: { weekStartsOn: 0, ...saved?.settings },
    books,
  };
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    persistFailed = false;
    lastSavedAt = new Date();
  } catch (error) {
    persistFailed = true;
    console.error('[chapter] Could not save the library.', error);
    notifyError(
      error?.name === 'QuotaExceededError'
        ? 'Storage is full. Remove an uploaded cover or two, then try again.'
        : 'Changes are not being saved. Check that this browser allows site storage.'
    );
  }
}

/** @type {(message: string) => void} */
let notifyError = () => {};

/** Let the app wire in its own error surface (a toast, usually). */
export function onPersistError(handler) {
  notifyError = handler;
}

export const isPersisting = () => !persistFailed;

/**
 * Everything needed to answer "is my library actually saved?" without asking
 * the user to take it on faith.
 *
 * `bytes` is the real serialised size, measured rather than estimated, so the
 * readout is honest about how close the library is to the storage ceiling.
 */
export function storageStatus() {
  let bytes = 0;
  let readable = false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    bytes = raw ? new Blob([raw]).size : 0;
    readable = raw != null;
  } catch {
    readable = false;
  }

  return {
    saving: !persistFailed,
    // A library that has never been written is not the same as one that failed.
    saved: readable && !persistFailed,
    lastSavedAt,
    bytes,
    books: state.books.length,
    key: STORAGE_KEY,
  };
}

/**
 * Ask the browser not to evict this data under storage pressure. Silently
 * declined by most browsers unless the site is installed or frequently used,
 * which is fine — it only ever improves the odds.
 */
export async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/* --- Core loop ------------------------------------------------------------ */

function commit(mutator) {
  const result = mutator();
  persist();
  for (const listener of listeners) listener(state);
  return result;
}

/** Subscribe to every change. Returns an unsubscribe function. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function init() {
  load();
  return state;
}

/* --- Reads ---------------------------------------------------------------- */

export const getState = () => state;
export const allBooks = () => state.books;
export const getBook = (id) => state.books.find((book) => book.id === id) ?? null;
export const getSettings = () => state.settings;

export const booksByStatus = (status) => state.books.filter((book) => book.status === status);

/** Books whose *plan* covers a given day. */
export const booksScheduledOn = (dayKey) =>
  state.books.filter(
    (book) =>
      book.schedule.start &&
      book.schedule.start <= dayKey &&
      (book.schedule.end ?? book.schedule.start) >= dayKey
  );

/* --- Writes --------------------------------------------------------------- */

/**
 * Add a book.
 * @returns {{ok: true, book: object} | {ok: false, errors: object}}
 */
export function addBook(input) {
  const book = normalizeBook(input);
  const errors = validateBook(book);
  if (Object.keys(errors).length) return { ok: false, errors };

  commit(() => {
    state.books.push(book);
  });
  return { ok: true, book };
}

/**
 * Patch an existing book. Nested objects are merged one level deep so callers
 * can send `{schedule: {start}}` without clobbering `schedule.end`.
 * @returns {{ok: true, book: object} | {ok: false, errors: object}}
 */
export function updateBook(id, patch) {
  const existing = getBook(id);
  if (!existing) return { ok: false, errors: { _: 'That book is no longer in the library.' } };

  const merged = normalizeBook({
    ...existing,
    ...patch,
    series: { ...existing.series, ...patch.series },
    cover: { ...existing.cover, ...patch.cover },
    schedule: { ...existing.schedule, ...patch.schedule },
    actual: { ...existing.actual, ...patch.actual },
    progress: { ...existing.progress, ...patch.progress },
    id: existing.id,
    createdAt: existing.createdAt,
  });

  const errors = validateBook(merged);
  if (Object.keys(errors).length) return { ok: false, errors };

  commit(() => {
    state.books = state.books.map((book) => (book.id === id ? merged : book));
  });
  return { ok: true, book: merged };
}

export function removeBook(id) {
  const book = getBook(id);
  if (!book) return { ok: false };
  commit(() => {
    state.books = state.books.filter((entry) => entry.id !== id);
  });
  return { ok: true, book };
}

/** Restore a removed book in place — powers undo on delete. */
export function restoreBook(book) {
  commit(() => {
    if (!getBook(book.id)) state.books.push(book);
  });
}

export function setStatus(id, status) {
  const book = getBook(id);
  if (!book) return { ok: false };
  return updateBook(id, applyStatusRules({ ...book, status }));
}

/** Move a plan to a new start date, preserving its length. Used by drag-drop. */
export function rescheduleBook(id, newStart, { keepSpan = true } = {}) {
  const book = getBook(id);
  if (!book) return { ok: false };

  let end = book.schedule.end;
  if (keepSpan && book.schedule.start && book.schedule.end) {
    end = addDays(newStart, daysBetween(book.schedule.start, book.schedule.end));
  }
  return updateBook(id, { schedule: { start: newStart, end } });
}

/* --- Reading sessions ----------------------------------------------------- */

/**
 * Log a sitting.
 *
 * Logging is also the most reliable signal that a book is being read, so it
 * moves a planned book to reading and stamps a real start date if there isn't
 * one. Progress follows the furthest page ever logged (see normalizeBook) —
 * sessions can be entered out of order, and a backdated session shouldn't drag
 * progress backwards.
 *
 * @returns {{ok: true, session: object, book: object} | {ok: false, errors: object}}
 */
export function addSession(bookId, input) {
  const book = getBook(bookId);
  if (!book) return { ok: false, errors: { _: 'That book is no longer in the library.' } };

  const session = normalizeSession(input);
  const errors = validateSession(session, book);
  if (Object.keys(errors).length) return { ok: false, errors };

  const sessions = [...book.sessions, session];
  const result = applySessions(book, sessions);
  return result.ok ? { ...result, session } : result;
}

export function updateSession(bookId, sessionId, patch) {
  const book = getBook(bookId);
  if (!book) return { ok: false, errors: { _: 'That book is no longer in the library.' } };

  const existing = book.sessions.find((entry) => entry.id === sessionId);
  if (!existing) return { ok: false, errors: { _: 'That session is gone.' } };

  const session = normalizeSession({ ...existing, ...patch, id: sessionId });
  const errors = validateSession(session, book);
  if (Object.keys(errors).length) return { ok: false, errors };

  return applySessions(
    book,
    book.sessions.map((entry) => (entry.id === sessionId ? session : entry))
  );
}

export function removeSession(bookId, sessionId) {
  const book = getBook(bookId);
  if (!book) return { ok: false };
  return applySessions(
    book,
    book.sessions.filter((entry) => entry.id !== sessionId)
  );
}

/** Write a new session list and re-derive everything that follows from it. */
function applySessions(book, sessions) {
  const dates = sessions.map((session) => session.date).sort();
  const patch = { sessions };

  if (dates.length) {
    // The earliest logged day is the truest start date we have.
    patch.actual = { startedAt: dates[0] };
    if (book.status === 'planned' || book.status === 'on-hold') patch.status = 'reading';
  }

  // Progress itself is derived in normalizeBook, so it stays correct whether a
  // session arrives through here or through an import.
  return updateBook(book.id, patch);
}

export function updateSettings(patch) {
  commit(() => {
    state.settings = { ...state.settings, ...patch };
  });
  return state.settings;
}

/** Replace the whole library — used by seeding and, later, import. */
export function replaceAll(books, { settings } = {}) {
  commit(() => {
    state.books = books.map(normalizeBook);
    if (settings) state.settings = { ...state.settings, ...settings };
  });
}
