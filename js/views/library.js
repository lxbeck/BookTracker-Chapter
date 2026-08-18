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
import { enrichAll, needsDetails } from '../data/enrich.js';
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
  finished: {
    label: 'Date finished',
    // Unfinished books sort last rather than first: a list ordered by finish
    // date is being read for the finished ones.
    compare: (a, b) =>
      (b.actual.finishedAt ?? '').localeCompare(a.actual.finishedAt ?? '') ||
      a.title.localeCompare(b.title),
  },
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

/**
 * Books currently ticked. A Set of ids, so a re-render can't stale them — and
 * insertion order is meaningful: it's the order bulk scheduling reads.
 */
const selection = new Set();

/** The last box clicked, so shift-click knows where a range starts. */
let anchorId = null;

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
  lastVisibleOrder = visible.map((book) => book.id);

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

    el('select.select.bulk-bar__select', {
      'aria-label': 'Set format for selected books',
      onChange: (event) => {
        const format = event.target.value;
        if (!format) return;
        for (const book of chosen()) updateBook(book.id, { format });
        toast(`${count} books set to ${FORMATS[format].label.toLowerCase()}.`);
        rerender();
      },
    }, [
      el('option', { value: '' }, 'Set format\u2026'),
      ...FORMAT_ORDER.map((id) => el('option', { value: id }, FORMATS[id].label)),
    ]),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button', onClick: () => openShelfDialog(chosen(), rerender),
    }, 'Shelve'),

    el('button.btn.btn--quiet.btn--sm', {
      type: 'button', onClick: () => openDetailsDialog(chosen(), rerender),
    }, 'Get details'),

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

function shelfCard(book) {
  const unit = FORMATS[book.format].unit;

  const picked = selection.has(book.id);

  return el('li.shelf-card.slip.slip--plain', { class: picked ? 'is-selected' : '' }, [
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
            renderLibrary(document.querySelector('#view'));
            return;
          }
          anchorId = book.id;
        },
        onChange: (event) => {
          if (event.target.checked) selection.add(book.id);
          else selection.delete(book.id);
          anchorId = book.id;
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
