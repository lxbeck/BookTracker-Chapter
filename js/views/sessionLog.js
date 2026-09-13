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
import { FORMATS, formatUnit, hasFormat, parseHms, formatHms } from '../data/schema.js';
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

  // Which sitting, if any, has its editor open. Held here rather than on the
  // book: it's purely which row is expanded, and a redraw — which happens
  // constantly, on every store change — must not close it out from under
  // someone mid-correction.
  let editingId = null;

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
      }, editingId, (id) => {
        editingId = id;
        draw();
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

function entryForm(book, fixedDate, onSaved, { session = null, onCancel = null } = {}) {
  const unit = formatUnit(book);
  const isAudio = unit === 'minutes';

  // A position in a recording is a timestamp, and typing one should not mean
  // working out that 4:12:30 is minute 253. Offered whenever there is a
  // running time to measure against — including a paperback you also own on
  // audio, where the sitting still has to land on a page in the end.
  const canTime = hasFormat(book, 'audio') && book.audioSeconds > 0;

  const dateInput = el('input.input', {
    type: 'date',
    value: session?.date ?? fixedDate ?? today(),
    'aria-label': 'Date read',
    disabled: Boolean(fixedDate),
  });

  // Optional, and labelled as such. Often you know you got to page 200 and
  // have no idea whether that took forty minutes or ninety; refusing the entry
  // over a number nobody recorded would just stop people logging.
  const minutesInput = el('input.input', {
    type: 'number',
    min: '1',
    value: session?.minutes ?? '',
    placeholder: 'optional',
    'aria-label': hasFormat(book, 'audio')
      ? 'Minutes spent listening, optional'
      : 'Minutes read, optional',
  });

  const fromInput = el('input.input', {
    type: 'number',
    min: '0',
    step: 'any',
    // Picking up where the last session left off is the common case; editing
    // an existing sitting starts from what it already says instead.
    value: session ? (session.pageFrom ?? '') : (book.progress.page || ''),
    placeholder: 'from',
    'aria-label': isAudio ? 'Started from minute' : 'Started from page',
  });

  const toInput = el('input.input.session-form__primary', {
    type: 'number',
    min: '0',
    step: 'any',
    max: book.pageCount ? String(book.pageCount) : null,
    value: session?.pageTo ?? '',
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
      // Convert through the page number rather than between display units, so
      // switching page -> % -> time and back cannot drift.
      const held = [fromInput, toInput].map((field) => pageIn(field, previousUnit));
      previousUnit = unitSelect.value;
      applyUnitChrome();

      held.forEach((page, index) => {
        const field = [fromInput, toInput][index];
        field.value = page == null ? '' : displayFor(page);
      });
      refreshPreview();
    },
  }, [
    el('option', { value: 'page' }, isAudio ? 'min' : 'page'),
    el('option', { value: 'percent' }, '%'),
    canTime ? el('option', { value: 'time' }, 'time') : null,
  ]);

  let previousUnit = 'page';

  /** Swap the boxes between a number and a timestamp as the mode changes. */
  function applyUnitChrome() {
    const total = book.pageCount;
    const mode = unitSelect.value;

    for (const field of [fromInput, toInput]) {
      // A timestamp is not a number, and a number input drops the colons
      // without a word rather than refusing them.
      field.type = mode === 'time' ? 'text' : 'number';
      field.max = mode === 'percent' ? '100' : mode === 'page' ? String(total ?? '') : null;
    }

    fromInput.placeholder =
      mode === 'percent' ? 'from %' : mode === 'time' ? '0:00:00' : 'from';
    toInput.placeholder =
      mode === 'percent' ? '40' : mode === 'time' ? formatHms(book.audioSeconds) : String(total ?? 'page');
  }

  /** A page number rendered in whichever unit is on show. */
  function displayFor(page) {
    const total = book.pageCount;
    if (unitSelect.value === 'percent') return total ? Math.round((page / total) * 100) : '';
    if (unitSelect.value === 'time') {
      return total ? formatHms(Math.round((page / total) * book.audioSeconds)) : '';
    }
    return page;
  }

  /** What a field holds, read as the given unit, expressed as a page number. */
  function pageIn(field, mode) {
    const total = book.pageCount;
    if (mode === 'time') {
      const seconds = parseHms(field.value);
      return seconds && book.audioSeconds
        ? Math.round((seconds / book.audioSeconds) * total)
        : null;
    }
    const value = Number.parseFloat(field.value);
    if (!Number.isFinite(value)) return null;
    if (mode === 'percent' && total) {
      return Math.round((Math.min(Math.max(value, 0), 100) / 100) * total);
    }
    return Math.round(value);
  }

  /** A typed value in whichever unit is selected, expressed as a page number. */
  const asPage = (field) => pageIn(field, unitSelect.value);

  const endingPage = () => asPage(toInput);
  const startingPage = () => asPage(fromInput);

  // A running read-out of what this entry will mean, so nobody has to work out
  // 79 of 440 in their head to check they typed the right number.
  const preview = el('p.session-form__preview');
  const speedNote = el('p.session-form__speed');

  const refreshPreview = () => {
    const to = endingPage();
    if (!Number.isFinite(to) || !book.pageCount) {
      preview.textContent = '';
      return;
    }
    const percent = Math.round((Math.min(to, book.pageCount) / book.pageCount) * 100);
    const from = startingPage();
    const covered = Number.isFinite(from) && to > from ? to - from : null;

    // In timestamp mode the numbers people typed were timestamps, so the
    // read-out echoes timestamps back. Answering "4:12:30" with "253 of 586"
    // makes you do the conversion twice over.
    const asTime = unitSelect.value === 'time';
    const stamp = (page) => formatHms(Math.round((page / book.pageCount) * book.audioSeconds));

    preview.textContent =
      `${percent}% \u00b7 ${asTime ? stamp(to) : to} of ${asTime ? formatHms(book.audioSeconds) : `${book.pageCount} ${unit}`}`
      + (covered ? ` \u00b7 ${asTime ? stamp(covered) : `${covered} ${unit}`} this sitting` : '');

    speedNote.textContent = observedSpeed(covered);
  };

  /**
   * What speed this sitting was actually played at.
   *
   * Recording time and clock time are different quantities, and treating them
   * as one is how a log ends up claiming 266 minutes in an hour. Given both,
   * their ratio is the only honest thing to say — and it is the number someone
   * listening at 1.5x wants to see confirmed.
   */
  function observedSpeed(coveredPages) {
    const spent = Number.parseFloat(minutesInput.value);
    if (!book.audioSeconds || !coveredPages || !Number.isFinite(spent) || spent <= 0) return '';

    const listened = (coveredPages / book.pageCount) * book.audioSeconds;
    const rate = listened / (spent * 60);
    // Outside this band the entry is a typo or a half-finished thought, and a
    // confident "0.1x" would be worse than saying nothing.
    if (rate < 0.5 || rate > 5) return '';

    return `${formatHms(listened)} of recording in ${spent} minute${spent === 1 ? '' : 's'} \u2014 about ${rate.toFixed(2).replace(/\.?0+$/, '')}\u00d7.`;
  }

  toInput.addEventListener('input', refreshPreview);
  fromInput.addEventListener('input', refreshPreview);
  minutesInput.addEventListener('input', refreshPreview);

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
  if (viaSelect && session) viaSelect.value = session.via ?? '';

  const save = () => {
    const payload = {
      date: dateInput.value,
      minutes: minutesInput.value,
      pageFrom: startingPage(),
      pageTo: endingPage(),
      via: viaSelect?.value || null,
    };
    const result = session
      ? updateSession(book.id, session.id, payload)
      : addSession(book.id, payload);

    if (!result.ok) {
      error.textContent = Object.values(result.errors)[0];
      error.hidden = false;
      return false;
    }

    error.hidden = true;

    if (session) {
      toast('Sitting updated.');
      onSaved();
      onCancel?.();
      return true;
    }

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
      labelled(hasFormat(book, 'audio') ? 'Time spent' : 'Minutes', minutesInput),
      viaSelect ? labelled('How', viaSelect) : null,
    ].filter(Boolean)),
    preview,
    speedNote,
    el('div.session-form__actions', {}, [
      session ? null : timerControl(book, minutesInput, refreshPreview),
      error,
      session
        ? el('button.btn.btn--quiet.btn--sm', { type: 'button', onClick: () => onCancel?.() }, 'Cancel')
        : null,
      el('button.btn.btn--stamp.btn--sm', { type: 'button', onClick: save }, session ? 'Save changes' : 'Log it'),
    ].filter(Boolean)),
  ]);

  // The preview and speed note are otherwise built lazily from typing; opened
  // for editing, the fields already hold values nobody just typed.
  if (session) refreshPreview();

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

function historyList(book, compact, onChange, editingId, setEditing) {
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
      ...shown.map((session) =>
        sessionRow(book, session, unit, onChange, session.id === editingId, setEditing)
      ),
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

function sessionRow(book, session, unit, onChange, isEditing, setEditing) {
  if (isEditing) {
    return el('li.session-row.session-row--editing', {}, [
      entryForm(book, null, () => {
        setEditing(null);
        onChange();
      }, {
        session,
        onCancel: () => setEditing(null),
      }),
    ]);
  }

  const span = session.pageFrom != null && session.pageTo != null
    // The endpoint alone ("to page 448") answers "how far are you now", not
    // "what did this sitting cover" \u2014 the second is what a correction needs
    // to see before changing anything, and what "from x to y" was asked for.
    ? `${unit === 'minutes' ? 'minute' : 'page'} ${session.pageFrom} to ${session.pageTo}`
    : session.pageTo != null
      ? `to ${unit === 'minutes' ? '' : 'page '}${session.pageTo}`.trim()
      : null;

  const parts = [
    session.minutes ? formatDuration(session.minutes) : null,
    span,
    // Only worth saying when the book has more than one form and this sitting
    // was one of them; "both" is the default and needs no label.
    session.via && book.formats.length > 1 ? FORMATS[session.via].label.toLowerCase() : null,
  ].filter(Boolean);

  return el('li.session-row', {}, [
    el('span.session-row__date', {}, formatShort(session.date)),
    el('span.session-row__detail', {}, parts.join(' \u00b7 ') || 'Logged'),
    el('button.icon-btn.session-row__edit', {
      type: 'button',
      'aria-label': `Edit the ${formatShort(session.date)} session`,
      onClick: () => setEditing(session.id),
      text: '\u270e',
    }),
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
