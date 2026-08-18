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
  normalizeOrder,
  validateOrder,
  resolveProgress,
} from './schema.js';
import { addDays, daysBetween } from '../lib/dates.js';

const STORAGE_KEY = 'chapter.library.v1';

/** @type {{version: number, books: Object[], settings: Object}} */
let state = {
  version: SCHEMA_VERSION,
  books: [],
  settings: { weekStartsOn: 0 },
  // Deletions are recorded, not just applied. Without a tombstone, a device
  // that never saw the delete would push the book back on its next sync.
  deleted: [],
  readingOrders: [],
  settingsUpdatedAt: undefined,
};

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
  const shared = {
    version: SCHEMA_VERSION,
    settings: { weekStartsOn: 0, ...saved?.settings },
    deleted: Array.isArray(saved?.deleted) ? saved.deleted : [],
    // v4 -> v5 adds reading orders; older saves simply have none.
    readingOrders: (Array.isArray(saved?.readingOrders) ? saved.readingOrders : []).map(normalizeOrder),
    settingsUpdatedAt: saved?.settingsUpdatedAt,
  };

  return version < SCHEMA_VERSION
    ? { ...shared, books: books.map(normalizeBook) }
    : { ...shared, books };
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
        ? 'Browser storage is full. Open Settings and use "Reclaim space" — uploaded covers are usually the cause, and they can be moved out of the way without losing them.'
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
    state.deleted = [
      ...(state.deleted ?? []).filter((entry) => entry.id !== id),
      { id, at: new Date().toISOString() },
    ];
  });
  return { ok: true, book };
}

/** Restore a removed book in place — powers undo on delete. */
export function restoreBook(book) {
  commit(() => {
    if (!getBook(book.id)) {
      // Bump updatedAt so the restore outranks its own tombstone everywhere.
      state.books.push({ ...book, updatedAt: new Date().toISOString() });
    }
    state.deleted = (state.deleted ?? []).filter((entry) => entry.id !== book.id);
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

/* --- Reading orders ------------------------------------------------------- */

export const allOrders = () => state.readingOrders;
export const getOrder = (id) => state.readingOrders.find((order) => order.id === id) ?? null;

/** Every order a given book appears in. */
export const ordersContaining = (bookId) =>
  state.readingOrders.filter((order) => order.bookIds.includes(bookId));

/** Position of a book within an order, or Infinity when it isn't in it. */
export function positionInOrder(orderId, bookId) {
  const index = getOrder(orderId)?.bookIds.indexOf(bookId) ?? -1;
  return index === -1 ? Infinity : index;
}

export function createOrder(input) {
  const order = normalizeOrder(input);
  const errors = validateOrder(order);
  if (Object.keys(errors).length) return { ok: false, errors };

  commit(() => {
    state.readingOrders.push(order);
  });
  return { ok: true, order };
}

export function updateOrder(id, patch) {
  const existing = getOrder(id);
  if (!existing) return { ok: false, errors: { _: 'That list is gone.' } };

  const merged = normalizeOrder({
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });

  const errors = validateOrder(merged);
  if (Object.keys(errors).length) return { ok: false, errors };

  commit(() => {
    state.readingOrders = state.readingOrders.map((order) => (order.id === id ? merged : order));
  });
  return { ok: true, order: merged };
}

export function removeOrder(id) {
  const order = getOrder(id);
  if (!order) return { ok: false };
  commit(() => {
    state.readingOrders = state.readingOrders.filter((entry) => entry.id !== id);
    // Orders share the tombstone list with books; ids are prefixed, so they
    // can never collide.
    state.deleted = [
      ...(state.deleted ?? []).filter((entry) => entry.id !== id),
      { id, at: new Date().toISOString() },
    ];
  });
  return { ok: true, order };
}

/** Append books, skipping any already in the list. */
export function addToOrder(orderId, bookIds) {
  const order = getOrder(orderId);
  if (!order) return { ok: false };

  const incoming = [].concat(bookIds).filter((id) => !order.bookIds.includes(id));
  if (!incoming.length) return { ok: true, order, added: 0 };

  const result = updateOrder(orderId, { bookIds: [...order.bookIds, ...incoming] });
  return result.ok ? { ...result, added: incoming.length } : result;
}

export function removeFromOrder(orderId, bookId) {
  const order = getOrder(orderId);
  if (!order) return { ok: false };
  return updateOrder(orderId, { bookIds: order.bookIds.filter((id) => id !== bookId) });
}

/**
 * Move a book to a new index within its list.
 * Clamped rather than rejected: dragging past the end means "put it last".
 */
export function moveInOrder(orderId, bookId, toIndex) {
  const order = getOrder(orderId);
  if (!order) return { ok: false };

  const from = order.bookIds.indexOf(bookId);
  if (from === -1) return { ok: false };

  const next = [...order.bookIds];
  next.splice(from, 1);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, bookId);
  return updateOrder(orderId, { bookIds: next });
}

/** Set progress from either a page or a percentage; both are kept in step. */
export function setProgress(bookId, input) {
  const book = getBook(bookId);
  if (!book) return { ok: false };
  return updateBook(bookId, { progress: resolveProgress(book, input) });
}

export function updateSettings(patch) {
  commit(() => {
    state.settings = { ...state.settings, ...patch };
    state.settingsUpdatedAt = new Date().toISOString();
  });
  return state.settings;
}

/**
 * Adopt a merged state that came from the server.
 *
 * Separate from replaceAll because the records are already normalised and
 * already carry their own timestamps — re-normalising would stamp every book
 * with a fresh `updatedAt` and make this device look like it had just edited
 * the entire library, which would then win every future merge.
 */
export function applyRemote(next) {
  commit(() => {
    state.books = next.books ?? [];
    state.readingOrders = next.readingOrders ?? state.readingOrders;
    state.settings = { ...state.settings, ...next.settings };
    state.settingsUpdatedAt = next.settingsUpdatedAt ?? state.settingsUpdatedAt;
    state.deleted = next.deleted ?? [];
  });
}

/** Replace the whole library — used by seeding and, later, import. */
export function replaceAll(books, { settings, readingOrders } = {}) {
  commit(() => {
    state.books = books.map(normalizeBook);
    if (settings) state.settings = { ...state.settings, ...settings };
    if (readingOrders) state.readingOrders = readingOrders.map(normalizeOrder);
  });
}
