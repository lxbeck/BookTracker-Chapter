/**
 * Where a copy came from: bought, borrowed, given, from the library.
 *
 * Not the same question as kind or format, and not a shelf either. A shelf is
 * something you chose to write; this is a fact about the object, and it is the
 * one that answers "which of these do I have to give back", "how much did this
 * year of reading cost me", and "which of these were presents".
 *
 * The built-in list is a guess at the common cases, and every guess of that
 * shape is wrong for somebody — a reading copy from a publisher, a book found
 * in a hotel, an inheritance — so, exactly like kinds, the list is a starting
 * point rather than the set. Custom sources live in settings, sync with
 * everything else, and are referenced by id, so renaming one does not orphan
 * the books filed under it.
 *
 * `normalizeBook` deliberately does not check a record's source against this
 * list, for the same reason it does not check kinds: a source invented on a
 * laptop must survive on a phone that has not received the setting yet.
 */

import { cleanCategory } from './schema.js';
import { idFromLabel } from './kinds.js';

/** @typedef {{id: string, label: string, hint?: string}} Source */

export const SOURCES = {
  purchased: { id: 'purchased', label: 'Purchased', hint: 'Bought new or second-hand' },
  gift: { id: 'gift', label: 'Gift', hint: 'Given to you' },
  library: { id: 'library', label: 'Library', hint: 'Borrowed from a library' },
  borrowed: { id: 'borrowed', label: 'Borrowed', hint: 'Someone else’s copy' },
  subscription: { id: 'subscription', label: 'Subscription', hint: 'Kindle Unlimited, Audible, Scribd' },
  free: { id: 'free', label: 'Free', hint: 'Public domain, giveaway, found' },
};

const SOURCE_ORDER = ['purchased', 'gift', 'library', 'borrowed', 'subscription', 'free'];

/** Applied at boot and on every settings change, like kinds and lookup sources. */
let custom = [];

export function configureSourceList(list) {
  custom = normalizeSources(list);
  return custom;
}

function normalizeSources(list) {
  const seen = new Set(Object.keys(SOURCES));
  const out = [];

  for (const entry of Array.isArray(list) ? list : []) {
    const label = String(entry?.label ?? entry ?? '').trim().slice(0, 40);
    if (!label) continue;

    const id = cleanCategory(entry?.id) || idFromLabel(label);
    if (!id || seen.has(id)) continue;

    seen.add(id);
    out.push({ id, label, hint: String(entry?.hint ?? '').trim().slice(0, 80) });
  }

  return out;
}

export const customSources = () => [...custom];

/** Every source, built-in first, in the order they should be offered. */
export function allSources() {
  return [...SOURCE_ORDER.map((id) => SOURCES[id]), ...custom];
}

/**
 * The name to show for a source.
 *
 * Falls back to the raw id rather than to "Purchased", so a source that has
 * not arrived on this device yet is visibly unfamiliar instead of quietly
 * wrong about how you came by the book.
 */
export function sourceLabel(id) {
  const found = allSources().find((source) => source.id === id);
  if (found) return found.label;
  return id ? id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()) : '';
}

/** Sources actually used by at least one book, for filter rows and reports. */
export function sourcesPresent(books) {
  const counts = new Map();
  for (const book of books) {
    if (!book.source) continue;
    counts.set(book.source, (counts.get(book.source) ?? 0) + 1);
  }

  const known = allSources().map((source) => source.id).filter((id) => counts.has(id));
  const unknown = [...counts.keys()].filter((id) => !known.includes(id));

  return [...known, ...unknown].map((id) => ({ id, label: sourceLabel(id), count: counts.get(id) }));
}
