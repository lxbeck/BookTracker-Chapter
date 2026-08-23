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
import { FORMATS, formatUnit, hasFormat } from '../data/schema.js';
import { formatShort, today } from '../lib/dates.js';
import { bookTotals, formatDuration } from '../logic/sessions.js';
import { sessionPages } from '../data/schema.js';
import { confirmAction } from './modal.js';

/**
 * @param {Object} config
 * @param {string} config.bookId
 * @param {string} [config.fixedDate] - lock new entries to this day
 * @param {boolean} [config.compact] - popup mode: fewer rows, no history header
 * @param {() => void} [config.onChange]
 */
export function sessionLog({ bookId, fixedDate = null, compact = false, onChange }) {
  const root = el('div.session-log', { class: compact ? 'session-log--compact' : '' });

  /**
   * Commit anything typed but not yet logged.
   *
   * Filling the fields and then pressing the record's "Save changes" is the
   * obvious thing to do, and it used to throw the entry away — the log saves
   * through its own button, and Save knew nothing about a half-filled form.
   * The record calls this before saving so the work isn't silently lost.
   */
  root.commitPending = () => false;

  const draw = () => {
    const book = getBook(bookId);
    if (!book) return;

    const form = entryForm(book, fixedDate, () => {
      draw();
      onChange?.();
    });
    root.commitPending = form.commitPending;

    fill(root, [
      compact ? null : totalsLine(book),
      form,
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
  const unit = formatUnit(book);

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
  const unit = formatUnit(book);
  const isAudio = unit === 'minutes';

  const dateInput = el('input.input', {
    type: 'date',
    value: fixedDate ?? today(),
    'aria-label': 'Date read',
    disabled: Boolean(fixedDate),
  });

  // Optional, and labelled as such. Often you know you got to page 200 and
  // have no idea whether that took forty minutes or ninety; refusing the entry
  // over a number nobody recorded would just stop people logging.
  const minutesInput = el('input.input', {
    type: 'number',
    min: '1',
    placeholder: 'optional',
    'aria-label': 'Minutes read, optional',
  });

  const fromInput = el('input.input', {
    type: 'number',
    min: '0',
    step: 'any',
    // Picking up where the last session left off is the common case.
    value: book.progress.page || '',
    placeholder: 'from',
    'aria-label': isAudio ? 'Started from minute' : 'Started from page',
  });

  const toInput = el('input.input.session-form__primary', {
    type: 'number',
    min: '0',
    step: 'any',
    max: book.pageCount ? String(book.pageCount) : null,
    placeholder: book.pageCount ? String(book.pageCount) : 'page',
    'aria-label': isAudio ? 'Ended on minute' : 'Ended on page',
  });

  /**
   * One unit control for both ends of the session.
   *
   * Separate controls would let you say "from page 40 to 60%", which is
   * technically expressible and almost never what anyone means — and it makes
   * the read-out ambiguous. One switch flips both, and converts whatever is
   * already typed rather than reinterpreting it.
   */
  const unitSelect = el('select.select.progress-unit', {
    'aria-label': 'Positions measured in',
    disabled: !book.pageCount,
    title: book.pageCount ? '' : 'Add a page count to log by percentage',
    onChange: () => {
      const total = book.pageCount;
      const toPercent = unitSelect.value === 'percent';

      for (const field of [fromInput, toInput]) {
        const value = Number.parseFloat(field.value);
        if (Number.isFinite(value) && total > 0) {
          field.value = toPercent
            ? Math.round((value / total) * 100)
            : Math.round((value / 100) * total);
        }
        field.max = toPercent ? '100' : String(total ?? '');
      }

      fromInput.placeholder = toPercent ? 'from %' : 'from';
      toInput.placeholder = toPercent ? '40' : String(total ?? 'page');
      refreshPreview();
    },
  }, [
    el('option', { value: 'page' }, isAudio ? 'min' : 'page'),
    el('option', { value: 'percent' }, '%'),
  ]);

  /** A typed value in whichever unit is selected, expressed as a page number. */
  const asPage = (field) => {
    const value = Number.parseFloat(field.value);
    if (!Number.isFinite(value)) return null;
    if (unitSelect.value === 'percent' && book.pageCount) {
      return Math.round((Math.min(Math.max(value, 0), 100) / 100) * book.pageCount);
    }
    return Math.round(value);
  };

  const endingPage = () => asPage(toInput);
  const startingPage = () => asPage(fromInput);

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
    const from = startingPage();
    const covered = Number.isFinite(from) && to > from ? to - from : null;
    preview.textContent =
      `${percent}% \u00b7 ${to} of ${book.pageCount} ${unit}` +
      (covered ? ` \u00b7 ${covered} ${unit} this sitting` : '');
  };

  toInput.addEventListener('input', refreshPreview);
  fromInput.addEventListener('input', refreshPreview);

  const error = el('p.field__error', { hidden: true });

  /**
   * Which way this sitting happened.
   *
   * Only shown for a book that is more than one thing, because for every other
   * book the answer is already known and a control with one option is just
   * clutter. "Both" is a real answer and the reason the feature exists —
   * reading the page while the narrator reads it aloud is one sitting, not
   * two, and splitting it into two entries would double the time logged.
   */
  const viaSelect = book.formats.length > 1
    ? el('select.select', { 'aria-label': 'How you read this sitting' }, [
        el('option', { value: '' }, 'Both'),
        ...book.formats.map((id) => el('option', { value: id }, FORMATS[id].label)),
      ])
    : null;

  const save = () => {
    const result = addSession(book.id, {
      date: dateInput.value,
      minutes: minutesInput.value,
      pageFrom: startingPage(),
      pageTo: endingPage(),
      via: viaSelect?.value || null,
    });

    if (!result.ok) {
      error.textContent = Object.values(result.errors)[0];
      error.hidden = false;
      return false;
    }

    error.hidden = true;
    // The sitting this timer was measuring is now on the record.
    if (runningTimer()?.bookId === book.id) setTimer(null);
    const covered = sessionPages(result.session);
    toast(
      `Logged ${formatDuration(result.session.minutes ?? 0)}${covered ? ` and ${covered} ${unit}` : ''}.`
    );
    minutesInput.value = '';
    toInput.value = '';
    preview.textContent = '';
    onSaved();
    return true;
  };

  const form = el('div.session-form', {}, [
    el('div.session-form__row', {}, [
      labelled('Date', dateInput),
      labelled(isAudio ? 'Ended at' : 'Ended on', el('div.progress-entry', {}, [toInput, unitSelect])),
      labelled(isAudio ? 'Started at' : 'Started from', fromInput),
      labelled('Minutes', minutesInput),
      viaSelect ? labelled('How', viaSelect) : null,
    ].filter(Boolean)),
    preview,
    el('div.session-form__actions', {}, [
      timerControl(book, minutesInput, refreshPreview),
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

  /** True when there is something worth committing. */
  form.commitPending = () => {
    const hasEntry = minutesInput.value !== '' || toInput.value !== '';
    if (!hasEntry) return false;
    return save() !== false;
  };

  return form;
}

/* --- The timer -------------------------------------------------------------
   Logging after the fact means remembering a number nobody was watching for,
   and "about forty minutes?" is how a reading log becomes fiction. A timer
   turns the guess into a measurement.

   It lives in localStorage rather than in a variable, because the app
   re-renders on every store change and a reader closes the tab, answers the
   door, and comes back — a timer that only exists in a closure is a timer that
   loses the sitting it was there to record.
   -------------------------------------------------------------------------- */

const TIMER_KEY = 'chapter.timer.v1';

/** @returns {{bookId: string, startedAt: number}|null} */
function runningTimer() {
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.bookId && Number.isFinite(parsed.startedAt) ? parsed : null;
  } catch {
    return null;
  }
}

function setTimer(value) {
  try {
    if (value) localStorage.setItem(TIMER_KEY, JSON.stringify(value));
    else localStorage.removeItem(TIMER_KEY);
  } catch {
    /* a timer is not worth breaking the log over */
  }
}

/** Whole minutes elapsed, never less than one: a sitting happened. */
export const timerMinutes = (startedAt, now = Date.now()) =>
  Math.max(1, Math.round((now - startedAt) / 60000));

/**
 * Start / stop, and the running read-out between them.
 *
 * Stopping fills the minutes field rather than logging outright, because the
 * page you reached is the other half of the entry and only you know it.
 */
function timerControl(book, minutesInput, onTick) {
  const node = el('div.timer');

  const draw = () => {
    if (!node.isConnected && node.dataset.drawn) return;
    node.dataset.drawn = 'yes';

    const running = runningTimer();
    const mine = running?.bookId === book.id;

    if (mine) {
      const minutes = timerMinutes(running.startedAt);
      fill(node, [
        el('span.timer__dot', { 'aria-hidden': 'true' }),
        el('span.timer__reading', { 'aria-live': 'off' },
          `Reading \u00b7 ${formatDuration(minutes)}`),
        el('button.btn.btn--stamp.btn--sm', {
          type: 'button',
          onClick: () => {
            setTimer(null);
            minutesInput.value = String(minutes);
            minutesInput.dispatchEvent(new Event('input'));
            toast(`Timer stopped at ${formatDuration(minutes)}. Add the page you reached and log it.`);
            draw();
            onTick?.();
          },
        }, 'Stop'),
      ]);
      return;
    }

    fill(node, [
      el('button.btn.btn--quiet.btn--sm', {
        type: 'button',
        onClick: () => {
          setTimer({ bookId: book.id, startedAt: Date.now() });
          draw();
          onTick?.();
        },
      }, 'Start a timer'),
      running
        ? el('span.timer__elsewhere', {},
            'A timer is running on another book \u2014 open it to stop.')
        : null,
    ].filter(Boolean));
  };

  draw();

  // One interval per control, stopped when the control leaves the page. The
  // read-out is in whole minutes, so twice a minute is as often as it can
  // possibly need to change.
  const tick = setInterval(() => {
    if (!node.isConnected) {
      clearInterval(tick);
      return;
    }
    if (runningTimer()?.bookId === book.id) draw();
  }, 30000);

  return node;
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
  const unit = formatUnit(book);

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
          onClick: async () => {
            const sure = await confirmAction({
              title: `Delete the reading log for ${book.title}?`,
              body: `All ${book.sessions.length} logged sittings go. The book itself stays.`,
              confirmLabel: 'Delete the log',
            });
            if (!sure) return;
            const sessions = book.sessions;
            updateBook(book.id, { sessions: [] });
            toast('Reading log cleared.', {
              action: {
                label: 'Undo',
                onClick: () => {
                  updateBook(book.id, { sessions });
                  toast('Reading log restored.');
                  onChange();
                },
              },
            });
            onChange();
          },
        }, `Clear the log (${book.sessions.length})`)
      : null,
    hasRecord
      ? el('button.btn.btn--danger.btn--sm', {
          type: 'button',
          onClick: async () => {
            const sure = await confirmAction({
              title: `Reset what happened for ${book.title}?`,
              body: 'Progress and the start and finish dates are cleared. The plan and the reading log stay.',
              confirmLabel: 'Reset it',
            });
            if (!sure) return;
            const before = {
              actual: { ...book.actual },
              progress: { ...book.progress },
              status: book.status,
            };
            updateBook(book.id, {
              actual: { startedAt: null, finishedAt: null },
              progress: { page: 0, percent: 0 },
              status: book.status === 'finished' ? 'reading' : book.status,
            });
            toast('Progress and dates reset.', {
              action: {
                label: 'Undo',
                onClick: () => {
                  updateBook(book.id, before);
                  toast('Progress and dates put back.');
                  onChange();
                },
              },
            });
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
    // Only worth saying when the book has more than one form and this sitting
    // was one of them; "both" is the default and needs no label.
    session.via && book.formats.length > 1 ? FORMATS[session.via].label.toLowerCase() : null,
  ].filter(Boolean);

  return el('li.session-row', {}, [
    el('span.session-row__date', {}, formatShort(session.date)),
    el('span.session-row__detail', {}, parts.join(' \u00b7 ') || 'Logged'),
    el('button.icon-btn.session-row__remove', {
      type: 'button',
      'aria-label': `Delete the ${formatShort(session.date)} session`,
      onClick: () => {
        removeSession(book.id, session.id);
        // The sitting itself is the undo: putting the same record back is a
        // write of what we already have in hand.
        toast('Session deleted.', {
          action: {
            label: 'Undo',
            onClick: () => {
              const current = getBook(book.id);
              if (!current) return;
              updateBook(book.id, { sessions: [...current.sessions, session] });
              toast('Session restored.');
              onChange();
            },
          },
        });
        onChange();
      },
      text: '\u00d7',
    }),
  ]);
}

export { updateSession };
