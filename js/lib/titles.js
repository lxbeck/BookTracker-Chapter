/**
 * Sorting titles the way a shelf does.
 *
 * Two things a plain string comparison gets wrong, and both of them are
 * obvious once you see a real library sorted by it.
 *
 * **Leading articles.** `A Wizard of Earthsea` filed under A puts it next to
 * `A Canticle for Leibowitz` and `An Unkindness of Ghosts`, and the A shelf
 * fills up with books whose only common feature is a word nobody thinks of as
 * part of the title. Every library catalogue in the world ignores a leading
 * article, and so does every bookshop: it belongs under W. The article is not
 * *removed* — it is still displayed, and still there if you search for it — it
 * is only skipped when deciding where the book sits.
 *
 * (Only leading ones. `The Wind in the Willows` files under W; the second
 * "the" is part of the title and stays.)
 *
 * **Numbers.** A string comparison reads digit by digit, so `Vol. 10` sorts
 * before `Vol. 2` because `1` comes before `2`, and a nineteen-volume series
 * comes out as 1, 10, 11 … 19, 2, 20, 3, 4. This is the single most common
 * complaint about sorted lists anywhere, and the fix is to compare runs of
 * digits as numbers rather than as text.
 *
 * `Intl.Collator` with `numeric` does the second part properly, including for
 * languages where the answer is not simply "compare code points", so the
 * comparison is delegated to it rather than reimplemented.
 */

/**
 * Articles skipped when filing.
 *
 * English plus the few that turn up constantly on a shelf of translations.
 * Deliberately not exhaustive: the cost of a wrong guess is a book filed
 * somewhere surprising, so this stays to articles that are unambiguous.
 */
const ARTICLES = [
  'a', 'an', 'the',
  'la', 'le', 'les', 'el', 'los', 'las', 'un', 'una', 'une',
  'der', 'die', 'das', 'ein', 'eine',
  'il', 'lo', 'gli', 'o', 'os', 'as', 'de', 'het', 'een',
];

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
  ignorePunctuation: true,
});

/**
 * The form of a title used for filing.
 *
 * @param {string} title
 * @returns {string}
 */
export function sortableTitle(title) {
  const clean = String(title ?? '').trim();
  if (!clean) return '';

  // Leading punctuation and quotes are furniture, not the first letter.
  const bare = clean.replace(/^[\s"'“‘([{¡¿*#-]+/, '');

  const [first, ...rest] = bare.split(/\s+/);
  if (!rest.length) return bare.toLowerCase();

  const article = first.toLowerCase().replace(/[^a-zà-ÿ']/g, '');
  return ARTICLES.includes(article) ? rest.join(' ').toLowerCase() : bare.toLowerCase();
}

/**
 * Compare two titles as a shelf would.
 *
 * Falls back to the untouched titles when the filed forms are equal, so two
 * books that differ only by a leading article still have a stable order rather
 * than swapping about between renders.
 */
export function compareTitles(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');

  return (
    collator.compare(sortableTitle(left), sortableTitle(right)) ||
    collator.compare(left, right)
  );
}

/**
 * Compare two books by series position, then by title.
 *
 * Volume 4.5 belongs between 4 and 5, which numeric collation on the title
 * would not manage on its own — the number in `Vol. 4.5` is only reliable when
 * it is actually in the title, and for a series it is a field.
 */
export function compareBySeries(a, b) {
  const nameA = a.series?.name ?? '';
  const nameB = b.series?.name ?? '';

  if (nameA && nameB && nameA !== nameB) return collator.compare(nameA, nameB);
  if (nameA && nameB) {
    const numberA = a.series?.number;
    const numberB = b.series?.number;
    // A volume with no number sorts after the numbered ones rather than at
    // the front, where a missing value would otherwise put it.
    if (numberA != null && numberB != null && numberA !== numberB) return numberA - numberB;
    if (numberA != null && numberB == null) return -1;
    if (numberA == null && numberB != null) return 1;
  }

  return compareTitles(a.title, b.title);
}
