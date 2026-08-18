/**
 * Add / edit book form.
 *
 * The form owns a draft copy of the book and only touches the store on save,
 * so cancelling is genuinely free and validation errors can be shown per field
 * without half-written records reaching the library.
 */

import { el, fill, $, toast } from '../lib/dom.js';
import { showModal } from './modal.js';
import { coverPicker } from './coverPicker.js';
import { sessionLog } from './sessionLog.js';
import { progressReport, catchUpPreview, catchUpPatch } from '../logic/pacing.js';
import { allBooks } from '../data/store.js';
import { STATUSES, STATUS_ORDER, FORMATS, blankBook } from '../data/schema.js';
import { formatShort } from '../lib/dates.js';
import { addBook, updateBook, removeBook, restoreBook, getBook } from '../data/store.js';
import { addDays } from '../lib/dates.js';
import { fetchMissingDetails, missingFields } from '../data/enrich.js';

/**
 * @param {Object} [options]
 * @param {Object} [options.book] - existing book; omit to add a new one
 * @param {string} [options.defaultStart] - prefill the plan start (day click)
 * @param {(book: object) => void} [options.onSaved]
 */
export function openBookForm({ book = null, defaultStart = null, onSaved } = {}) {
  const isEdit = Boolean(book);
  const draft = book
    ? structuredClone(book)
    : blankBook({ schedule: { start: defaultStart, end: null } });

  const fields = {};

  const field = (name, label, control, hint) => {
    const wrap = el('div.field', {}, [
      el('label.field__label', { for: `f-${name}`, text: label }),
      control,
      hint && el('span.field__hint', { text: hint }),
      el('span.field__error', { id: `err-${name}`, hidden: true }),
    ]);
    fields[name] = { wrap, control };
    return wrap;
  };

  const input = (name, attrs = {}) =>
    el('input.input', {
      id: `f-${name}`,
      name,
      'aria-describedby': `err-${name}`,
      ...attrs,
    });

  const titleInput = input('title', {
    value: draft.title,
    placeholder: 'A Princess of Mars',
    required: true,
  });
  const authorInput = input('author', { value: draft.author, placeholder: 'Edgar Rice Burroughs' });
  const isbnInput = input('isbn', { value: draft.isbn, placeholder: '9780486436173' });
  const pagesInput = input('pageCount', {
    type: 'number',
    min: '1',
    value: draft.pageCount ?? '',
    placeholder: '448',
  });
  const genreInput = input('genre', { value: draft.genre, placeholder: 'Adventure' });

  const descriptionInput = el('textarea.textarea', {
    id: 'f-description',
    name: 'description',
    rows: '4',
    placeholder: 'Fetched automatically when you look a book up by ISBN.',
  }, draft.description ?? '');

  const seriesNameInput = input('series.name', {
    value: draft.series.name,
    placeholder: 'Barsoom',
  });
  const seriesNumberInput = input('series.number', {
    type: 'number', min: '1', value: draft.series.number ?? '', placeholder: '2',
  });
  const seriesTotalInput = input('series.total', {
    type: 'number', min: '1', value: draft.series.total ?? '', placeholder: '4',
  });

  const shelvesInput = input('shelves', {
    value: draft.shelves.join(', '),
    placeholder: '2026 goal, book club, rereads',
    list: 'shelf-suggestions',
  });

  // Offer the shelves already in use, so they don't fragment into near-misses.
  const knownShelves = [...new Set(allBooks().flatMap((book) => book.shelves))].sort();
  const shelfList = el('datalist', { id: 'shelf-suggestions' },
    knownShelves.map((shelf) => el('option', { value: shelf })));

  const notesInput = el('textarea.textarea', {
    id: 'f-notes', name: 'notes', rows: '3',
    placeholder: 'Anything you want to remember about this book.',
  }, draft.notes ?? '');

  const reviewInput = el('textarea.textarea', {
    id: 'f-review', name: 'review', rows: '3',
    placeholder: 'A few lines on what you thought.',
  }, draft.review ?? '');

  const progressInput = input('progress.page', {
    type: 'number',
    min: '0',
    value: draft.progress.page || '',
    placeholder: '79',
  });

  const ratingControl = starRating(draft.rating, (value) => {
    draft.rating = value;
  });

  const quotesBlock = quotesEditor(draft);

  const formatSelect = el(
    'select.select',
    { id: 'f-format', name: 'format' },
    Object.values(FORMATS).map((format) =>
      el('option', { value: format.id, selected: draft.format === format.id }, format.label)
    )
  );

  const statusSelect = el(
    'select.select',
    { id: 'f-status', name: 'status' },
    STATUS_ORDER.map((id) =>
      el('option', { value: id, selected: draft.status === id }, STATUSES[id].label)
    )
  );

  const startInput = input('schedule.start', { type: 'date', value: draft.schedule.start ?? '' });
  const endInput = input('schedule.end', { type: 'date', value: draft.schedule.end ?? '' });

  // The record, as distinct from the plan. Finishing a book fills these in on
  // its own; they're editable for the times it didn't happen that way.
  const startedInput = input('actual.startedAt', {
    type: 'date',
    value: draft.actual.startedAt ?? '',
  });
  const finishedInput = input('actual.finishedAt', {
    type: 'date',
    value: draft.actual.finishedAt ?? '',
  });

  const paceNote = el('p.field__hint', { id: 'pace-note' });

  /** Live feedback: what this plan actually asks of you per day. */
  function refreshPaceNote() {
    const start = startInput.value;
    const end = endInput.value;
    const pages = Number.parseInt(pagesInput.value, 10);
    const unit = FORMATS[formatSelect.value].unit;

    if (!start || !end || !pages || end < start) {
      paceNote.textContent = 'Set a length and both dates to see the daily pace.';
      return;
    }
    const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
    const perDay = Math.ceil(pages / days);
    paceNote.textContent = `${days} day${days === 1 ? '' : 's'} — about ${perDay} ${unit} a day.`;
  }

  [startInput, endInput, pagesInput, formatSelect].forEach((node) =>
    node.addEventListener('input', refreshPaceNote)
  );

  // Picking a start date almost always means "and about a week". Filling the
  // finish date in saves the second date picker, and it stays editable, so the
  // guess costs nothing when it's wrong.
  startInput.addEventListener('change', () => {
    if (!startInput.value || endInput.value) return;
    endInput.value = addDays(startInput.value, 6);
    refreshPaceNote();
  });

  refreshPaceNote();

  // Cover art. A lookup can autofill the fields the user hasn't filled in
  // themselves — never overwrite what they typed.
  const picker = coverPicker({
    draft,
    readForm: () => ({
      isbn: isbnInput.value,
      title: titleInput.value,
      author: authorInput.value,
    }),
    onPick: (cover, meta) => {
      draft.cover = cover;
      if (!meta) return;
      if (!titleInput.value.trim() && meta.title) titleInput.value = meta.title;
      if (!authorInput.value.trim() && meta.author) authorInput.value = meta.author;
      if (!isbnInput.value.trim() && meta.isbn) isbnInput.value = meta.isbn;
      if (!pagesInput.value && meta.pageCount) {
        pagesInput.value = meta.pageCount;
        refreshPaceNote();
      }
      if (!descriptionInput.value.trim() && meta.description) {
        descriptionInput.value = meta.description;
      }
      if (!genreInput.value.trim() && meta.genre) genreInput.value = meta.genre;
    },
  });

  /**
   * Fill the empty fields from a lookup. Reads the form rather than the saved
   * record, so it respects anything typed but not yet saved, and writes back
   * into the inputs rather than the store — nothing is committed until Save.
   */
  const detailsNote = el('p.field__hint', { 'aria-live': 'polite' });

  const detailsButton = el('button.btn.btn--quiet.btn--sm', {
    type: 'button',
    onClick: async () => {
      const current = collect();
      const gaps = missingFields(current);
      if (!gaps.length) {
        detailsNote.textContent = 'Nothing is missing on this record.';
        return;
      }

      detailsButton.disabled = true;
      detailsNote.textContent = `Looking up ${gaps.join(', ')}\u2026`;
      const result = await fetchMissingDetails(current);
      detailsButton.disabled = false;

      if (!result.ok) {
        detailsNote.textContent = result.reason;
        return;
      }

      // Written into the fields, never over them.
      if (result.patch.pageCount && !pagesInput.value) {
        pagesInput.value = result.patch.pageCount;
        refreshPaceNote();
      }
      if (result.patch.description && !descriptionInput.value.trim()) {
        descriptionInput.value = result.patch.description;
      }
      if (result.patch.author && !authorInput.value.trim()) authorInput.value = result.patch.author;
      if (result.patch.genre && !genreInput.value.trim()) genreInput.value = result.patch.genre;
      if (result.patch.isbn && !isbnInput.value.trim()) isbnInput.value = result.patch.isbn;
      if (result.patch.cover?.url && !draft.cover.url) draft.cover = result.patch.cover;

      detailsNote.textContent = `Filled in ${result.filled.join(', ')}. Save to keep it.`;
    },
  }, 'Get details');

  const body = [
    isEdit ? progressStrip(draft) : null,
    el('div.field', {}, [
      el('span.field__label', { text: 'Cover' }),
      picker,
    ]),
    el('div.details-row', {}, [detailsButton, detailsNote]),
    field('title', 'Title', titleInput),
    el('div.field-row', {}, [
      field('author', 'Author', authorInput),
      field('isbn', 'ISBN', isbnInput, 'Used to look up cover art'),
    ]),
    el('div.field-row', {}, [
      field('format', 'Format', formatSelect),
      field('pageCount', 'Length', pagesInput, 'Pages, or minutes for audio'),
      field('genre', 'Genre', genreInput),
    ]),
    field('status', 'Status', statusSelect),
    el('div.field', {}, [
      el('label.field__label', { for: 'f-description', text: 'Description' }),
      descriptionInput,
    ]),
    el('fieldset.plan-block', {}, [
      el('legend.field__label', { text: 'Series' }),
      el('div.field-row', {}, [
        field('series.name', 'Series name', seriesNameInput),
        field('series.number', 'Book number', seriesNumberInput),
        field('series.total', 'Of how many', seriesTotalInput),
      ]),
    ]),
    el('fieldset.plan-block', {}, [
      el('legend.field__label', { text: 'Reading plan' }),
      el('div.field-row', {}, [
        field('schedule.start', 'Start on', startInput),
        field('schedule.end', 'Finish by', endInput),
      ]),
      paceNote,
    ]),
    el('fieldset.plan-block', {}, [
      el('legend.field__label', { text: 'What actually happened' }),
      el('div.field-row', {}, [
        field('actual.startedAt', 'Started on', startedInput),
        field('actual.finishedAt', 'Finished on', finishedInput),
      ]),
      field('progress.page', 'Currently on page', progressInput,
        'Set this directly when you just want to record where you are.'),
      el('p.field__hint', {}, 'Marking a book finished fills the finish date in for you.'),
      isEdit
        ? el('div.details-row', {}, [
            el('button.btn.btn--danger.btn--sm', {
              type: 'button',
              onClick: () => {
                startedInput.value = '';
                finishedInput.value = '';
                progressInput.value = '';
                draft.rating = draft.rating;
                toast('Cleared. Save to keep it.');
              },
            }, 'Clear what actually happened'),
            draft.sessions.length
              ? el('button.btn.btn--danger.btn--sm', {
                  type: 'button',
                  onClick: () => {
                    if (!confirm(`Delete all ${draft.sessions.length} logged sittings for ${draft.title}?`)) return;
                    updateBook(draft.id, { sessions: [] });
                    draft.sessions = [];
                    toast('Reading log cleared.');
                    modal.close();
                    openBookForm({ book: getBook(draft.id), onSaved });
                  },
                }, `Delete the reading log (${draft.sessions.length})`)
              : null,
          ].filter(Boolean))
        : null,
    ]),
    el('fieldset.plan-block', {}, [
      el('legend.field__label', { text: 'Shelves and notes' }),
      field('shelves', 'Shelves', shelvesInput, 'Comma separated'),
      shelfList,
      el('div.field', {}, [
        el('label.field__label', { for: 'f-notes', text: 'Notes' }),
        notesInput,
      ]),
      quotesBlock.node,
    ]),
    el('fieldset.plan-block', {}, [
      el('legend.field__label', { text: 'Rating and review' }),
      ratingControl,
      el('div.field', {}, [
        el('label.field__label', { for: 'f-review', text: 'Review' }),
        reviewInput,
      ]),
    ]),
    isEdit
      ? el('fieldset.plan-block.plan-block--log', {}, [
          el('legend.field__label', { text: 'Reading log' }),
          sessionLog({ bookId: draft.id }),
        ])
      : null,
  ].filter(Boolean);

  function showErrors(errors) {
    for (const [name, entry] of Object.entries(fields)) {
      const message = errors[name];
      const slot = $(`#err-${name}`, entry.wrap);
      if (slot) {
        slot.textContent = message ?? '';
        slot.hidden = !message;
      }
      entry.control.setAttribute('aria-invalid', message ? 'true' : 'false');
    }
    const firstBad = Object.keys(errors)[0];
    fields[firstBad]?.control.focus();
  }

  function collect() {
    return {
      ...draft,
      title: titleInput.value,
      author: authorInput.value,
      isbn: isbnInput.value,
      pageCount: pagesInput.value,
      genre: genreInput.value,
      format: formatSelect.value,
      status: statusSelect.value,
      cover: draft.cover,
      description: descriptionInput.value,
      series: {
        name: seriesNameInput.value,
        number: seriesNumberInput.value,
        total: seriesTotalInput.value,
      },
      shelves: shelvesInput.value.split(',').map((shelf) => shelf.trim()).filter(Boolean),
      notes: notesInput.value,
      review: reviewInput.value,
      rating: draft.rating,
      quotes: quotesBlock.read(),
      schedule: { start: startInput.value || null, end: endInput.value || null },
      actual: {
        startedAt: startedInput.value || null,
        finishedAt: finishedInput.value || null,
      },
      progress: { page: progressInput.value === '' ? 0 : progressInput.value, percent: 0 },
    };
  }

  function save() {
    const payload = collect();
    const result = isEdit ? updateBook(draft.id, payload) : addBook(payload);

    if (!result.ok) {
      showErrors(result.errors);
      toast('Check the highlighted fields.', { variant: 'error' });
      return;
    }
    modal.close();
    toast(isEdit ? 'Changes saved.' : `${result.book.title} added to the library.`);
    onSaved?.(result.book);
  }

  function confirmRemove() {
    const removed = removeBook(draft.id);
    if (!removed.ok) return;
    modal.close();
    toast(`${removed.book.title} removed.`);
    // Undo lives in the toast rail for as long as the toast does.
    const rail = document.querySelector('.toast-rail .toast:last-child');
    rail?.append(
      el('button.btn.btn--sm.btn--danger', {
        style: { pointerEvents: 'auto', marginLeft: '8px' },
        onClick: () => {
          restoreBook(removed.book);
          toast('Put back on the shelf.');
        },
        text: 'Undo',
      })
    );
  }

  const modal = showModal({
    eyebrow: isEdit ? 'Catalogue record' : 'New acquisition',
    title: isEdit ? draft.title || 'Untitled' : 'Add a book',
    body,
    secondaryAction:
      isEdit &&
      el('button.btn.btn--danger', { type: 'button', onClick: confirmRemove }, 'Remove'),
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn--stamp', { type: 'button', onClick: save }, isEdit ? 'Save changes' : 'Add book'),
    ],
  });

  // Enter submits from any single-line input, as people expect from a form.
  modal.panel.addEventListener('keydown', (event) => {
    // The session log handles its own Enter key; don't save the whole book
    // because someone finished typing a page number.
    if (event.target.closest('.session-log')) return;
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
      event.preventDefault();
      save();
    }
  });

  return modal;
}

/**
 * The derived picture, at the top of the record: how far in, how fast, and
 * where that lands. Everything here is computed from the log rather than
 * entered, so there is nothing to edit and no field to keep in sync.
 */
function progressStrip(book) {
  const report = progressReport(book);
  if (!report.ok || (!report.done && !report.sittings)) return null;

  const unitWord = report.unit === 'minutes' ? 'minutes' : 'pages';

  return el('div.progress-strip', {}, [
    el('div.progress-strip__head', {}, [
      el('span.progress-strip__percent', {}, `${report.percent}%`),
      el('span.progress-strip__where', {}, `${report.done} of ${report.total} ${unitWord}`),
      report.remaining
        ? el('span.progress-strip__left', {}, `${report.remaining} to go`)
        : null,
    ].filter(Boolean)),
    el(
      'div.progress',
      {
        role: 'progressbar',
        'aria-valuenow': String(report.percent),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-label': 'Progress through this book',
      },
      el('span.progress__fill', { style: { width: `${report.percent}%` } })
    ),
    el('dl.progress-strip__facts', {}, [
      report.rateLabel
        ? miniFact('Average so far', report.rateLabel, '', report.rateBasis)
        : null,
      report.needed
        ? miniFact(
            'Needed from here',
            report.needed.overdue
              ? `${report.needed.perDay} ${unitWord} — the date has passed`
              : `${report.needed.perDay} ${unitWord} a day`,
            report.needed.overdue ? 'is-late' : '',
            report.needed.overdue ? null : `over ${report.needed.days} days left`
          )
        : null,
      report.timeLeft ? miniFact('Time left', report.timeLeft) : null,
      report.projected ? miniFact('Finishing', formatShort(report.projected)) : null,
      report.verdict
        ? miniFact('Against plan', report.verdict.text, `is-${report.verdict.tone}`)
        : null,
    ].filter(Boolean)),
    report.projectionNote ? el('p.progress-strip__note', {}, report.projectionNote) : null,
    catchUpRow(book),
  ].filter(Boolean));
}

/** Offered only when the plan has actually slipped. */
function catchUpRow(book) {
  const preview = catchUpPreview(book);
  if (!preview.ok || preview.behind > -5) return null;

  return el('div.progress-strip__catchup', {}, [
    el('p', {}, preview.needsExtension
      ? `The finish date has passed with ${preview.remaining} ${preview.unit} left.`
      : `Behind by ${Math.abs(preview.behind)} ${preview.unit}. Spreading what's left over the ${preview.days} days remaining is ${preview.perDay} a day.`),
    el('button.btn.btn--stamp.btn--sm', {
      type: 'button',
      onClick: () => {
        updateBook(book.id, catchUpPatch(book));
        toast(`Replanned: ${preview.perDay} ${preview.unit} a day through ${preview.to}.`);
      },
    }, 'Catch me up'),
  ]);
}

const miniFact = (label, value, tone = '', note = null) =>
  el('div.progress-strip__fact', {}, [
    el('dt', {}, label),
    el('dd', { class: tone }, value),
    note ? el('dd.progress-strip__basis', {}, note) : null,
  ].filter(Boolean));

/* --- Rating ---------------------------------------------------------------
 * Radio buttons rather than clickable glyphs: a star widget that isn't a real
 * form control is unreachable by keyboard and invisible to a screen reader.
 * -------------------------------------------------------------------------- */

function starRating(current, onChange) {
  const name = `rating-${Math.random().toString(36).slice(2, 7)}`;
  let value = current ?? null;

  const stars = [1, 2, 3, 4, 5].map((score) =>
    el('label.star', { class: value >= score ? 'is-on' : '' }, [
      el('input', {
        type: 'radio', name, value: String(score),
        checked: value === score,
        class: 'visually-hidden',
        'aria-label': `${score} star${score === 1 ? '' : 's'}`,
        onChange: () => {
          value = score;
          onChange(score);
          paint();
        },
      }),
      el('span', { 'aria-hidden': 'true' }, '\u2605'),
    ])
  );

  const clear = el('button.btn.btn--danger.btn--sm', {
    type: 'button',
    onClick: () => {
      value = null;
      onChange(null);
      for (const star of stars) star.querySelector('input').checked = false;
      paint();
    },
  }, 'Clear');

  function paint() {
    stars.forEach((star, index) => star.classList.toggle('is-on', value != null && value >= index + 1));
    clear.hidden = value == null;
  }

  paint();

  return el('div.field', {}, [
    el('span.field__label', {}, 'Rating'),
    el('div.star-rating', { role: 'radiogroup', 'aria-label': 'Rating' }, [...stars, clear]),
  ]);
}

/* --- Quotes ---------------------------------------------------------------- */

function quotesEditor(draft) {
  let quotes = [...(draft.quotes ?? [])];
  const list = el('ul.quote-list');

  const textInput = el('textarea.textarea', {
    rows: '2', placeholder: 'Type or paste a passage worth keeping.',
    'aria-label': 'Quote',
  });
  const pageInput = el('input.input.quote-page', {
    type: 'number', min: '0', placeholder: 'page', 'aria-label': 'Page number',
  });

  const paint = () => {
    fill(list, quotes.length
      ? quotes.map((quote) =>
          el('li.quote', {}, [
            el('blockquote', {}, quote.text),
            el('div.quote__foot', {}, [
              quote.page != null ? el('cite', {}, `page ${quote.page}`) : null,
              el('button.icon-btn', {
                type: 'button', 'aria-label': 'Delete this quote',
                onClick: () => {
                  quotes = quotes.filter((entry) => entry.id !== quote.id);
                  paint();
                },
                text: '\u00d7',
              }),
            ].filter(Boolean)),
          ])
        )
      : [el('li.quote-empty', {}, 'No quotes saved yet.')]);
  };

  const add = () => {
    const text = textInput.value.trim();
    if (!text) return;
    const page = Number.parseInt(pageInput.value, 10);
    quotes.push({
      id: `qt_${Date.now().toString(36)}`,
      text,
      page: Number.isFinite(page) ? page : null,
      createdAt: new Date().toISOString(),
    });
    textInput.value = '';
    pageInput.value = '';
    paint();
  };

  paint();

  return {
    node: el('div.field', {}, [
      el('span.field__label', {}, 'Quotes'),
      list,
      el('div.quote-form', {}, [
        textInput,
        el('div.quote-form__foot', {}, [
          pageInput,
          el('button.btn.btn--quiet.btn--sm', { type: 'button', onClick: add }, 'Add quote'),
        ]),
      ]),
    ]),
    read: () => quotes,
  };
}
