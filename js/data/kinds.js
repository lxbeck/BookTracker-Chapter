/**
 * Kinds of book, including the ones you invent.
 *
 * Six built-in kinds is a guess at what a library contains, and every guess of
 * that sort is wrong for somebody: a shelf of research papers, art books,
 * cookbooks, RPG rulebooks or light novels is a real shelf, and being told it
 * is a "Book" is the app deciding it knows better.
 *
 * So the six are a starting point rather than the set. Custom kinds live in
 * settings, which means they sync between devices like everything else, and
 * `normalizeBook` deliberately does not check a record's kind against this
 * list — a book catalogued on a laptop as a research paper must keep that on a
 * phone that has not received the setting yet, rather than being quietly
 * reclassified as something else.
 *
 * Built-ins cannot be deleted, only renamed. They are referenced by id in
 * every existing record, and by the calendar's kind groups, so removing one
 * would strand books rather than free them.
 */

import { CATEGORIES, CATEGORY_ORDER, cleanCategory } from './schema.js';

/** Applied at boot and on every settings change, like the lookup sources. */
let custom = [];

export function configureKinds(list) {
  custom = normalizeKinds(list);
  return custom;
}

/**
 * Clean a list of user-defined kinds.
 *
 * Ids are derived from the label once and then fixed, because the id is what
 * every record stores: renaming "Research Paper" to "Paper" must not orphan
 * every book already filed under it.
 */
function normalizeKinds(list) {
  const seen = new Set(Object.keys(CATEGORIES));
  const out = [];

  for (const entry of Array.isArray(list) ? list : []) {
    const label = String(entry?.label ?? entry ?? '').trim().slice(0, 40);
    if (!label) continue;

    const id = cleanCategory(entry?.id) || idFromLabel(label);
    if (!id || seen.has(id)) continue;

    seen.add(id);
    out.push({ id, label, plural: String(entry?.plural ?? '').trim() || `${label}s` });
  }

  return out;
}

/** "Research Paper" -> "researchPaper". Stable, readable in exports. */
export function idFromLabel(label) {
  const words = String(label ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  if (!words.length) return '';

  return cleanCategory(
    words[0].toLowerCase() +
      words.slice(1).map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join('')
  ).slice(0, 40);
}

export const customKinds = () => [...custom];

/** Every kind, built-in first, in the order they should be offered. */
export function allKinds() {
  return [
    ...CATEGORY_ORDER.map((id) => CATEGORIES[id]),
    ...custom,
  ];
}

const kindIds = () => allKinds().map((kind) => kind.id);

/**
 * The name to show for a kind.
 *
 * Falls back to the raw id rather than to "Book", so a kind that has not
 * arrived on this device yet is visibly unfamiliar instead of silently wrong.
 */
export function kindLabel(id) {
  const found = allKinds().find((kind) => kind.id === id);
  if (found) return found.label;
  return id ? id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()) : '';
}

export function kindPlural(id) {
  const found = allKinds().find((kind) => kind.id === id);
  return found?.plural ?? kindLabel(id).toLowerCase();
}

/** Kinds actually used by at least one book, for filter bars. */
export function kindsPresent(books) {
  const counts = new Map();
  for (const book of books) {
    counts.set(book.category, (counts.get(book.category) ?? 0) + 1);
  }

  const ordered = kindIds().filter((id) => counts.has(id));
  // A kind on a record that no longer exists as a setting still has books in
  // it, and hiding it would hide them.
  const unknown = [...counts.keys()].filter((id) => !ordered.includes(id));

  return [...ordered, ...unknown].map((id) => ({
    id,
    label: kindLabel(id),
    count: counts.get(id),
  }));
}
