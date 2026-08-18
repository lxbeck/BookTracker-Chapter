/**
 * The store: one in-memory library, persisted to localStorage, with a
 * subscribe/notify loop that views re-render from.
 *
 * Everything mutating goes through `commit`, which is the only place that
 * writes to disk and the only place that notifies. That single choke point is
 * what makes swapping localStorage for IndexedDB — or for a real API when this
 * grows a backend — a change to one function rather than a rewrite.
 */

import { SCHEMA_VERSION, normalizeBook, applyStatusRules, validateBook } from './schema.js';
import { addDays, daysBetween } from '../lib/dates.js';

const STORAGE_KEY = 'chapter.library.v1';

/** @type {{version: number, books: Object[], settings: Object}} */
let state = { version: SCHEMA_VERSION, books: [], settings: { weekStartsOn: 0 } };

/** @type {Set<(state: object) => void>} */
const listeners = new Set();

let persistFailed = false;

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
  // v0 -> v1 is a straight normalise; later versions slot in here as cases.
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
