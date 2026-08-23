/**
 * Merging two copies of a library.
 *
 * Once the same library is open on a laptop and a phone, "last write wins" on
 * the whole blob is a data-loss bug waiting to happen: the phone holding a
 * five-minute-old copy pushes it and silently erases everything done on the
 * laptop since. So the merge is per record, by `updatedAt`, and deletions
 * leave tombstones — without them, a device that never saw the delete would
 * push the book straight back.
 *
 * Deliberately free of DOM and storage imports: the server runs this exact
 * function, and two different merge implementations would eventually disagree.
 */

/** How long a tombstone is kept before it's assumed everyone has seen it. */
const TOMBSTONE_DAYS = 90;

const newest = (a, b) => (String(a ?? '') > String(b ?? '') ? a : b);

/**
 * @typedef {Object} LibraryState
 * @property {object[]} books
 * @property {object} settings
 * @property {{id: string, at: string}[]} [deleted]
 * @property {string} [settingsUpdatedAt]
 */

/**
 * @param {LibraryState} local
 * @param {LibraryState} remote
 * @returns {{state: LibraryState, changed: boolean, incoming: number}}
 */
export function mergeLibraries(local, remote) {
  const deleted = mergeTombstones(local.deleted, remote.deleted);
  const deletedAt = new Map(deleted.map((entry) => [entry.id, entry.at]));

  // Reading orders merge by the same rule as books. They carry their own
  // updatedAt, so a reordering on the phone beats a stale copy on the laptop
  // wholesale — a sequence half-merged from two devices would be nonsense.
  const orders = mergeById(local.readingOrders, remote.readingOrders, deletedAt);

  const byId = new Map();
  let incoming = 0;

  for (const book of local.books ?? []) byId.set(book.id, book);

  for (const book of remote.books ?? []) {
    const mine = byId.get(book.id);
    // Ties go to the local copy: re-applying an identical record would churn
    // the UI on every poll for no benefit.
    if (!mine || String(book.updatedAt) > String(mine.updatedAt)) {
      byId.set(book.id, book);
      incoming += 1;
    }
  }

  // A delete only wins if it happened after the record was last edited.
  // Editing a book on one device after deleting it on another means you want
  // the book.
  const books = [...byId.values()].filter((book) => {
    const at = deletedAt.get(book.id);
    return !at || String(at) < String(book.updatedAt);
  });

  const removed = byId.size - books.length;

  const localStamp = local.settingsUpdatedAt ?? '';
  const remoteStamp = remote.settingsUpdatedAt ?? '';
  const settingsFromRemote = remoteStamp > localStamp;

  return {
    state: {
      readingOrders: orders.records,
      books: books.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
      settings: settingsFromRemote ? remote.settings : local.settings,
      settingsUpdatedAt: newest(localStamp, remoteStamp) || undefined,
      deleted,
    },
    changed: incoming > 0 || removed > 0 || settingsFromRemote || orders.changed,
    incoming,
  };
}

/** Per-record last-write-wins, honouring tombstones. Shared by books and orders. */
function mergeById(local = [], remote = [], deletedAt = new Map()) {
  const byId = new Map();
  let changed = false;

  for (const record of local) byId.set(record.id, record);

  for (const record of remote) {
    const mine = byId.get(record.id);
    if (!mine || String(record.updatedAt) > String(mine.updatedAt)) {
      byId.set(record.id, record);
      changed = true;
    }
  }

  const records = [...byId.values()].filter((record) => {
    const at = deletedAt.get(record.id);
    return !at || String(at) < String(record.updatedAt);
  });

  return { records, changed: changed || records.length !== byId.size };
}

/** Union of two tombstone lists, newest timestamp per id, old ones pruned. */
export function mergeTombstones(a = [], b = [], now = new Date()) {
  const cutoff = new Date(now.getTime() - TOMBSTONE_DAYS * 86400000).toISOString();
  const byId = new Map();

  for (const entry of [...a, ...b]) {
    if (!entry?.id || !entry.at) continue;
    if (entry.at < cutoff) continue;
    const existing = byId.get(entry.id);
    if (!existing || entry.at > existing.at) byId.set(entry.id, { id: entry.id, at: entry.at });
  }

  return [...byId.values()].sort((x, y) => x.at.localeCompare(y.at));
}

/** A stable fingerprint, so a device can tell whether a push changed anything. */
export function libraryRevision(state) {
  const parts = (state.books ?? [])
    .map((book) => `${book.id}:${book.updatedAt}`)
    .sort();
  parts.push(`settings:${state.settingsUpdatedAt ?? ''}`);
  for (const order of state.readingOrders ?? []) parts.push(`ro:${order.id}:${order.updatedAt}`);
  parts.push(`deleted:${(state.deleted ?? []).map((entry) => entry.id).sort().join(',')}`);

  // djb2 — short, stable, and good enough to answer "did anything change?".
  let hash = 5381;
  const text = parts.join('|');
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}
