/**
 * Library view — the shelves.
 *
 * One view, filtered: To read, Reading, Finished, and the full catalogue.
 * Filter state lives in module scope rather than the store, because which tab
 * you're looking at isn't data worth persisting between sessions — and keeping
 * it out of the store means a filter change never touches localStorage.
 */

import { el, fill, toast } from '../lib/dom.js';
import { compareTitles } from '../lib/titles.js';
import { showModal, confirmAction } from './modal.js';
import {
  allBooks, updateBook, removeBook, restoreBook, getBook, getSettings,
  allOrders, addToOrder, createOrder, positionInOrder, rescheduleBook,
} from '../data/store.js';
import {
  STATUSES, STATUS_ORDER, FORMATS,
  formatUnit, hasFormat, formatLabel, FORMAT_PRIORITY,
} from '../data/schema.js';
import { allKinds, kindLabel, kindsPresent } from '../data/kinds.js';
import { allSources, sourceLabel, sourcesPresent } from '../data/sources.js';
import { coverThumb } from './cover.js';
import { acceptCoverDrop } from './coverDrop.js';
import { setCoverFromFile, setCoverFromUrl } from '../data/coverActions.js';
import { openBookForm } from './bookForm.js';
import { formatShort, relativeDay } from '../lib/dates.js';
import { enrichAll, needsDetails } from '../data/enrich.js';
import { loadSampleLibrary } from '../data/seed.js';
import { addDays } from '../lib/dates.js';
import { progressReport } from '../logic/pacing.js';

/** Tabs are reading intents, not raw statuses — "To read" folds in on-hold. */
/**
 * The shelves, in the order a book moves through them.
 *
 * On hold used to be folded in with Planned, and did-not-finish had nowhere to
 * go at all — so setting a book down took it off Reading and dropped it into a
 * tab where it looked like something you were about to start. They are their
 * own shelves now.
 *
 * `always` marks the tabs that are part of the furniture. The other two appear
 * only when something is on them: an empty "Did not finish" is a reproach
 * nobody needs, and a tab that never has anything on it is just a smaller
 * library.
 */
const SHELVES = {
  reading: { label: 'Reading', always: true, match: (b) => b.status === 'reading' },
  planned: { label: 'Planned', always: true, match: (b) => b.status === 'planned' },
  backlog: { label: 'Backlog', always: true, match: (b) => b.status === 'backlog' },
  'on-hold': { label: 'On hold', match: (b) => b.status === 'on-hold' },
  dnf: { label: 'Did not finish', match: (b) => b.status === 'dnf' },
  finished: { label: 'Finished', always: true, match: (b) => b.status === 'finished' },
  all: { label: 'Everything', always: true, match: () => true },
};

/**
 * Filters for finding records that need work.
 *
 * A library of a few hundred imported books always has gaps, and the gaps are
 * invisible until you can ask for them directly. Each is phrased as the thing
 * you'd say out loud, not as a field name.
 */
const NEEDS = {
  noPages: { label: 'No length', match: (b) => !b.pageCount },
  unscheduled: { label: 'Not scheduled', match: (b) => !b.schedule.start && b.status !== 'finished' },
  noCover: { label: 'No cover', match: (b) => !b.cover?.url },
  noDescription: { label: 'No description', match: (b) => !b.description },
  noAuthor: { label: 'No author', match: (b) => !b.author },
  noIsbn: { label: 'No ISBN', match: (b) => !b.isbn },
  unrated: { label: 'Finished, unrated', match: (b) => b.status === 'finished' && !b.rating },
  stalled: {
    label: 'Started, no log',
    match: (b) => b.status === 'reading' && b.sessions.length === 0,
  },
};

const SORTS = {
  planned: {
    label: 'By plan date',
    // Active books — reading or planned — lead, in schedule order. Finished,
    // abandoned, shelved or held books still carry the schedule.start they
    // were last planned under, and a book finished weeks ago sorting ahead of
    // the one you start tonight answered a different question than "what's
    // next". Everything stays on the Everything shelf; this only changes
    // where it sits. Ties within a group fall back to schedule date, then
    // title, so books with no date at all — mostly the backlog — settle at
    // the end of their group rather than jumping around.
    compare: (a, b) => {
      const active = (book) => (book.status === 'reading' || book.status === 'planned' ? 0 : 1);
      return (
        active(a) - active(b) ||
        (a.schedule.start ?? '9999').localeCompare(b.schedule.start ?? '9999') ||
        compareTitles(a.title, b.title)
      );
    },
  },
  added: { label: 'Recently added', compare: (a, b) => b.createdAt.localeCompare(a.createdAt) },
  title: { label: 'Title', compare: (a, b) => compareTitles(a.title, b.title) },
  progress: {
    label: 'Nearest finishing',
    /**
     * Furthest through first, so the book that needs one more evening sits
     * above the one you have barely started.
     *
     * Finished books sort last rather than first, which is where they were
     * landing: they are all at 100%, so by the letter of "nearest finishing"
     * they win — and a sort meant to answer "what could I finish tonight"
     * that opens with two hundred books you finished years ago answers
     * nothing. "When did I finish it" is what sorting by finish date is for.
     */
    compare: (a, b) => {
      const done = (book) => (book.status === 'finished' ? 1 : 0);
      return (
        done(a) - done(b) ||
        (b.progress?.percent ?? 0) - (a.progress?.percent ?? 0) ||
        compareTitles(a.title, b.title)
      );
    },
  },
  notes: {
    label: 'Has notes',
    // Books you have written something about, longest note first, then
    // everything else in title order. Sorting by a field most books leave
    // empty is really a way of surfacing the ones that are not empty.
    compare: (a, b) =>
      (b.notes?.trim().length ?? 0) - (a.notes?.trim().length ?? 0) ||
      compareTitles(a.title, b.title),
  },
  author: { label: 'Author', compare: (a, b) => (a.author || '~').localeCompare(b.author || '~') },
  length: { label: 'Length', compare: (a, b) => (b.pageCount ?? 0) - (a.pageCount ?? 0) },
  series: {
    label: 'Series',
    // Books in a series first, in index order; standalones after, by title.
    // Sorting standalones into the middle alphabetically would break up the
    // runs, which are the only reason to sort by series at all.
    compare: (a, b) => {
      const an = a.series.name || '';
      const bn = b.series.name || '';
      if (an && !bn) return -1;
      if (!an && bn) return 1;
      return (
        an.localeCompare(bn) ||
        (a.series.number ?? Infinity) - (b.series.number ?? Infinity) ||
        compareTitles(a.title, b.title)
      );
    },
  },
  finished: {
    label: 'Date finished',
    // Unfinished books sort last rather than first: a list ordered by finish
    // date is being read for the finished ones.
    compare: (a, b) =>
      (b.actual.finishedAt ?? '').localeCompare(a.actual.finishedAt ?? '') ||
      compareTitles(a.title, b.title),
  },
  format: {
    label: 'Format',
    // Group by format, then read alphabetically within each group — a format
    // sort that scatters titles randomly inside each group is half a sort.
    compare: (a, b) =>
      FORMAT_PRIORITY.indexOf(a.format) - FORMAT_PRIORITY.indexOf(b.format) ||
      compareTitles(a.title, b.title),
  },
};


/**
 * Books currently ticked. A Set of ids, so a re-render can't stale them — and
 * insertion order is meaningful: it's the order bulk scheduling reads.
 */
const selection = new Set();

/** The last box clicked, so shift-click knows where a range starts. */
let anchorId = null;

const filters = {
  shelf: 'reading', sort: 'planned', query: '', tag: null,
  format: null, order: null, category: null, need: null, genre: null, source: null,
};

export function renderLibrary(mount) {
  const books = allBooks();
  const counts = Object.fromEntries(
    Object.entries(SHELVES).map(([id, shelf]) => [id, books.filter(shelf.match).length])
  );

  // An empty "Reading" shelf on first load is a dead end; start people on a
  // shelf that actually has something on it.
  if (!counts[filters.shelf] && counts.all && !filters.query) {
    filters.shelf = Object.keys(SHELVES).find((id) => counts[id]) ?? 'all';
  }

  /**
   * The books a filter row should describe.
   *
   * The rows used to be built from the whole library, so the Reading shelf
   * offered a shelf tag, a reading list and a genre that between them matched
   * nothing currently on it — every one of them a click that empties the view.
   * A filter that cannot match anything you can see is not a filter, it is a
   * trap.
   *
   * "Everything" is the exception and keeps the full set, because that tab is
   * where you go precisely to find the things the current shelf does not show.
   */
  // A shelf that no longer exists — or an optional one that has just emptied
  // while you were standing on it — would otherwise leave the view stuck.
  if (!SHELVES[filters.shelf]) filters.shelf = 'all';

  const inScope = filters.shelf === 'all' ? books : books.filter(SHELVES[filters.shelf].match);

  const tags = [...new Set(inScope.flatMap((book) => book.shelves))].sort();
  if (filters.tag && !tags.includes(filters.tag)) filters.tag = null;

  // A different shelf, sort or filter is a different list; start it at the top.
  shown = PAGE;
  resultsMount = el('div.shelf-results');

  fill(mount, [
    el('div.view-head', {}, [
      el('div', {}, [
        el('h2.view-title', {}, getSettings().libraryName?.trim() || 'The library'),
        el('p.view-sub', {}, `${books.length} record${books.length === 1 ? '' : 's'} catalogued`),
      ]),
      el('button.btn.btn--stamp', { type: 'button', onClick: () => openBookForm() }, 'Add a book'),
    ]),

    books.length ? toolbar(counts) : null,
    books.length && showsRow('format') ? formatBar(inScope) : null,
    books.length && showsRow('kind') ? categoryBar(inScope) : null,
    books.length && showsRow('sources') ? sourceBar(inScope) : null,
    books.length && showsRow('genre') ? genreBar(inScope) : null,
    books.length ? needsBar(books) : null,
    showsRow('orders') ? orderBar(inScope) : null,
    tags.length && showsRow('shelves') ? tagBar(tags) : null,

    resultsMount,
  ]);

  paintResults();
}

/**
 * Everything a search term changes, and nothing it doesn't.
 *
 * Typing used to rebuild the entire view, which meant tearing out the input
 * the caret was sitting in and putting a new one back with the caret forced to
 * the end — so a search term could not be corrected in the middle, and any
 * input method that composes characters before committing them (which is every
 * input method for Chinese, Japanese and Korean) was interrupted on every
 * keystroke. The shelf tabs and filter rows don't depend on the query, so they
 * stay exactly where they are and only the results are repainted.
 */
let resultsMount = null;

/** The books on screen, in the order they are shown. */
function visibleBooks(books) {
  return books
    .filter(SHELVES[filters.shelf].match)
    .filter(matchesQuery(filters.query))
    .filter((book) => !filters.tag || book.shelves.includes(filters.tag))
    // A book read on paper with the audiobook playing answers to both
    // filters, because it is genuinely both.
    .filter((book) => !filters.format || hasFormat(book, filters.format))
    .filter((book) => !filters.category || book.category === filters.category)
    .filter((book) => !filters.source
      || (filters.source === NO_SOURCE ? !book.source : book.source === filters.source))
    .filter((book) => !filters.genre || book.genre?.trim().toLowerCase() === filters.genre)
    .filter((book) => !filters.need || NEEDS[filters.need].match(book))
    .filter((book) => !filters.order || positionInOrder(filters.order, book.id) !== Infinity)
    // Picking a reading order overrides the sort: the whole point of the list
    // is its sequence, and sorting it by title would discard that.
    .sort(
      filters.order
        ? (a, b) => positionInOrder(filters.order, a.id) - positionInOrder(filters.order, b.id)
        : SORTS[filters.sort].compare
    );
}

/**
 * How many cards to build at once.
 *
 * A catalogue imported from Goodreads is nine hundred books, and nine hundred
 * cards — each with a cover, a progress bar and a row of controls — is a
 * second of work for the browser every time anything changes, which is once
 * per keystroke in the search field. Sixty is more than fills a screen, and
 * the rest arrives when it is asked for.
 */
const PAGE = 60;

let shown = PAGE;

function paintResults() {
  if (!resultsMount?.isConnected) return;

  const books = allBooks();
  const visible = visibleBooks(books);
  const page = visible.slice(0, shown);

  // Anything ticked but no longer on screen would be edited invisibly.
  const visibleIds = new Set(visible.map((book) => book.id));
  for (const id of [...selection]) if (!visibleIds.has(id)) selection.delete(id);
  // Range selection and "add to list" both work off what is on screen, so this
  // is the page rather than the whole match.
  lastVisibleOrder = page.map((book) => book.id);

  const more = visible.length - page.length;

  fill(resultsMount, [
    selection.size ? bulkBar(page) : null,

    books.length === 0
      ? emptyLibrary()
      : visible.length === 0
        ? emptyShelf()
        : el('ul.shelf', {}, page.map(shelfCard)),

    more > 0 ? showMore(page.length, visible.length, more) : null,
  ].filter(Boolean));
}

function showMore(here, total, more) {
  return el('div.shelf-more', {}, [
    el('p.shelf-more__count', {}, `Showing ${here} of ${total}`),
    el('button.btn.btn--quiet', {
      type: 'button',
      onClick: () => {
        shown += PAGE;
        paintResults();
      },
    }, `Show ${Math.min(more, PAGE)} more`),
    more > PAGE
      ? el('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          onClick: () => {
            shown = Infinity;
            paintResults();
          },
        }, `Show all ${total}`)
      : null,
  ].filter(Boolean));
}

/**
 * Which fields a search looks at.
 *
 * Descriptions are in here, which they were not before. A catalogue you cannot
 * search the text of is a catalogue you can only find things in if you already
 * remember what they were called — and the whole reason for writing blurbs
 * into records is to be able to ask "which one was the book about the devil
 * hunter" six months later.
 *
 * Notes and tags come along for the same reason: they are things you wrote
 * about a book, and anything you wrote should be findable.
 *
 * So are quotes and the notes on individual sittings — the two places where
 * people write the most specific things they will ever write about a book, and
 * the two that were unsearchable. "Which book had that line about the lighthouse"
 * is precisely the question a copied-out quote exists to answer.
 */
const SEARCHED = [
  (book) => book.title,
  (book) => book.author,
  (book) => book.coAuthors?.join(' '),
  (book) => book.genre,
  (book) => book.series.name,
  (book) => book.description,
  (book) => book.notes,
  (book) => book.review,
  (book) => book.shelves.join(' '),
  (book) => (book.quotes ?? []).map((quote) => quote.text).join(' '),
  (book) => (book.sessions ?? []).map((session) => session.note).filter(Boolean).join(' '),
  (book) => sourceLabel(book.source),
];

/** Everything on a book that is prose rather than a label. */
const writtenText = (book) => [
  book.description,
  book.notes,
  book.review,
  ...(book.quotes ?? []).map((quote) => quote.text),
  ...(book.sessions ?? []).map((session) => session.note),
].filter(Boolean).join(' \u00b7 ');

/**
 * Whether a filter row is switched on.
 *
 * Six rows above the shelves is a lot of chrome for someone who only ever
 * filters by one of them, and the rows they never use are pure noise. Hidden
 * rows also clear their own filter, so a row cannot be switched off while
 * still silently narrowing what is on screen.
 */
/** Whether the status badge is drawn over cover art. */
const showsStatusBadge = () => !getSettings().hideStatusBadges;

function showsRow(id) {
  const hidden = getSettings().hiddenRows ?? [];
  if (!hidden.includes(id)) return true;

  const clears = {
    format: 'format', kind: 'category', genre: 'genre', orders: 'order', shelves: 'tag',
    sources: 'source',
  };
  if (filters[clears[id]]) filters[clears[id]] = null;
  return false;
}

const matchesQuery = (query) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return () => true;
  return (book) =>
    SEARCHED.map((read) => read(book))
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
};

/** Whether the query is only found in the long text, rather than the labels. */
const matchedInText = (book, query) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;

  const label = [book.title, book.author, book.genre, book.series.name]
    .filter(Boolean)
    .some((value) => value.toLowerCase().includes(needle));

  return !label && writtenText(book).toLowerCase().includes(needle);
};

/**
 * The sentence the search term was found in, rather than the opening line.
 *
 * A card showing the first forty words of a blurb is no help when the reason
 * the book is on screen is a phrase four paragraphs down. The excerpt is cut
 * at word boundaries so it reads as prose rather than as a substring.
 */
function excerptAround(text, query, span = 140) {
  const body = String(text ?? '');
  const at = body.toLowerCase().indexOf(query.trim().toLowerCase());
  if (at === -1) return body;

  let start = Math.max(0, at - Math.floor(span / 3));
  let end = Math.min(body.length, at + query.length + Math.floor((span * 2) / 3));

  if (start > 0) {
    const space = body.indexOf(' ', start);
    if (space > -1 && space < at) start = space + 1;
  }
  if (end < body.length) {
    const space = body.lastIndexOf(' ', end);
    if (space > at + query.length) end = space;
  }

  return `${start > 0 ? '\u2026' : ''}${body.slice(start, end).trim()}${end < body.length ? '\u2026' : ''}`;
}

function toolbar(counts) {
  const rerender = () => renderLibrary(document.querySelector('#view'));

  const tabs = el(
    'div.shelf-tabs',
    { role: 'tablist', 'aria-label': 'Shelves' },
    Object.entries(SHELVES)
      // On hold and Did not finish appear only once something is on them.
      .filter(([id, shelf]) => shelf.always || counts[id] > 0 || filters.shelf === id)
      .map(([id, shelf]) =>
      el(
        'button.shelf-tab',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(filters.shelf === id),
          onClick: () => {
            filters.shelf = id;
            rerender();
          },
        },
        [shelf.label, el('span.shelf-tab__count', {}, String(counts[id]))]
      )
    )
  );

  const search = el('input.input.shelf-search', {
    type: 'search',
    value: filters.query,
    placeholder: 'Search titles, authors, descriptions\u2026',
    'aria-label': 'Search the library',
    // Only the results are repainted, so the field keeps its focus, its caret
    // and any half-composed character exactly as they were.
    onInput: (event) => {
      filters.query = event.target.value;
      shown = PAGE;
      paintResults();
    },
  });

  const sort = el(
    'select.select.shelf-sort',
    {
      'aria-label': 'Sort by',
      onChange: (event) => {
        filters.sort = event.target.value;
        rerender();
      },
    },
    Object.entries(SORTS).map(([id, option]) =>
      el('option', { value: id, selected: filters.sort === id }, option.label)
    )
  );

  return el('div.shelf-bar', {}, [tabs, el('div.shelf-bar__tools', {}, [search, sort])]);
}

/** Where this book sits in the list currently being viewed. */
function orderBadge(book) {
  if (!filters.order) return null;
  const position = positionInOrder(filters.order, book.id);
  if (position === Infinity) return null;
  return el('p.shelf-card__series', {}, `#${position + 1} in this list`);
}

function tagBar(tags) {
  const rerender = () => renderLibrary(document.querySelector('#view'));
  return el('div.tag-bar', {}, [
    el('span.tag-bar__label', {}, 'Shelves'),
    ...tags.map((tag) =>
      el('button.tag', {
        type: 'button',
        'aria-pressed': String(filters.tag === tag),
        onClick: () => {
          filters.tag = filters.tag === tag ? null : tag;
          rerender();
        },
      }, tag)
    ),
    filters.tag
      ? el('button.link-btn.tag-bar__clear', {
          type: 'button',
          onClick: () => {
            filters.tag = null;
            rerender();
          },
        }, 'Clear')
      : null,
  ].filter(Boolean));
}

/**
 * Tick everything between two books, in the order currently on screen.
 * Range selection always adds; shift-clicking to *deselect* a range is a
 * behaviour people rarely want and frequently trigger by accident.
 */
function selectRange(fromId, toId) {
  const order = lastVisibleOrder;
  const start = order.indexOf(fromId);
  const end = order.indexOf(toId);
  if (start === -1 || end === -1) return;

  const [lo, hi] = start < end ? [start, end] : [end, start];
  for (let i = lo; i <= hi; i += 1) selection.add(order[i]);
  anchorId = toId;
}

/** Ids in the order they are displayed, for range selection. */
let lastVisibleOrder = [];

/**
 * Where the copies on this shelf came from.
 *
 * The same control as the kind row, for the same reason: "which of these do I
 * have to give back to the library" and "what did I actually buy this year"
 * are questions about a set of books, and a set of books is what a filter row
 * is for. Books with no source stated are offered as their own filter rather
 * than hidden, because an unfilled field is the commonest state of an imported
 * catalogue and finding them is how you fill them in.
 */
function sourceBar(books) {
  const rerender = () => renderLibrary(document.querySelector('#view'));
  const present = sourcesPresent(books);
  const unstated = books.filter((book) => !book.source).length;

  // Nothing to choose between when everything came from the same place.
  if (present.length + (unstated ? 1 : 0) < 2) return null;

  const pick = (value) => {
    filters.source = filters.source === value ? null : value;
    rerender();
  };

  return el('div.tag-bar', {}, [
    el('span.tag-bar__label', {}, 'Where from'),
    ...present.map((source) =>
      el('button.tag', {
        type: 'button',
        'aria-pressed': String(filters.source === source.id),
        onClick: () => pick(source.id),
      }, `${source.label} (${source.count})`)
    ),
    unstated
      ? el('button.tag', {
          type: 'button',
          'aria-pressed': String(filters.source === NO_SOURCE),
          onClick: () => pick(NO_SOURCE),
        }, `Not stated (${unstated})`)
      : null,
  ].filter(Boolean));
}

/** The filter value for "no source written down". */
const NO_SOURCE = '\u0000none';

function categoryBar(books) {
  const rerender = () => renderLibrary(document.querySelector('#view'));
  const present = kindsPresent(books);
  if (present.length < 2) return null;

  return el('div.tag-bar', {}, [
    el('span.tag-bar__label', {}, 'Kind'),
    ...present.map((kind) =>
      el('button.tag', {
        type: 'button',
        'aria-pressed': String(filters.category === kind.id),
        onClick: () => {
          filters.category = filters.category === kind.id ? null : kind.id;
          rerender();
        },
      }, `${kind.label} (${kind.count})`)
    ),
  ]);
}

/**
 * Filter by genre.
 *
 * Sits under Kind because it answers the finer question: kind is what the
 * object is — a book, a comic, a research paper — and genre is what it is
 * about. Both are worth filtering by and neither substitutes for the other.
 *
 * Hidden entirely when no book has a genre, rather than shown empty. A filter
 * bar with nothing in it is a promise the library cannot keep, and genre is
 * the field most likely to be blank in a hand-built catalogue.
 */
function genreBar(books) {
  const rerender = () => renderLibrary(document.querySelector('#view'));

  const counts = new Map();
  for (const book of books) {
    const genre = book.genre?.trim();
    if (!genre) continue;
    // Case-folded so "Science fiction" and "science fiction" are one genre,
    // keeping whichever spelling was seen first as the label.
    const key = genre.toLowerCase();
    const entry = counts.get(key) ?? { label: genre, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }

  if (!counts.size) return null;

  const present = [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label))
    // A long tail of one-off genres is a word cloud, not a filter.
    .slice(0, 12);

  return el('div.tag-bar', {}, [
    el('span.tag-bar__label', {}, 'Genre'),
    ...present.map(([key, entry]) =>
      el('button.tag', {
        type: 'button',
        'aria-pressed': String(filters.genre === key),
        onClick: () => {
          filters.genre = filters.genre === key ? null : key;
          rerender();
        },
      }, `${entry.label} (${entry.count})`)
    ),
    filters.genre
      ? el('button.link-btn.tag-bar__clear', {
          type: 'button',
          onClick: () => {
            filters.genre = null;
            rerender();
          },
        }, 'Clear')
      : null,
  ].filter(Boolean));
}

/** Only shows the gaps that actually exist, so it stays short. */
function needsBar(books) {
  const rerender = () => renderLibrary(document.querySelector('#view'));

  // Gaps you have decided not to care about stop being gaps. A library of
  // comics has no ISBNs and never will, and a row permanently announcing
  // "No ISBN (312)" is not a prompt, it is furniture.
  const hidden = getSettings().hiddenNeeds ?? [];
  if (hidden.includes('all')) return null;

  const present = Object.entries(NEEDS)
    .filter(([id]) => !hidden.includes(id))
    .map(([id, need]) => [id, need, books.filter(need.match).length])
    .filter(([, , count]) => count > 0);

  if (!present.length) return null;

  return el('div.tag-bar.tag-bar--needs', {}, [
    el('span.tag-bar__label', {}, 'Needs work'),
    ...present.map(([id, need, count]) =>
      el('button.tag.tag--need', {
        type: 'button',
        'aria-pressed': String(filters.need === id),
        onClick: () => {
          filters.need = filters.need === id ? null : id;
          // These live across shelves; looking at just the reading shelf would
          // hide almost every gap.
          if (filters.need) filters.shelf = 'all';
          rerender();
        },
      }, `${need.label} (${count})`)
    ),
    filters.need
      ? el('button.link-btn.tag-bar__clear', {
          type: 'button',
          onClick: () => {
            filters.need = null;
            rerender();
          },
        }, 'Clear')
      : null,
  ].filter(Boolean));
}

function orderBar(inScope) {
  const rerender = () => renderLibrary(document.querySelector('#view'));

  // Only lists with something on this shelf. A reading list offered on the
  // Reading tab that holds nothing you are currently reading is a click that
  // empties the view and tells you nothing.
  const onShelf = new Set(inScope.map((book) => book.id));
  const orders = allOrders()
    .map((order) => ({ ...order, here: order.bookIds.filter((id) => onShelf.has(id)).length }))
    .filter((order) => order.here > 0);

  if (!orders.length) return null;

  return el('div.tag-bar', {}, [
    el('span.tag-bar__label', {}, 'Reading order'),
    ...orders.map((order) =>
      el('button.tag', {
        type: 'button',
        'aria-pressed': String(filters.order === order.id),
        onClick: () => {
          filters.order = filters.order === order.id ? null : order.id;
          rerender();
        },
      }, `${order.name} (${order.here})`)
    ),
    filters.order
      ? el('span.tag-bar__note', {}, 'showing this list in its own sequence')
      : null,
  ].filter(Boolean));
}

function formatBar(books) {
  const rerender = () => renderLibrary(document.querySelector('#view'));
  const present = FORMAT_PRIORITY.filter((id) => books.some((book) => hasFormat(book, id)));
  if (present.length < 2) return null;

  return el('div.tag-bar', {}, [
    el('span.tag-bar__label', {}, 'Format'),
    ...present.map((id) =>
      el('button.tag', {
        type: 'button',
        'aria-pressed': String(filters.format === id),
        onClick: () => {
          filters.format = filters.format === id ? null : id;
          rerender();
        },
      }, `${FORMATS[id].label} (${books.filter((book) => hasFormat(book, id)).length})`)
    ),
  ]);
}

/* --- Bulk actions ---------------------------------------------------------
 *
 * Appears only once something is ticked. A toolbar of destructive buttons
 * sitting above a list that nothing is selected in is just clutter with a
 * chance of an accident.
 * -------------------------------------------------------------------------- */

function bulkBar(visible) {
  const rerender = () => renderLibrary(document.querySelector('#view'));
  // Select all and Clear only ever touch the selection, never a book — so
  // unlike every other control in this bar, they must not trigger the full
  // rerender: that resets pagination back to one page, which would silently
  // drop anything past it the moment it was selected.
  const repaint = () => paintResults();
  const chosen = () => [...selection].map((id) => getBook(id)).filter(Boolean);
  const count = selection.size;

  return el('div.bulk-bar', {}, [
    el('span.bulk-bar__count', {}, `${count} selected`),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button',
      onClick: () => {
        for (const book of visible) selection.add(book.id);
        repaint();
      },
    }, `Select all ${visible.length}`),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button',
      onClick: () => {
        selection.clear();
        repaint();
      },
    }, 'Clear'),

    el('span.bulk-bar__divider', { 'aria-hidden': 'true' }),

    el('select.select.bulk-bar__select', {
      'aria-label': 'Set status for selected books',
      onChange: (event) => {
        const status = event.target.value;
        if (!status) return;
        for (const book of chosen()) updateBook(book.id, { status });
        toast(`${count} books set to ${STATUSES[status].label.toLowerCase()}.`);
        rerender();
      },
    }, [
      el('option', { value: '' }, 'Set status\u2026'),
      ...STATUS_ORDER.map((id) => el('option', { value: id }, STATUSES[id].label)),
    ]),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button',
      onClick: () => numberSeries(chosen(), rerender),
    }, 'Number as a series'),

    el('select.select.bulk-bar__select', {
      'aria-label': 'Set format for selected books',
      onChange: (event) => {
        const [action, format] = event.target.value.split(':');
        if (!format) return;

        for (const book of chosen()) {
          const formats =
            action === 'add'
              ? [...new Set([...book.formats, format])]
              : [format];
          updateBook(book.id, { formats });
        }
        toast(
          action === 'add'
            ? `${FORMATS[format].label} added to ${count} books.`
            : `${count} books set to ${FORMATS[format].label.toLowerCase()} only.`
        );
        rerender();
      },
    }, [
      el('option', { value: '' }, 'Format\u2026'),
      // Adding is separated from replacing because they are different
      // intentions: "I also have the audiobook" must not erase "I own this
      // in print", which is what a single Set format list would have done.
      ...FORMAT_PRIORITY.map((id) =>
        el('option', { value: `add:${id}` }, `Also ${FORMATS[id].label.toLowerCase()}`)),
      ...FORMAT_PRIORITY.map((id) =>
        el('option', { value: `set:${id}` }, `Only ${FORMATS[id].label.toLowerCase()}`)),
    ]),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button', onClick: () => openShelfDialog(chosen(), rerender),
    }, 'Shelve'),

    el('select.select.bulk-bar__select', {
      'aria-label': 'Set kind for selected books',
      onChange: (event) => {
        const category = event.target.value;
        if (!category) return;
        for (const book of chosen()) updateBook(book.id, { category });
        toast(`${count} books set to ${kindLabel(category).toLowerCase()}.`);
        rerender();
      },
    }, [
      el('option', { value: '' }, 'Set kind\u2026'),
      ...allKinds().map((kind) => el('option', { value: kind.id }, kind.label)),
    ]),

    el('select.select.bulk-bar__select', {
      'aria-label': 'Set where these books came from',
      onChange: (event) => {
        const source = event.target.value;
        if (!source) return;
        // '\u0000none' clears it — the same "not stated" a single record's
        // blank option writes, so a batch of imported books can be corrected
        // back to blank as easily as it can be set.
        const value = source === NO_SOURCE ? '' : source;
        for (const book of chosen()) updateBook(book.id, { source: value });
        toast(`${count} books set to ${value ? sourceLabel(value).toLowerCase() : 'not stated'}.`);
        rerender();
      },
    }, [
      el('option', { value: '' }, 'Where from\u2026'),
      ...allSources().map((source) => el('option', { value: source.id }, source.label)),
      el('option', { value: NO_SOURCE }, 'Not stated'),
    ]),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button', onClick: () => openGenreDialog(chosen(), rerender),
    }, 'Set genre\u2026'),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button', onClick: () => openOrderDialog(chosen(), rerender),
    }, 'Add to list'),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button', onClick: () => openDetailsDialog(chosen(), rerender),
    }, 'Get details'),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button', onClick: () => openScheduleDialog(chosen(), rerender),
    }, 'Schedule'),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button', onClick: () => openShiftDialog(chosen(), rerender),
    }, 'Shift plans\u2026'),

    el('button.btn.btn--danger.btn--sm', {
      type: 'button',
      onClick: async () => {
        const books = chosen();
        const sure = await confirmAction({
          title: `Remove ${books.length} ${books.length === 1 ? 'book' : 'books'}?`,
          body: 'They can be put back straight away from the message that follows.',
          confirmLabel: 'Remove them',
        });
        if (!sure) return;

        const removed = books.map((book) => removeBook(book.id).book).filter(Boolean);
        selection.clear();
        rerender();
        toast(`${removed.length} books removed.`);

        // Deleting forty books by accident should be recoverable for longer
        // than the two seconds a toast lives.
        const rail = document.querySelector('.toast-rail .toast:last-child');
        rail?.append(
          el('button.btn.btn--sm.btn--danger', {
            style: { pointerEvents: 'auto', marginLeft: '8px' },
            onClick: () => {
              for (const book of removed) restoreBook(book);
              toast(`${removed.length} books restored.`);
              rerender();
            },
          }, 'Undo')
        );
      },
    }, 'Remove'),
  ]);
}

/**
 * Number a run of books 1..n in the order they are on screen.
 *
 * Typing volume numbers one book at a time is the single most tedious thing in
 * cataloguing a series, and it is entirely mechanical: the order is already
 * decided by whatever sort is applied, and the numbers are just 1 to n.
 *
 * The screen order is the input, deliberately. Sort by title and a run of
 * "Vol. 1..12" numbers itself correctly; sort by date added and it follows the
 * order you shelved them. Both are things someone might mean, and neither is
 * something this should second-guess.
 */
function numberSeries(books, done) {
  if (books.length < 2) {
    toast('Select the run of books first.', { variant: 'error' });
    return;
  }

  const existing = books.find((book) => book.series.name)?.series.name ?? '';
  const name = prompt(
    `Number these ${books.length} books 1 to ${books.length}, in the order shown.\n\nSeries name:`,
    existing
  )?.trim();

  if (name === undefined || name === null) return;

  const from = Number.parseFloat(
    prompt('Start numbering at:', '1') ?? '1'
  );
  if (!Number.isFinite(from)) return;

  books.forEach((book, index) => {
    updateBook(book.id, {
      series: {
        ...book.series,
        name: name || book.series.name,
        // Whole steps from the starting point, so beginning at 4.5 gives
        // 4.5, 5.5, 6.5 rather than something nobody asked for.
        number: Math.round((from + index) * 100) / 100,
        total: books.length,
      },
    });
  });

  toast(`Numbered ${books.length} books${name ? ` in ${name}` : ''}.`);
  done();
}

/**
 * Genre is one free-text field, not a list like shelves — a book has a genre,
 * it doesn't have several — so this is simpler than the shelve dialog:
 * one value, applied to every selected book, with the existing genres offered
 * as a datalist so a batch import doesn't fragment "Fantasy" into a second
 * near-miss spelling.
 */
function openGenreDialog(books, done) {
  const input = el('input.input', {
    placeholder: 'Fantasy',
    'aria-label': 'Genre to set',
    list: 'bulk-genre-suggestions',
  });

  const known = [...new Set(allBooks().map((book) => book.genre).filter(Boolean))].sort();

  const apply = () => {
    const genre = input.value.trim();
    for (const book of books) updateBook(book.id, { genre });
    modal.close();
    toast(genre ? `${books.length} books set to ${genre}.` : `Genre cleared on ${books.length} books.`);
    done();
  };

  const modal = showModal({
    eyebrow: `${books.length} books`,
    title: 'Set genre',
    body: [
      el('p', {}, 'Leave it blank and Set genre clears it on every selected book.'),
      input,
      el('datalist', { id: 'bulk-genre-suggestions' }, known.map((genre) => el('option', { value: genre }))),
    ],
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn--stamp', { type: 'button', onClick: apply }, 'Set genre'),
    ],
  });

  return modal;
}

function openShelfDialog(books, done) {
  const input = el('input.input', {
    placeholder: '2026 goal, book club',
    'aria-label': 'Shelves to add',
    list: 'bulk-shelf-suggestions',
  });

  const known = [...new Set(allBooks().flatMap((book) => book.shelves))].sort();

  const apply = (mode) => {
    const names = input.value.split(',').map((name) => name.trim()).filter(Boolean);
    if (!names.length) return;

    for (const book of books) {
      const next =
        mode === 'add'
          ? [...book.shelves, ...names]
          : book.shelves.filter(
              (shelf) => !names.some((name) => name.toLowerCase() === shelf.toLowerCase())
            );
      updateBook(book.id, { shelves: next });
    }
    modal.close();
    toast(`${books.length} books ${mode === 'add' ? 'shelved' : 'unshelved'}.`);
    done();
  };

  const modal = showModal({
    eyebrow: `${books.length} books`,
    title: 'Add to a shelf',
    body: [
      el('p', {}, 'Shelf names are matched without case, so an existing shelf will not be duplicated.'),
      input,
      el('datalist', { id: 'bulk-shelf-suggestions' }, known.map((shelf) => el('option', { value: shelf }))),
    ],
    secondaryAction: el('button.btn.btn--danger', { type: 'button', onClick: () => apply('remove') }, 'Remove from shelf'),
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn--stamp', { type: 'button', onClick: () => apply('add') }, 'Add to shelf'),
    ],
  });
}

/**
 * Move a set of plans without rewriting them.
 *
 * The scheduling dialog above hands out fresh dates, which is the wrong tool
 * for the commonest planning event there is: a week away, an illness, a book
 * that took twice as long as it should have. Everything after it needs to move
 * *by* something, keeping its length and its order. Doing that a book at a
 * time, in two date fields each, is how a plan stops being worth keeping.
 */
function openShiftDialog(books, done) {
  const planned = books.filter((book) => book.schedule.start);

  const daysInput = el('input.input', {
    type: 'number',
    step: '1',
    value: '7',
    id: 'shift-days',
    'aria-label': 'Days to shift by',
  });

  const preview = el('p.field__hint', { 'aria-live': 'polite' });

  const delta = () => Math.trunc(Number(daysInput.value) || 0);

  const paint = () => {
    const days = delta();
    if (!planned.length) {
      preview.textContent = 'None of the selected books has a plan to move.';
      return;
    }
    if (!days) {
      preview.textContent = 'Zero days moves nothing.';
      return;
    }

    // Named against the earliest plan in the selection, because that is the one
    // whose new date tells you whether you got the sign the right way round.
    const first = [...planned].sort((a, b) => a.schedule.start.localeCompare(b.schedule.start))[0];
    const to = addDays(first.schedule.start, days);

    preview.textContent =
      `${planned.length} ${planned.length === 1 ? 'plan moves' : 'plans move'} ` +
      `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ${days > 0 ? 'later' : 'earlier'}. ` +
      `${first.title} starts ${formatShort(to)}.`;
  };

  daysInput.addEventListener('input', paint);
  paint();

  const modal = showModal({
    eyebrow: `${books.length} selected`,
    title: 'Shift these plans',
    body: [
      el('div.field', {}, [
        el('label.field__label', { for: 'shift-days' }, 'By how many days'),
        daysInput,
        preview,
      ]),
      el('div.move-plan__steps', {}, [-7, -1, 1, 7].map((days) =>
        el('button.btn.btn--quiet.btn--sm', {
          type: 'button',
          onClick: () => {
            daysInput.value = String(delta() + days);
            paint();
          },
        }, `${days > 0 ? '+' : '\u2212'} ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`))),
      el('p.field__hint', {}, 'Each plan keeps its length. Books with no start date are left alone.'),
    ],
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn--stamp', {
        type: 'button',
        onClick: () => {
          const days = delta();
          if (!days || !planned.length) {
            modal.close();
            return;
          }

          // Held before the write, so undo is a restore rather than a shift
          // back — those differ the moment a book's end date was clamped.
          const before = planned.map((book) => ({
            id: book.id,
            schedule: { ...book.schedule },
          }));

          for (const book of planned) rescheduleBook(book.id, addDays(book.schedule.start, days));

          modal.close();
          toast(
            `${planned.length} ${planned.length === 1 ? 'plan' : 'plans'} moved ` +
            `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ${days > 0 ? 'later' : 'earlier'}.`,
            {
              action: {
                label: 'Undo',
                onClick: () => {
                  for (const entry of before) updateBook(entry.id, { schedule: entry.schedule });
                  toast('Plans put back.');
                  done();
                },
              },
            }
          );
          done();
        },
      }, 'Move them'),
    ],
  });

  return modal;
}

function openScheduleDialog(books, done) {
  const startInput = el('input.input', { type: 'date', 'aria-label': 'Start date' });
  const daysInput = el('input.input', { type: 'number', min: '1', value: '7', 'aria-label': 'Days per book' });
  const stagger = el('input', { type: 'checkbox', checked: true, id: 'bulk-stagger' });

  // The order is the order you ticked them in, which is invisible unless it's
  // shown — and the dates it produces are the whole point of the dialog.
  let order = [...books];
  const preview = el('ol.schedule-preview');

  const paint = () => {
    const span = Math.max(1, Number.parseInt(daysInput.value, 10) || 7);
    let cursor = startInput.value;

    fill(preview, order.map((book, index) => {
      const start = cursor;
      const end = start ? addDays(start, span - 1) : null;
      if (start && stagger.checked) cursor = addDays(end, 1);

      return el('li.schedule-preview__row', {}, [
        el('span.schedule-preview__n', {}, String(index + 1)),
        el('span.schedule-preview__title', {}, book.title),
        el('span.schedule-preview__dates', {},
          start ? `${formatShort(start)} \u2013 ${formatShort(end)}` : 'pick a start date'),
        el('span.schedule-preview__moves', {}, [
          moveButton('\u2191', 'Move up', index > 0, () => {
            [order[index - 1], order[index]] = [order[index], order[index - 1]];
            paint();
          }),
          moveButton('\u2193', 'Move down', index < order.length - 1, () => {
            [order[index + 1], order[index]] = [order[index], order[index + 1]];
            paint();
          }),
        ]),
      ]);
    }));
  };

  [startInput, daysInput, stagger].forEach((node) => node.addEventListener('change', paint));
  daysInput.addEventListener('input', paint);
  paint();

  const modal = showModal({
    eyebrow: `${books.length} books, in this order`,
    title: 'Schedule these',
    wide: true,
    body: [
      el('div.field-row', {}, [
        el('label.field', {}, [el('span.field__label', {}, 'Start on'), startInput]),
        el('label.field', {}, [el('span.field__label', {}, 'Days each'), daysInput]),
      ]),
      el('label.bulk-check', { for: 'bulk-stagger' }, [
        stagger,
        el('span', {}, 'Read them one after another rather than all at once'),
      ]),
      el('p.field__hint', {}, 'Listed in the order you selected them. Reorder with the arrows.'),
      preview,
    ],
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn--stamp', {
        type: 'button',
        onClick: () => {
          const start = startInput.value;
          const span = Math.max(1, Number.parseInt(daysInput.value, 10) || 7);
          if (!start) return;

          let cursor = start;
          for (const book of order) {
            const end = addDays(cursor, span - 1);
            updateBook(book.id, { schedule: { start: cursor, end, rebase: null } });
            if (stagger.checked) cursor = addDays(end, 1);
          }
          modal.close();
          toast(`${order.length} books scheduled.`);
          done();
        },
      }, 'Schedule'),
    ],
  });
}

const moveButton = (glyph, label, enabled, onClick) =>
  el('button.icon-btn.schedule-preview__move', {
    type: 'button', 'aria-label': label, disabled: !enabled, onClick,
  }, glyph);

/**
 * Fill in what's missing across many books at once.
 *
 * Runs sequentially with a pause between lookups. Open Library is free and
 * donation-funded; four hundred parallel requests is both rude and the fastest
 * way to have all of them refused.
 */
/**
 * Append a selection to a reading order, in the order shown on screen.
 *
 * Selection order is what bulk scheduling uses, but here the on-screen
 * sequence is more useful: sort by series, select a run of comics, and they
 * arrive in the list already in the right order.
 */
function openOrderDialog(books, done) {
  const orders = allOrders();
  const select = el('select.select', { 'aria-label': 'Reading order' }, [
    ...orders.map((order) => el('option', { value: order.id }, `${order.name} (${order.bookIds.length})`)),
    el('option', { value: '__new' }, 'New list\u2026'),
  ]);

  const nameInput = el('input.input', {
    placeholder: 'Poe, in order',
    'aria-label': 'New list name',
    hidden: orders.length > 0,
  });

  select.addEventListener('change', () => {
    nameInput.hidden = select.value !== '__new';
  });
  if (!orders.length) select.value = '__new';

  const ordered = books
    .slice()
    .sort((a, b) => lastVisibleOrder.indexOf(a.id) - lastVisibleOrder.indexOf(b.id));

  const modal = showModal({
    eyebrow: `${books.length} books`,
    title: 'Add to a reading order',
    body: [
      orders.length ? el('label.field', {}, [el('span.field__label', {}, 'List'), select]) : select,
      nameInput,
      el('p.field__hint', {}, 'They will be appended in the order shown in the library, so sorting by series first gets a run of comics into sequence.'),
      el('ol.schedule-preview', {}, ordered.map((book, index) =>
        el('li.schedule-preview__row', {}, [
          el('span.schedule-preview__n', {}, String(index + 1)),
          el('span.schedule-preview__title', {}, book.title),
        ]))),
    ],
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn--stamp', {
        type: 'button',
        onClick: () => {
          let orderId = select.value;

          if (orderId === '__new') {
            const created = createOrder({ name: nameInput.value });
            if (!created.ok) {
              toast(Object.values(created.errors)[0], { variant: 'error' });
              return;
            }
            orderId = created.order.id;
          }

          const result = addToOrder(orderId, ordered.map((book) => book.id));
          modal.close();
          toast(`${result.added ?? 0} books added to the list.`);
          done();
        },
      }, 'Add to list'),
    ],
  });
}

function openDetailsDialog(books, done) {
  const gappy = books.filter((book) => needsDetails(book));
  const progress = el('p.settings__note', { 'aria-live': 'polite' },
    gappy.length
      ? `${gappy.length} of ${books.length} selected books are missing something.`
      : 'Every selected book already has its details.');

  let cancelled = false;

  const run = async () => {
    startButton.disabled = true;
    let filled = 0;

    await enrichAll(gappy, ({ book, patch, filled: fields, index }) => {
      if (cancelled) return;
      if (fields.length) {
        updateBook(book.id, patch);
        filled += 1;
      }
      progress.textContent = `Looked up ${index + 1} of ${gappy.length}\u2014 filled in ${filled}.`;
    }, { delayMs: 300 });

    startButton.disabled = false;
    if (!cancelled) {
      toast(`Filled in details for ${filled} books.`);
      modal.close();
      done();
    }
  };

  const startButton = el('button.btn.btn--stamp', {
    type: 'button', disabled: gappy.length === 0, onClick: run,
  }, gappy.length ? `Look up ${gappy.length} books` : 'Nothing to fetch');

  const modal = showModal({
    eyebrow: `${books.length} selected`,
    title: 'Fill in missing details',
    body: [
      el('p', {}, 'Looks each book up by ISBN, or by title when there is no ISBN, and fills in only the fields that are currently empty. Nothing you have already entered is changed.'),
      el('p.settings__note', {}, 'Lookups run one at a time out of courtesy to Open Library, so a long list takes a minute.'),
      progress,
    ],
    onClose: () => {
      cancelled = true;
    },
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Cancel'),
      startButton,
    ],
  });
}

/**
 * Give a book its cover from something dropped on it.
 *
 * The shortest path from "I don't like that cover" to a better one. Everything
 * else — the picker, the ISBN lookup, the catalogue search — needs the book
 * open in a form first, which is three clicks and a modal to change a picture
 * you are already looking at.
 */
async function coverDropped(book, payload) {
  const result = payload.file
    ? await setCoverFromFile(book, payload.file)
    : await setCoverFromUrl(book, payload.url);

  toast(
    result.ok
      ? `New cover for ${book.title}.`
      : result.error,
    result.ok ? {} : { variant: 'error' }
  );
}

function shelfCard(book) {
  const unit = formatUnit(book);

  const picked = selection.has(book.id);

  const card = el('li.shelf-card.slip.slip--plain', {
    class: picked ? 'is-selected' : '',
    // Marks this as somewhere a file may legitimately land, so the window-wide
    // guard leaves it alone.
    dataset: { coverDrop: 'book' },
  }, [
    el('label.shelf-card__pick', {}, [
      el('input', {
        type: 'checkbox',
        checked: picked,
        'aria-label': `Select ${book.title}. Shift-click to select a range.`,
        onClick: (event) => {
          // Shift-click selects everything between here and the last box you
          // touched, the way every file manager and mail client behaves.
          // Ticking forty boxes one at a time is not a workflow.
          if (event.shiftKey && anchorId && anchorId !== book.id) {
            event.preventDefault();
            selectRange(anchorId, book.id);
            // Not the full renderLibrary: that resets `shown` back to one page,
            // which is exactly wrong here — selecting a book only reachable
            // through "Show more" made it, and everything past it, vanish
            // again, right as it was clicked. Ticking a box changes nothing
            // about which shelf, sort or filter is in effect, so nothing about
            // the toolbar needs rebuilding either.
            paintResults();
            return;
          }
          anchorId = book.id;
        },
        onChange: (event) => {
          if (event.target.checked) selection.add(book.id);
          else selection.delete(book.id);
          anchorId = book.id;
          paintResults();
        },
      }),
    ]),
    el(
      'button.shelf-card__hit',
      {
        type: 'button',
        onClick: () => openBookForm({ book }),
        'aria-label': `Edit ${book.title}`,
      },
      [
        coverThumb(book, { width: '100%', alt: '' }),
        el('div.shelf-card__body', {}, [
          el('h3.shelf-card__title', {}, book.title),
          el('p.shelf-card__author', {}, book.author || 'Unknown author'),
          book.series.name
            ? el('p.shelf-card__series', {},
                `${book.series.name}${book.series.number ? ` #${book.series.number}` : ''}${book.series.total ? ` of ${book.series.total}` : ''}`)
            : null,
          statusLine(book, unit),
          book.formats.length > 1
            ? el('p.shelf-card__formats', {}, formatLabel(book))
            : null,
          book.source
            ? el('p.shelf-card__source', {}, sourceLabel(book.source))
            : null,
          orderBadge(book),
          book.rating ? el('p.shelf-card__rating', { 'aria-label': `${book.rating} out of 5` }, '\u2605'.repeat(book.rating)) : null,
          book.description || book.notes || matchedInText(book, filters.query)
            ? el('p.shelf-card__blurb', {
                // When the only reason this book is on screen is a phrase in
                // its blurb, show that phrase rather than the opening line.
                class: matchedInText(book, filters.query) ? 'shelf-card__blurb--hit' : '',
              },
              matchedInText(book, filters.query)
                ? excerptAround(writtenText(book), filters.query)
                : book.description)
            : null,
        ].filter(Boolean)),
      ]
    ),
    // The status badge sits on top of the cover, which is exactly where a
    // cover's title often is — so it can be switched off in Settings without
    // losing the status, which is still on the row below and in every filter.
    showsStatusBadge()
      ? el('span', { class: `chip chip--${book.status} shelf-card__chip` },
          STATUSES[book.status].label)
      : null,
    book.status === 'reading' && book.progress.percent > 0 ? progressBar(book) : null,
    el('span.shelf-card__droptip', { 'aria-hidden': 'true' }, 'Drop to set cover'),
  ]);

  return acceptCoverDrop(card, { onImage: (payload) => coverDropped(book, payload) });
}

/** The one line of metadata that matters most for the shelf a book is on. */
function statusLine(book, unit) {
  if (book.status === 'finished' && book.actual.finishedAt) {
    return el('p.shelf-card__meta', {}, `Finished ${formatShort(book.actual.finishedAt)}`);
  }
  if (book.status === 'reading' && book.pageCount) {
    const report = progressReport(book);
    const where = `${unit === 'minutes' ? 'Minute' : 'Page'} ${report.done} of ${report.total}`;
    return el('div', {}, [
      el('p.shelf-card__meta', {}, `${where} \u00b7 ${report.percent}%`),
      report.projected
        ? el('p.shelf-card__meta', { class: `is-${report.verdict?.tone ?? 'on-time'}` },
            `Finishing ${formatShort(report.projected)}${report.timeLeft ? ` \u00b7 ${report.timeLeft} left` : ''}`)
        : null,
    ].filter(Boolean));
  }
  if (book.schedule.start) {
    return el('p.shelf-card__meta', {}, `Starts ${relativeDay(book.schedule.start)}`);
  }
  return el('p.shelf-card__meta', {}, book.pageCount ? `${book.pageCount} ${unit}` : 'Unscheduled');
}

function progressBar(book) {
  const percent = Math.round(book.progress.percent);
  return el(
    'div.progress',
    {
      role: 'progressbar',
      'aria-valuenow': String(percent),
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-label': `${book.title} progress`,
    },
    el('span.progress__fill', { style: { width: `${percent}%` } })
  );
}

function emptyLibrary() {
  return el('div.empty', {}, [
    el('h3', {}, 'Nothing catalogued yet'),
    el('p', {}, 'Add your first book to start building the shelf. Title is the only thing required — a cover, a length, and a plan can all come later.'),
    el('button.btn.btn--stamp', { type: 'button', onClick: () => openBookForm() }, 'Add a book'),
    el('p.empty__aside', {}, [
      'Just looking? ',
      el('button.link-btn', {
        type: 'button',
        onClick: () => loadSampleLibrary(),
      }, 'Load a sample library'),
      ' to see the calendar with something on it.',
    ]),
  ]);
}

/**
 * Nothing to show, and a way back.
 *
 * The dead end this fixes: filter to a genre held by one book, delete that
 * book, and the filter bars vanish with it — they only render for the books
 * currently on screen, and there are none. The filter stays on, every shelf
 * looks empty, and nothing on the page can turn it off. The only way out was
 * a page reload.
 *
 * So the empty state names every filter still applied and offers to drop them.
 * An empty view has more reason to explain itself than a full one, not less.
 */
function emptyShelf() {
  const rerender = () => renderLibrary(document.querySelector('#view'));

  const applied = [
    filters.query ? { label: `search "${filters.query}"`, clear: () => { filters.query = ''; } } : null,
    filters.tag ? { label: `shelf "${filters.tag}"`, clear: () => { filters.tag = null; } } : null,
    filters.genre ? { label: `genre "${filters.genre}"`, clear: () => { filters.genre = null; } } : null,
    filters.category
      ? { label: `kind "${kindLabel(filters.category)}"`, clear: () => { filters.category = null; } }
      : null,
    filters.source
      ? {
          label: filters.source === NO_SOURCE
            ? 'books with no source'
            : `source "${sourceLabel(filters.source)}"`,
          clear: () => { filters.source = null; },
        }
      : null,
    filters.format
      ? { label: `format "${FORMATS[filters.format]?.label ?? filters.format}"`, clear: () => { filters.format = null; } }
      : null,
    filters.order ? { label: 'a reading list', clear: () => { filters.order = null; } } : null,
    filters.need ? { label: 'a "needs work" filter', clear: () => { filters.need = null; } } : null,
  ].filter(Boolean);

  return el('div.empty', {}, [
    el('h3', {}, applied.length ? 'Nothing matches those filters' : 'This shelf is empty'),
    el('p', {},
      applied.length
        ? `Still filtering by ${applied.map((entry) => entry.label).join(', ')}.`
        : 'Move a book here by changing its status, or add a new one.'),

    applied.length
      ? el('div.empty__actions', {}, [
          ...applied.map((entry) =>
            el('button.btn.btn--quiet.btn--sm', {
              type: 'button',
              onClick: () => {
                entry.clear();
                rerender();
              },
            }, `Clear ${entry.label}`)),
          applied.length > 1
            ? el('button.btn.btn--stamp.btn--sm', {
                type: 'button',
                onClick: () => {
                  for (const entry of applied) entry.clear();
                  rerender();
                },
              }, 'Clear all filters')
            : null,
        ].filter(Boolean))
      : null,
  ].filter(Boolean));
}
