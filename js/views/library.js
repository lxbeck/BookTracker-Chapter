/**
 * Library view — the shelves.
 *
 * One view, filtered: To read, Reading, Finished, and the full catalogue.
 * Filter state lives in module scope rather than the store, because which tab
 * you're looking at isn't data worth persisting between sessions — and keeping
 * it out of the store means a filter change never touches localStorage.
 */

import { el, fill } from '../lib/dom.js';
import { allBooks } from '../data/store.js';
import { STATUSES, FORMATS } from '../data/schema.js';
import { coverThumb } from './cover.js';
import { openBookForm } from './bookForm.js';
import { formatShort, relativeDay } from '../lib/dates.js';
import { loadSampleLibrary } from '../data/seed.js';
import { progressReport } from '../logic/pacing.js';

/** Tabs are reading intents, not raw statuses — "To read" folds in on-hold. */
const SHELVES = {
  reading: { label: 'Reading', match: (b) => b.status === 'reading' },
  tbr: { label: 'To read', match: (b) => b.status === 'planned' || b.status === 'on-hold' },
  finished: { label: 'Finished', match: (b) => b.status === 'finished' },
  all: { label: 'Everything', match: () => true },
};

const SORTS = {
  planned: {
    label: 'By plan date',
    compare: (a, b) => (a.schedule.start ?? '9999').localeCompare(b.schedule.start ?? '9999'),
  },
  added: { label: 'Recently added', compare: (a, b) => b.createdAt.localeCompare(a.createdAt) },
  title: { label: 'Title', compare: (a, b) => a.title.localeCompare(b.title) },
  author: { label: 'Author', compare: (a, b) => (a.author || '~').localeCompare(b.author || '~') },
  length: { label: 'Length', compare: (a, b) => (b.pageCount ?? 0) - (a.pageCount ?? 0) },
};

const filters = { shelf: 'reading', sort: 'planned', query: '' };

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

  const visible = books
    .filter(SHELVES[filters.shelf].match)
    .filter(matchesQuery(filters.query))
    .sort(SORTS[filters.sort].compare);

  fill(mount, [
    el('div.view-head', {}, [
      el('div', {}, [
        el('h2.view-title', {}, 'The library'),
        el('p.view-sub', {}, `${books.length} record${books.length === 1 ? '' : 's'} catalogued`),
      ]),
      el('button.btn.btn--stamp', { type: 'button', onClick: () => openBookForm() }, 'Add a book'),
    ]),

    books.length ? toolbar(counts) : null,

    books.length === 0
      ? emptyLibrary()
      : visible.length === 0
        ? emptyShelf()
        : el('ul.shelf', {}, visible.map(shelfCard)),
  ]);
}

const matchesQuery = (query) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return () => true;
  return (book) =>
    [book.title, book.author, book.genre, book.series.name]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(needle));
};

function toolbar(counts) {
  const rerender = () => renderLibrary(document.querySelector('#view'));

  const tabs = el(
    'div.shelf-tabs',
    { role: 'tablist', 'aria-label': 'Shelves' },
    Object.entries(SHELVES).map(([id, shelf]) =>
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
    placeholder: 'Search title, author, genre\u2026',
    'aria-label': 'Search the library',
    onInput: (event) => {
      filters.query = event.target.value;
      rerender();
      // Re-rendering blows away focus; put it back with the caret at the end.
      const next = document.querySelector('.shelf-search');
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
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

function shelfCard(book) {
  const unit = FORMATS[book.format].unit;

  return el('li.shelf-card.slip.slip--plain', {}, [
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
          statusLine(book, unit),
        ]),
      ]
    ),
    el('span', { class: `chip chip--${book.status} shelf-card__chip` }, STATUSES[book.status].label),
    book.status === 'reading' && book.progress.percent > 0 ? progressBar(book) : null,
  ]);
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

function emptyShelf() {
  return el('div.empty', {}, [
    el('h3', {}, 'This shelf is empty'),
    el(
      'p',
      {},
      filters.query
        ? 'Nothing here matches that search. Try a different term, or another shelf.'
        : 'Move a book here by changing its status, or add a new one.'
    ),
  ]);
}
