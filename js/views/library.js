/**
 * Library view — the shelves.
 *
 * One view, filtered: To read, Reading, Finished, and the full catalogue.
 * Filter state lives in module scope rather than the store, because which tab
 * you're looking at isn't data worth persisting between sessions — and keeping
 * it out of the store means a filter change never touches localStorage.
 */

import { el, fill, toast } from '../lib/dom.js';
import { showModal } from './modal.js';
import { allBooks, updateBook, removeBook, restoreBook, getBook } from '../data/store.js';
import { STATUSES, STATUS_ORDER, FORMATS } from '../data/schema.js';
import { coverThumb } from './cover.js';
import { openBookForm } from './bookForm.js';
import { formatShort, relativeDay } from '../lib/dates.js';
import { loadSampleLibrary } from '../data/seed.js';
import { addDays } from '../lib/dates.js';
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
  format: {
    label: 'Format',
    // Group by format, then read alphabetically within each group — a format
    // sort that scatters titles randomly inside each group is half a sort.
    compare: (a, b) =>
      FORMAT_ORDER.indexOf(a.format) - FORMAT_ORDER.indexOf(b.format) ||
      a.title.localeCompare(b.title),
  },
};

const FORMAT_ORDER = ['physical', 'ebook', 'audio'];

/** Books currently ticked. Ids, not records, so a re-render can't stale them. */
const selection = new Set();

const filters = { shelf: 'reading', sort: 'planned', query: '', tag: null, format: null };

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

  const tags = [...new Set(books.flatMap((book) => book.shelves))].sort();
  if (filters.tag && !tags.includes(filters.tag)) filters.tag = null;

  const visible = books
    .filter(SHELVES[filters.shelf].match)
    .filter(matchesQuery(filters.query))
    .filter((book) => !filters.tag || book.shelves.includes(filters.tag))
    .filter((book) => !filters.format || book.format === filters.format)
    .sort(SORTS[filters.sort].compare);

  // Anything ticked but no longer on screen would be edited invisibly.
  const visibleIds = new Set(visible.map((book) => book.id));
  for (const id of [...selection]) if (!visibleIds.has(id)) selection.delete(id);

  fill(mount, [
    el('div.view-head', {}, [
      el('div', {}, [
        el('h2.view-title', {}, 'The library'),
        el('p.view-sub', {}, `${books.length} record${books.length === 1 ? '' : 's'} catalogued`),
      ]),
      el('button.btn.btn--stamp', { type: 'button', onClick: () => openBookForm() }, 'Add a book'),
    ]),

    books.length ? toolbar(counts) : null,
    books.length ? formatBar(books) : null,
    tags.length ? tagBar(tags) : null,
    selection.size ? bulkBar(visible) : null,

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

function formatBar(books) {
  const rerender = () => renderLibrary(document.querySelector('#view'));
  const present = FORMAT_ORDER.filter((id) => books.some((book) => book.format === id));
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
      }, `${FORMATS[id].label} (${books.filter((book) => book.format === id).length})`)
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
  const chosen = () => [...selection].map((id) => getBook(id)).filter(Boolean);
  const count = selection.size;

  return el('div.bulk-bar', {}, [
    el('span.bulk-bar__count', {}, `${count} selected`),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button',
      onClick: () => {
        for (const book of visible) selection.add(book.id);
        rerender();
      },
    }, `Select all ${visible.length}`),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button',
      onClick: () => {
        selection.clear();
        rerender();
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
      type: 'button', onClick: () => openShelfDialog(chosen(), rerender),
    }, 'Shelve'),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button', onClick: () => openScheduleDialog(chosen(), rerender),
    }, 'Schedule'),

    el('button.btn.btn--danger.btn--sm', {
      type: 'button',
      onClick: () => {
        const books = chosen();
        if (!confirm(`Remove ${books.length} books from the library? This can be undone straight away.`)) return;

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

function openScheduleDialog(books, done) {
  const startInput = el('input.input', { type: 'date', 'aria-label': 'Start date' });
  const daysInput = el('input.input', { type: 'number', min: '1', value: '7', 'aria-label': 'Days per book' });
  const stagger = el('input', { type: 'checkbox', checked: true, id: 'bulk-stagger' });

  const modal = showModal({
    eyebrow: `${books.length} books`,
    title: 'Schedule these',
    body: [
      el('div.field-row', {}, [
        el('label.field', {}, [el('span.field__label', {}, 'Start on'), startInput]),
        el('label.field', {}, [el('span.field__label', {}, 'Days each'), daysInput]),
      ]),
      el('label.bulk-check', { for: 'bulk-stagger' }, [
        stagger,
        el('span', {}, 'Read them one after another rather than all at once'),
      ]),
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
          for (const book of books) {
            const end = addDays(cursor, span - 1);
            updateBook(book.id, { schedule: { start: cursor, end, rebase: null } });
            if (stagger.checked) cursor = addDays(end, 1);
          }
          modal.close();
          toast(`${books.length} books scheduled.`);
          done();
        },
      }, 'Schedule'),
    ],
  });
}

function shelfCard(book) {
  const unit = FORMATS[book.format].unit;

  const picked = selection.has(book.id);

  return el('li.shelf-card.slip.slip--plain', { class: picked ? 'is-selected' : '' }, [
    el('label.shelf-card__pick', {}, [
      el('input', {
        type: 'checkbox',
        checked: picked,
        'aria-label': `Select ${book.title}`,
        onChange: (event) => {
          if (event.target.checked) selection.add(book.id);
          else selection.delete(book.id);
          renderLibrary(document.querySelector('#view'));
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
          book.rating ? el('p.shelf-card__rating', { 'aria-label': `${book.rating} out of 5` }, '\u2605'.repeat(book.rating)) : null,
          book.description
            ? el('p.shelf-card__blurb', {}, book.description)
            : null,
        ].filter(Boolean)),
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
