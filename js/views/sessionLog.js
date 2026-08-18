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
 *
 * "Ended on page" leads, because that is the thing people actually know when
 * they put a book down. The starting page is filled in from where you already
 * were and can be ignored entirely.
 */

import { el, fill, toast } from '../lib/dom.js';
import { addSession, updateSession, removeSession, getBook, updateBook } from '../data/store.js';
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

  const toInput = el('input.input.session-form__primary', {
    type: 'number',
    min: '0',
    step: 'any',
    max: book.pageCount ? String(book.pageCount) : null,
    placeholder: book.pageCount ? String(book.pageCount) : 'page',
    'aria-label': isAudio ? 'Ended at minute' : 'Ended on page',
  });

  // Same choice as the record: say where you got to however you know it.
  const toUnit = el('select.select.progress-unit', {
    'aria-label': 'Ending position measured in',
    disabled: !book.pageCount,
    title: book.pageCount ? '' : 'Add a page count to log by percentage',
    onChange: () => {
      toInput.max = toUnit.value === 'percent' ? '100' : String(book.pageCount ?? '');
      toInput.placeholder = toUnit.value === 'percent' ? '18' : String(book.pageCount ?? 'page');
      refreshPreview();
    },
  }, [
    el('option', { value: 'page' }, isAudio ? 'min' : 'page'),
    el('option', { value: 'percent' }, '%'),
  ]);

  /** Whatever was typed, expressed as a page number. */
  const endingPage = () => {
    const value = Number.parseFloat(toInput.value);
    if (!Number.isFinite(value)) return null;
    if (toUnit.value === 'percent' && book.pageCount) {
      return Math.round((Math.min(value, 100) / 100) * book.pageCount);
    }
    return Math.round(value);
  };

  // A running read-out of what this entry will mean, so nobody has to work out
  // 79 of 440 in their head to check they typed the right number.
  const preview = el('p.session-form__preview');

  const refreshPreview = () => {
    const to = endingPage();
    if (!Number.isFinite(to) || !book.pageCount) {
      preview.textContent = '';
      return;
    }
    const percent = Math.round((Math.min(to, book.pageCount) / book.pageCount) * 100);
    const from = Number.parseInt(fromInput.value, 10);
    const covered = Number.isFinite(from) && to > from ? to - from : null;
    preview.textContent =
      `${percent}% \u00b7 ${to} of ${book.pageCount} ${unit}` +
      (covered ? ` \u00b7 ${covered} ${unit} this sitting` : '');
  };

  toInput.addEventListener('input', refreshPreview);
  fromInput.addEventListener('input', refreshPreview);

  const error = el('p.field__error', { hidden: true });

  const save = () => {
    const result = addSession(book.id, {
      date: dateInput.value,
      minutes: minutesInput.value,
      pageFrom: fromInput.value,
      pageTo: endingPage(),
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
    preview.textContent = '';
    onSaved();
  };

  const form = el('div.session-form', {}, [
    el('div.session-form__row', {}, [
      labelled('Date', dateInput),
      labelled(isAudio ? 'Ended at' : 'Ended on', el('div.progress-entry', {}, [toInput, toUnit])),
      labelled('Minutes read', minutesInput),
      labelled(isAudio ? 'Started at' : 'Started on page', fromInput),
    ]),
    preview,
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
    return el('div', {}, [
      el('p.session-empty', {}, 'No sittings logged for this book yet.'),
      correctionRow(book, onChange),
    ]);
  }

  const shown = compact ? sessions.slice(0, 3) : sessions;
  const unit = FORMATS[book.format].unit;

  return el('div', {}, [
    el('ul.session-list', {}, [
      ...shown.map((session) => sessionRow(book, session, unit, onChange)),
      compact && sessions.length > shown.length
        ? el('li.session-list__more', {}, `${sessions.length - shown.length} earlier sittings`)
        : null,
    ].filter(Boolean)),
    compact ? null : correctionRow(book, onChange),
  ].filter(Boolean));
}

/**
 * Undoing mistakes.
 *
 * Mis-typing a page number is easy and, until now, permanent-ish. Both of
 * these are destructive, so both say exactly what they will remove and ask
 * once — but they exist, because a tracker you can't correct stops being
 * trusted the first time it's wrong.
 */
function correctionRow(book, onChange) {
  const hasLog = book.sessions.length > 0;
  const hasRecord = Boolean(book.actual.startedAt || book.actual.finishedAt || book.progress.page);

  if (!hasLog && !hasRecord) return null;

  return el('div.session-corrections', {}, [
    hasLog
      ? el('button.btn.btn--danger.btn--sm', {
          type: 'button',
          onClick: () => {
            if (!confirm(`Delete all ${book.sessions.length} logged sittings for ${book.title}? The book itself stays.`)) return;
            updateBook(book.id, { sessions: [] });
            toast('Reading log cleared.');
            onChange();
          },
        }, `Clear the log (${book.sessions.length})`)
      : null,
    hasRecord
      ? el('button.btn.btn--danger.btn--sm', {
          type: 'button',
          onClick: () => {
            if (!confirm(`Reset progress and the start and finish dates for ${book.title}? The plan and the reading log stay.`)) return;
            updateBook(book.id, {
              actual: { startedAt: null, finishedAt: null },
              progress: { page: 0, percent: 0 },
              status: book.status === 'finished' ? 'reading' : book.status,
            });
            toast('Progress and dates reset.');
            onChange();
          },
        }, 'Reset progress and dates')
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
