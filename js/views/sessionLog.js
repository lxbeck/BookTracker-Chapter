/**
 * Reading session log.
 *
 * One component, two homes: the book record (the full history) and the day
 * popup (log a sitting for the day you're looking at). The difference is a
 * fixed date and a shorter list, not different code.
 *
 * The form stays open after saving. Logging is repetitive by nature — you sit
 * down on Sunday and enter three days you forgot about — and a form that
 * closes after each entry turns that into three round trips.
 */

import { el, fill, toast } from '../lib/dom.js';
import { addSession, updateSession, removeSession, getBook } from '../data/store.js';
import { FORMATS } from '../data/schema.js';
import { formatShort, today } from '../lib/dates.js';
import { bookTotals, formatDuration } from '../logic/sessions.js';
import { sessionPages } from '../data/schema.js';

/**
 * @param {Object} config
 * @param {string} config.bookId
 * @param {string} [config.fixedDate] - lock new entries to this day
 * @param {boolean} [config.compact] - popup mode: fewer rows, no history header
 * @param {() => void} [config.onChange]
 */
export function sessionLog({ bookId, fixedDate = null, compact = false, onChange }) {
  const root = el('div.session-log', { class: compact ? 'session-log--compact' : '' });

  const draw = () => {
    const book = getBook(bookId);
    if (!book) return;
    fill(root, [
      compact ? null : totalsLine(book),
      entryForm(book, fixedDate, () => {
        draw();
        onChange?.();
      }),
      historyList(book, compact, () => {
        draw();
        onChange?.();
      }),
    ].filter(Boolean));
  };

  draw();
  return root;
}

/* --- Totals --------------------------------------------------------------- */

function totalsLine(book) {
  const totals = bookTotals(book);
  if (!totals.sessions) return null;
  const unit = FORMATS[book.format].unit;

  return el('dl.session-totals', {}, [
    stat('Sittings', String(totals.sessions)),
    stat('Time', formatDuration(totals.minutes)),
    totals.pages ? stat(unit === 'minutes' ? 'Logged' : 'Pages', String(totals.pages)) : null,
    stat('Days read', String(totals.days)),
  ].filter(Boolean));
}

const stat = (label, value) =>
  el('div.session-totals__item', {}, [el('dt', {}, label), el('dd', {}, value)]);

/* --- Entry form ----------------------------------------------------------- */

function entryForm(book, fixedDate, onSaved) {
  const unit = FORMATS[book.format].unit;
  const isAudio = unit === 'minutes';

  const dateInput = el('input.input', {
    type: 'date',
    value: fixedDate ?? today(),
    'aria-label': 'Date read',
    disabled: Boolean(fixedDate),
  });

  const minutesInput = el('input.input', {
    type: 'number',
    min: '1',
    placeholder: '45',
    'aria-label': 'Minutes read',
  });

  const fromInput = el('input.input', {
    type: 'number',
    min: '0',
    // Picking up where the last session left off is the common case.
    value: book.progress.page || '',
    placeholder: 'from',
    'aria-label': isAudio ? 'Started at minute' : 'Started at page',
  });

  const toInput = el('input.input', {
    type: 'number',
    min: '0',
    placeholder: 'to',
    'aria-label': isAudio ? 'Reached minute' : 'Reached page',
  });

  const error = el('p.field__error', { hidden: true });

  const save = () => {
    const result = addSession(book.id, {
      date: dateInput.value,
      minutes: minutesInput.value,
      pageFrom: fromInput.value,
      pageTo: toInput.value,
    });

    if (!result.ok) {
      error.textContent = Object.values(result.errors)[0];
      error.hidden = false;
      return;
    }

    error.hidden = true;
    const covered = sessionPages(result.session);
    toast(
      `Logged ${formatDuration(result.session.minutes ?? 0)}${covered ? ` and ${covered} ${unit}` : ''}.`
    );
    minutesInput.value = '';
    toInput.value = '';
    onSaved();
  };

  const form = el('div.session-form', {}, [
    el('div.session-form__row', {}, [
      labelled('Date', dateInput),
      labelled('Minutes', minutesInput),
      labelled(isAudio ? 'From minute' : 'From page', fromInput),
      labelled(isAudio ? 'To minute' : 'To page', toInput),
    ]),
    el('div.session-form__actions', {}, [
      error,
      el('button.btn.btn--stamp.btn--sm', { type: 'button', onClick: save }, 'Log it'),
    ]),
  ]);

  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  });

  return form;
}

const labelled = (label, control) =>
  el('label.session-form__field', {}, [el('span', {}, label), control]);

/* --- History -------------------------------------------------------------- */

function historyList(book, compact, onChange) {
  const sessions = [...book.sessions].reverse();
  if (!sessions.length) {
    return el('p.session-empty', {}, 'No sittings logged for this book yet.');
  }

  const shown = compact ? sessions.slice(0, 3) : sessions;
  const unit = FORMATS[book.format].unit;

  return el('ul.session-list', {}, [
    ...shown.map((session) => sessionRow(book, session, unit, onChange)),
    compact && sessions.length > shown.length
      ? el('li.session-list__more', {}, `${sessions.length - shown.length} earlier sittings`)
      : null,
  ].filter(Boolean));
}

function sessionRow(book, session, unit, onChange) {
  const covered = sessionPages(session);
  const parts = [
    session.minutes ? formatDuration(session.minutes) : null,
    covered ? `${covered} ${unit}` : null,
    session.pageTo != null ? `to ${unit === 'minutes' ? '' : 'page '}${session.pageTo}`.trim() : null,
  ].filter(Boolean);

  return el('li.session-row', {}, [
    el('span.session-row__date', {}, formatShort(session.date)),
    el('span.session-row__detail', {}, parts.join(' \u00b7 ') || 'Logged'),
    el('button.icon-btn.session-row__remove', {
      type: 'button',
      'aria-label': `Delete the ${formatShort(session.date)} session`,
      onClick: () => {
        removeSession(book.id, session.id);
        toast('Session deleted.');
        onChange();
      },
      text: '\u00d7',
    }),
  ]);
}

export { updateSession };
