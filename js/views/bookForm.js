/**
 * Add / edit book form.
 *
 * The form owns a draft copy of the book and only touches the store on save,
 * so cancelling is genuinely free and validation errors can be shown per field
 * without half-written records reaching the library.
 */

import { el, $, toast } from '../lib/dom.js';
import { showModal } from './modal.js';
import { coverPicker } from './coverPicker.js';
import { STATUSES, STATUS_ORDER, FORMATS, blankBook } from '../data/schema.js';
import { addBook, updateBook, removeBook, restoreBook } from '../data/store.js';

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
    },
  });

  const body = [
    el('div.field', {}, [
      el('span.field__label', { text: 'Cover' }),
      picker,
    ]),
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
    el('fieldset.plan-block', {}, [
      el('legend.field__label', { text: 'Reading plan' }),
      el('div.field-row', {}, [
        field('schedule.start', 'Start on', startInput),
        field('schedule.end', 'Finish by', endInput),
      ]),
      paceNote,
    ]),
  ];

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
      schedule: { start: startInput.value || null, end: endInput.value || null },
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
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
      event.preventDefault();
      save();
    }
  });

  return modal;
}
