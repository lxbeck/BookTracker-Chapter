/**
 * What a cover file is called on disk.
 *
 * Covers used to be filed under the record id — `data/covers/bk-9f2c1a04.jpg`
 * — which is correct, stable, and completely opaque. Opening the folder told
 * you nothing, finding one cover meant opening twenty, and replacing one by
 * hand was impossible without first going and looking up an id in a JSON file.
 * A folder you can't read is a folder you can't fix.
 *
 * So files are named after the book: `the-hobbit.jpg`. The id doesn't
 * disappear — it moves into an index alongside, which is what the server
 * actually resolves a request through — but the human-facing artefact is now
 * a folder of recognisable filenames.
 *
 * Two things this has to survive:
 *   Two books with the same title. The second gets `-2`, and which one is
 *   which is recorded in the index rather than guessed at.
 *   A title being edited. The file is renamed to follow it, because a folder
 *   of names that were true six months ago is barely better than ids.
 *
 * Deliberately free of node and DOM imports: the server owns the filesystem,
 * this owns the naming, and the tests can check the naming without either.
 */

/** Extensions we will ever write. Anything else was rejected before this. */
export const COVER_EXTENSIONS = ['.jpg', '.png', '.webp', '.gif'];

/**
 * A filename-safe form of a title.
 *
 * Accents are folded rather than stripped, so `Les Misérables` becomes
 * `les-miserables` and not `les-misrables`. Length is capped well under any
 * filesystem limit — a 200-character light novel title is a real thing.
 */
export function slugifyTitle(title) {
  return String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2018\u2019]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/, '');
}

/** Ids come from the network, so they never touch the filesystem unfiltered. */
export const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);

/**
 * The folder a book's cover belongs in.
 *
 * One flat directory works until it doesn't: a few hundred files in a single
 * folder is a wall of names you scroll rather than read, and the one thing
 * every library naturally divides by is what kind of thing each book is.
 * `covers/comic/` and `covers/manga/` are folders you can actually open and
 * recognise.
 *
 * The kind is a slug already — ids are constrained when a kind is created —
 * but it arrives over the network, so it is cleaned again here before being
 * turned into a path.
 */
export const coverFolder = (category) => safeId(category || 'book') || 'book';

/**
 * The path a book's cover should have, relative to the covers directory.
 *
 * @param {Record<string, string>} index - bookId -> path
 * @param {string} bookId
 * @param {string} title
 * @param {string} extension - including the dot
 * @param {string} [category] - the kind, which decides the folder
 * @returns {string} a path like "comic/rachel-rising-vol-1.jpg"
 */
export function coverPath(index, bookId, title, extension, category) {
  const folder = coverFolder(category);
  const name = coverFileName(index, bookId, title, extension, folder);
  return `${folder}/${name}`;
}

/**
 * The name a book's cover should have within its folder.
 *
 * @param {Record<string, string>} index - bookId -> path
 * @param {string} bookId
 * @param {string} title
 * @param {string} extension - including the dot
 * @param {string} [folder] - only names in the same folder can collide
 * @returns {string} filename
 */
export function coverFileName(index, bookId, title, extension, folder = null) {
  const ext = COVER_EXTENSIONS.includes(extension) ? extension : '.jpg';
  // An untitled book still needs a file, and its id is the only thing left
  // that distinguishes it.
  const base = slugifyTitle(title) || `untitled-${safeId(bookId)}`.slice(0, 70);

  // Only files in the same folder can collide, so a comic and a novel with the
  // same title now sit in different directories and both keep the clean name.
  const taken = new Map(
    Object.entries(index)
      .filter(([id]) => id !== bookId)
      .map(([, file]) => String(file))
      .filter((file) => (folder ? file.startsWith(`${folder}/`) : !file.includes('/')))
      .map((file) => [file.split('/').pop().toLowerCase(), true])
  );

  // Names collide across extensions too: `dune.jpg` and `dune.png` in one
  // folder are two books wearing near-identical names, which is exactly the
  // confusion this is meant to prevent.
  const collides = (candidate) =>
    COVER_EXTENSIONS.some((other) => taken.has(`${candidate}${other}`.toLowerCase()));

  if (!collides(base)) return `${base}${ext}`;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!collides(candidate)) return `${candidate}${ext}`;
  }

  // A thousand books of the same name is not a real library; fall back to the
  // one name that cannot collide.
  return `${base}-${safeId(bookId)}${ext}`;
}

/**
 * Whether a stored file still matches its book's title.
 *
 * Compares the base name minus any `-2` disambiguator, so renaming does not
 * churn every duplicate in the folder each time the server restarts.
 */
export function nameMatchesTitle(filename, title) {
  const base = String(filename ?? '').split('/').pop().replace(/\.[a-z0-9]+$/i, '');
  const slug = slugifyTitle(title);
  if (!slug) return true;
  return base === slug || new RegExp(`^${escapeRegex(slug)}-\\d+$`).test(base);
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
