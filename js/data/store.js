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
import { addDays, daysBetween, today } from '../lib/dates.js';

/* --- Which library ---------------------------------------------------------

   More than one library on one device: a shared household shelf and a private
   one, work reading and everything else, a real catalogue and a sandbox to
   try an import in. Each is a separate value under its own key, and only one
   is open at a time — they are separate libraries, not filtered views of one,
   so nothing leaks between them.

   The first library keeps the original key. Anyone who has been using Chapter
   since before this existed has exactly one library, under exactly the key it
   has always been under, and never has to know any of this happened.
   ---------------------------------------------------------------------------- */

const BASE_KEY = 'chapter.library.v1';

/** Which libraries exist, and which one is open. Its own key, deliberately. */
const CATALOGUE_KEY = 'chapter.libraries.v1';

const DEFAULT_LIBRARY = { id: 'main', name: 'My library' };

let catalogue = { active: DEFAULT_LIBRARY.id, libraries: [{ ...DEFAULT_LIBRARY }] };

/** The storage key for one library. The first is the original, unprefixed. */
const keyFor = (id) => (id === DEFAULT_LIBRARY.id ? BASE_KEY : `${BASE_KEY}.${id}`);

let STORAGE_KEY = BASE_KEY;

function loadCatalogue() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CATALOGUE_KEY) ?? 'null');
    const libraries = (Array.isArray(parsed?.libraries) ? parsed.libraries : [])
      .map((entry) => ({
        id: String(entry?.id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40),
        name: String(entry?.name ?? '').trim().slice(0, 60) || 'Untitled library',
      }))
      .filter((entry) => entry.id);

    if (!libraries.some((entry) => entry.id === DEFAULT_LIBRARY.id)) {
      libraries.unshift({ ...DEFAULT_LIBRARY });
    }

    const active = libraries.some((entry) => entry.id === parsed?.active)
      ? parsed.active
      : DEFAULT_LIBRARY.id;

    catalogue = { active, libraries };
  } catch {
    catalogue = { active: DEFAULT_LIBRARY.id, libraries: [{ ...DEFAULT_LIBRARY }] };
  }

  STORAGE_KEY = keyFor(catalogue.active);
}

function saveCatalogue() {
  try {
    localStorage.setItem(CATALOGUE_KEY, JSON.stringify(catalogue));
  } catch {
    /* the library itself matters more; a failed write is already surfaced */
  }
}

/** @returns {{active: string, libraries: {id: string, name: string}[]}} */
export const allLibraries = () => ({
  active: catalogue.active,
  libraries: catalogue.libraries.map((entry) => ({ ...entry })),
});

/** The one that is open. */
export const activeLibrary = () =>
  catalogue.libraries.find((entry) => entry.id === catalogue.active) ?? { ...DEFAULT_LIBRARY };

/** True when the library on screen is the one the sync server holds. */
export const isDefaultLibrary = () => catalogue.active === DEFAULT_LIBRARY.id;

/**
 * Open a different library.
 *
 * The current one is already written after every change, so there is nothing
 * to flush: this swaps the key and reloads from storage. Callers re-render,
 * because everything on screen belongs to the library that was open a moment
 * ago.
 */
export function switchLibrary(id) {
  if (!catalogue.libraries.some((entry) => entry.id === id)) return { ok: false };
  if (id === catalogue.active) return { ok: true, library: activeLibrary() };

  catalogue.active = id;
  STORAGE_KEY = keyFor(id);
  saveCatalogue();

  state = blankState();
  load();
  for (const listener of listeners) listener(state);

  return { ok: true, library: activeLibrary() };
}

export function createLibrary(name) {
  const clean = String(name ?? '').trim().slice(0, 60);
  if (!clean) return { ok: false, error: 'Give the library a name.' };

  const base = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)
    || 'library';
  let id = base;
  let n = 2;
  while (catalogue.libraries.some((entry) => entry.id === id)) id = `${base}-${n++}`;

  catalogue.libraries.push({ id, name: clean });
  saveCatalogue();
  return { ok: true, library: { id, name: clean } };
}

export function renameLibrary(id, name) {
  const clean = String(name ?? '').trim().slice(0, 60);
  const entry = catalogue.libraries.find((library) => library.id === id);
  if (!entry || !clean) return { ok: false };

  entry.name = clean;
  saveCatalogue();
  return { ok: true, library: { ...entry } };
}

/**
 * Delete a library and everything in it.
 *
 * The first one cannot be deleted: it is where a device that has never heard
 * of any of this keeps its books, and there has to be somewhere to land.
 */
export function deleteLibrary(id) {
  if (id === DEFAULT_LIBRARY.id) return { ok: false, error: 'The first library cannot be deleted.' };
  if (!catalogue.libraries.some((entry) => entry.id === id)) return { ok: false };

  catalogue.libraries = catalogue.libraries.filter((entry) => entry.id !== id);
  try {
    localStorage.removeItem(keyFor(id));
  } catch {
    /* nothing to do: the entry is gone from the catalogue either way */
  }

  if (catalogue.active === id) {
    catalogue.active = DEFAULT_LIBRARY.id;
    STORAGE_KEY = keyFor(catalogue.active);
    state = blankState();
    load();
  }

  saveCatalogue();
  for (const listener of listeners) listener(state);
  return { ok: true };
}

const blankState = () => ({
  version: SCHEMA_VERSION,
  books: [],
  settings: { weekStartsOn: 0 },
  // Deletions are recorded, not just applied. Without a tombstone, a device
  // that never saw the delete would push the book back on its next sync.
  deleted: [],
  readingOrders: [],
  settingsUpdatedAt: undefined,
});

/** @type {{version: number, books: Object[], settings: Object}} */
let state = blankState();

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
  loadCatalogue();
  load();
  return state;
}

/* --- Reads ---------------------------------------------------------------- */

export const getState = () => state;
export const allBooks = () => state.books;
export const getBook = (id) => state.books.find((book) => book.id === id) ?? null;
export const getSettings = () => state.settings;

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

  // `undefined` in a patch means "not stated", so it must not blank a field.
  // Spreading it directly would, since {...{a: undefined}} overwrites a.
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  );

  const merged = normalizeBook({
    ...existing,
    ...defined,
    series: { ...existing.series, ...defined.series },
    cover: { ...existing.cover, ...defined.cover },
    schedule: recordPlanChange(existing, { ...existing.schedule, ...defined.schedule }),
    actual: { ...existing.actual, ...defined.actual },
    progress: { ...existing.progress, ...defined.progress },
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

/**
 * How many deleted books keep a full copy of themselves.
 *
 * A tombstone only needs an id and a time to do its job in sync. Keeping the
 * record too is what makes a deletion undoable tomorrow rather than only for
 * the eight seconds the toast is on screen — but the records live in the same
 * few megabytes as the library, so the archive is capped. Older tombstones
 * stay as tombstones, without the body.
 */
const ARCHIVE_LIMIT = 40;

export function removeBook(id) {
  const book = getBook(id);
  if (!book) return { ok: false };

  commit(() => {
    state.books = state.books.filter((entry) => entry.id !== id);

    const kept = (state.deleted ?? []).filter((entry) => entry.id !== id);
    const next = [...kept, { id, at: new Date().toISOString(), book }];

    // Trim the bodies, oldest first, keeping every tombstone. Dropping the
    // tombstone instead would resurrect the book on the next sync.
    const withBodies = next.filter((entry) => entry.book);
    const surplus = withBodies.length - ARCHIVE_LIMIT;
    const strip = new Set(surplus > 0 ? withBodies.slice(0, surplus).map((e) => e.id) : []);

    state.deleted = next.map((entry) =>
      strip.has(entry.id) ? { id: entry.id, at: entry.at } : entry
    );
  });

  return { ok: true, book };
}

/** Books deleted recently enough to still have a copy kept, newest first. */
export const recentlyDeleted = () =>
  (state.deleted ?? [])
    .filter((entry) => entry.book?.title)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));

/** Put one back from the archive. */
export function restoreDeleted(id) {
  const entry = (state.deleted ?? []).find((candidate) => candidate.id === id);
  if (!entry?.book) return { ok: false };
  restoreBook(entry.book);
  return { ok: true, book: entry.book };
}

/** Forget a deleted book for good, freeing the space its copy takes. */
export function forgetDeleted(id) {
  commit(() => {
    state.deleted = (state.deleted ?? []).map((entry) =>
      entry.id === id ? { id: entry.id, at: entry.at } : entry
    );
  });
  return { ok: true };
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

/**
 * Keep the plan a book used to have.
 *
 * Every route that moves a plan comes through `updateBook` — dragging a cover,
 * the Move dialog, a bulk shift, catching up, editing the dates by hand — so
 * this is the one place that can see a plan change at all. Two things were
 * lost without it: the chart of "what the plan asked for" redrew itself around
 * whatever plan was current, so a book you had rescheduled looked like it was
 * *ahead*; and there was no way to know a book had been moved four times,
 * which is the most useful thing the record can tell you about it.
 *
 * A plan is only filed away when the dates actually change. Saving a record
 * without touching them is not a reschedule.
 */
function recordPlanChange(existing, next) {
  const was = existing.schedule ?? {};
  const moved = was.start !== next.start || was.end !== next.end;

  if (!moved || !was.start) return next;

  // A moved plan is a plan for what is left.
  //
  // Reschedule an audiobook you are eighty per cent through to finish it
  // tomorrow, and the plan used to ask for the whole 310 minutes again — it
  // spread the book's full length across the new span as though the seven
  // sittings behind it had not happened. A rebase is exactly the record for
  // "from here, this much remains", already written by Catch me up; moving a
  // plan for a part-read book means the same thing, so it writes one too.
  //
  // Only where there is progress to account for. A book nobody has started
  // has nothing to count from, and a rebase at page zero is just noise on the
  // record.
  const done = Math.min(existing.progress?.page ?? 0, existing.pageCount ?? Infinity);
  const rebase = done > 0 && next.start
    ? { at: next.start, page: done, originalStart: was.rebase?.originalStart ?? was.start }
    : next.rebase;

  return {
    ...next,
    rebase,
    history: [
      ...(was.history ?? []),
      { start: was.start, end: was.end ?? was.start, at: today() },
    ].slice(-12),
  };
}

/**
 * Put a deleted list back — undo for `removeOrder`.
 *
 * The tombstone has to go with it, exactly as it does for a book: leave it in
 * place and the next sync sees a list this device deleted and helpfully
 * deletes it again on every other device.
 */
export function restoreOrder(order) {
  commit(() => {
    if (!getOrder(order.id)) {
      state.readingOrders = [...state.readingOrders, { ...order, updatedAt: new Date().toISOString() }];
    }
    state.deleted = (state.deleted ?? []).filter((entry) => entry.id !== order.id);
  });
  return { ok: true, order };
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

/**
 * The lists, in the order you put them in.
 *
 * `position` is a number rather than an array index because two devices
 * editing different lists must not have to agree on one shared array — each
 * list carries its own place, and the merge rule for a list is the same as for
 * a book.
 */
export const allOrders = () =>
  [...state.readingOrders].sort(
    (a, b) =>
      (a.position ?? Infinity) - (b.position ?? Infinity) ||
      String(a.createdAt).localeCompare(String(b.createdAt))
  );

export const getOrder = (id) => state.readingOrders.find((order) => order.id === id) ?? null;

/** Position of a book within an order, or Infinity when it isn't in it. */
export function positionInOrder(orderId, bookId) {
  const index = getOrder(orderId)?.bookIds.indexOf(bookId) ?? -1;
  return index === -1 ? Infinity : index;
}

export function createOrder(input) {
  const order = normalizeOrder(input);
  const errors = validateOrder(order);
  if (Object.keys(errors).length) return { ok: false, errors };

  if (order.position == null) {
    // A new list goes after the ones already there, rather than wherever an
    // unset position happens to sort.
    const highest = state.readingOrders.reduce(
      (max, entry) => Math.max(max, entry.position ?? -1),
      -1
    );
    order.position = highest + 1;
  }

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

/**
 * Put a whole sequence back the way it was.
 *
 * What undo is built on. Restoring the array wholesale rather than replaying
 * the inverse of a move is the only version that is correct after a drag,
 * where "the inverse" depends on where the row started and nobody remembers.
 */
export function setOrderSequence(orderId, bookIds) {
  const order = getOrder(orderId);
  if (!order) return { ok: false };

  // Only ids already in the list, and every one of them: a restore must not
  // resurrect a book removed since, or drop one added since.
  const known = new Set(order.bookIds);
  const next = bookIds.filter((id) => known.has(id));
  for (const id of order.bookIds) if (!next.includes(id)) next.push(id);

  return updateOrder(orderId, { bookIds: next });
}

/**
 * Move a list itself up or down among the others.
 *
 * Positions are renumbered from zero on every move. Gaps would work too, but
 * renumbering keeps the numbers meaning what they look like they mean, and a
 * handful of lists is not a dataset worth optimising for.
 */
export function moveOrder(orderId, delta) {
  const ordered = allOrders();
  const from = ordered.findIndex((order) => order.id === orderId);
  if (from === -1) return { ok: false };

  const to = Math.max(0, Math.min(from + delta, ordered.length - 1));
  if (to === from) return { ok: true, moved: false };

  const next = [...ordered];
  next.splice(to, 0, ...next.splice(from, 1));

  const now = new Date().toISOString();
  commit(() => {
    const positions = new Map(next.map((order, index) => [order.id, index]));
    state.readingOrders = state.readingOrders.map((order) =>
      positions.has(order.id)
        ? { ...order, position: positions.get(order.id), updatedAt: now }
        : order
    );
  });

  return { ok: true, moved: true };
}

/** Set progress from either a page or a percentage; both are kept in step. */
/**
 * Fold duplicate records into one.
 *
 * The patch is applied first and the absorbed records removed second, so a
 * failure part-way leaves two copies rather than none — the wrong outcome, but
 * the recoverable one.
 *
 * Reading orders are repointed rather than left holding ids that no longer
 * exist. A sequence quietly losing an entry because two records were tidied up
 * is exactly the kind of damage a merge is supposed to prevent.
 *
 * @param {string} survivorId
 * @param {string[]} absorbedIds
 * @param {object} patch - from `mergePlan`
 */
export function mergeBooks(survivorId, absorbedIds, patch = {}) {
  const survivor = getBook(survivorId);
  if (!survivor) return { ok: false, errors: { id: 'That book is no longer here.' } };

  const gone = absorbedIds.filter((id) => id !== survivorId && getBook(id));
  if (!gone.length) return { ok: false, errors: { id: 'Nothing to merge into it.' } };

  const result = updateBook(survivorId, patch);
  if (!result.ok) return result;

  const doomed = new Set(gone);
  const now = new Date().toISOString();

  commit(() => {
    state.readingOrders = state.readingOrders.map((order) => {
      if (!order.bookIds.some((id) => doomed.has(id))) return order;

      // Replace in place so the survivor inherits the position the duplicate
      // held, then dedupe — a list naming both copies keeps the earlier slot.
      const rebuilt = [];
      for (const id of order.bookIds) {
        const next = doomed.has(id) ? survivorId : id;
        if (!rebuilt.includes(next)) rebuilt.push(next);
      }
      return { ...order, bookIds: rebuilt, updatedAt: now };
    });
  });

  for (const id of gone) removeBook(id);

  return { ok: true, book: getBook(survivorId), removed: gone.length };
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
export function replaceAll(books, { settings, readingOrders, deleted } = {}) {
  commit(() => {
    state.books = books.map(normalizeBook);
    if (settings) state.settings = { ...state.settings, ...settings };
    if (readingOrders) state.readingOrders = readingOrders.map(normalizeOrder);

    if (Array.isArray(deleted)) {
      state.deleted = deleted;
    } else {
      // A tombstone for a book that is now here again would delete it on the
      // next sync — the restored library would quietly lose exactly the books
      // it had previously been asked to forget.
      const present = new Set(state.books.map((book) => book.id));
      state.deleted = (state.deleted ?? []).filter((entry) => !present.has(entry.id));
    }
  });
}
