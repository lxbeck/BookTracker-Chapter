/**
 * Sync with the optional server.
 *
 * The app is offline-first and the server is optional, so this layer is built
 * around that rather than bolted on: the browser copy is always the one being
 * read from and written to, and sync reconciles it in the background. Pull the
 * network cable and nothing breaks; plug it back in and the two copies merge.
 *
 * Merging is per record by `updatedAt` (see merge.js), which is what makes it
 * safe for a phone to have been offline for a week.
 */

import { mergeLibraries, libraryRevision } from './merge.js';
import * as store from './store.js';

const PUSH_DEBOUNCE = 700;
const RETRY_MS = 8000;

let mode = 'local'; // 'local' | 'syncing' | 'offline'
let revision = null;
let pushTimer = null;
let eventSource = null;
let applying = false; // suppresses the echo when we write what we just pulled
let lastError = null;
let lastSyncedAt = null;

const watchers = new Set();

/** @returns {{mode: string, lastSyncedAt: Date|null, error: string|null}} */
export const syncStatus = () => ({ mode, lastSyncedAt, error: lastError, revision });

export function onSyncChange(handler) {
  watchers.add(handler);
  return () => watchers.delete(handler);
}

function announce() {
  for (const handler of watchers) handler(syncStatus());
}

function setMode(next, error = null) {
  if (mode === next && lastError === error) return;
  mode = next;
  lastError = error;
  announce();
}

/* --- Wire format ----------------------------------------------------------- */

const snapshot = () => {
  const state = store.getState();
  return {
    books: state.books,
    readingOrders: state.readingOrders ?? [],
    settings: state.settings,
    settingsUpdatedAt: state.settingsUpdatedAt,
    deleted: state.deleted ?? [],
  };
};

/* --- Lifecycle -------------------------------------------------------------- */

/**
 * Look for a server on the same origin. Absent one, the app carries on exactly
 * as before — this is an enhancement, never a requirement.
 */
export async function initSync() {
  if (location.protocol === 'file:') return;

  // The server holds one library, so only the first one syncs. A second
  // library on this device is a second library on *this device* — pushing it
  // to an endpoint that has no idea there is more than one would merge two
  // separate collections into one, which is the opposite of why anyone keeps
  // them apart. Settings says as much, next to the switch.
  if (!store.isDefaultLibrary()) {
    setMode('local');
    return;
  }

  const found = await probe();
  if (!found) {
    setMode('local');
    return;
  }

  await pull({ initial: true });
  store.subscribe(schedulePush);
  listen();

  // A phone that was asleep misses the event stream entirely; re-checking on
  // wake is what makes it show the right library when you pick it up.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && mode !== 'local') pull();
  });
  window.addEventListener('online', () => pull());
}

async function probe() {
  try {
    const response = await fetch('api/status', { cache: 'no-store' });
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body?.ok);
  } catch {
    return false;
  }
}

/* --- Pull ------------------------------------------------------------------- */

export async function pull({ initial = false } = {}) {
  try {
    const response = await fetch('api/library', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const remote = await response.json();

    const local = snapshot();
    const { state, changed } = mergeLibraries(local, remote);

    if (changed) {
      applying = true;
      store.applyRemote(state);
      applying = false;
    }

    revision = remote.revision ?? libraryRevision(state);
    lastSyncedAt = new Date();
    setMode('syncing');

    // If our copy held anything the server lacked, put it back straight away.
    if (initial || libraryRevision(local) !== libraryRevision(state)) await push();
    else announce();
  } catch (error) {
    setMode('offline', error.message);
    setTimeout(() => pull(), RETRY_MS);
  }
}

/* --- Push ------------------------------------------------------------------- */

function schedulePush() {
  if (applying || mode === 'local') return;
  // Switching library mid-session must not push the new one over the old.
  if (!store.isDefaultLibrary()) {
    setMode('local');
    return;
  }
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => push(), PUSH_DEBOUNCE);
}

export async function push() {
  if (mode === 'local') return;

  try {
    const response = await fetch('api/library', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot()),
    });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);

    // The server merges and hands back the authoritative copy, which may
    // contain another device's edits we hadn't seen.
    const merged = await response.json();
    const { state, changed } = mergeLibraries(snapshot(), merged);
    if (changed) {
      applying = true;
      store.applyRemote(state);
      applying = false;
    }

    revision = merged.revision;
    lastSyncedAt = new Date();
    setMode('syncing');
  } catch (error) {
    setMode('offline', error.message);
    // Changes stay in the browser; the retry loop in pull() will carry them up.
    setTimeout(() => pull(), RETRY_MS);
  }
}

/* --- Live updates ----------------------------------------------------------- */

function listen() {
  if (!('EventSource' in globalThis)) return;

  eventSource?.close();
  eventSource = new EventSource('api/events');

  eventSource.addEventListener('message', (event) => {
    try {
      const { revision: incoming } = JSON.parse(event.data);
      if (incoming && incoming !== revision) pull();
    } catch {
      /* a malformed frame is not worth tearing the stream down for */
    }
  });

  eventSource.addEventListener('error', () => {
    // EventSource reconnects on its own; flag the gap and let it.
    setMode('offline', 'Lost the connection to the server.');
  });

  eventSource.addEventListener('open', () => setMode('syncing'));
}
