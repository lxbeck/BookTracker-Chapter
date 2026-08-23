/**
 * One book, on one day.
 *
 * Shared by the day popup and the full Day view. They differ only in how much
 * room they have, which is a `size` argument rather than two implementations
 * that drift apart.
 */

import { el, toast } from '../lib/dom.js';
import { showModal } from './modal.js';
import { coverThumb } from './cover.js';
import { sessionLog } from './sessionLog.js';
import { paceFor, paceStanding, projectedFinish } from '../logic/pacing.js';
import { observedPace, bookTotals, formatDuration } from '../logic/sessions.js';
import { formatShort, formatLong, addDays, spanLength, isValidKey } from '../lib/dates.js';
import { formatUnit, STATUSES } from '../data/schema.js';
import { setStatus, rescheduleBook } from '../data/store.js';
import { openBookForm } from './bookForm.js';

/**
 * @param {{book: object, state: string}} entry
 * @param {string} dayKey
 * @param {string} todayKey
 * @param {Object} options
 * @param {() => void} options.redraw
 * @param {() => void} [options.beforeOpenRecord] - close the popup, etc.
 * @param {'compact'|'large'} [options.size]
 */
export function dayRow({ book, state }, dayKey, todayKey, { redraw, beforeOpenRecord, size = 'compact' }) {
  const large = size === 'large';
  const pace = paceFor(book, dayKey, todayKey);
  const unit = formatUnit(book);
  const noun = unit === 'minutes' ? 'minutes' : 'pages';

  const lead =
    state === 'finished'
      ? 'Finished on this day'
      : !pace.ok
        ? pace.reason
        : !pace.inPlan
          ? 'Outside this book\u2019s plan'
          : `${pace.todayTarget} ${noun} ${
              dayKey < todayKey ? 'were due' : dayKey === todayKey ? 'to read today' : 'due that day'
            }`;

  return el('article.day-row', { class: large ? 'day-row--large' : '' }, [
    coverThumb(book, { width: large ? '150px' : '76px', alt: '', fit: 'whole' }),

    el('div.day-row__body', {}, [
      el('header.day-row__head', {}, [
        el('div', {}, [
          el('h3.day-row__title', {}, book.title),
          el('p.day-row__author', {}, [
            book.author || 'Unknown author',
            book.series.name
              ? el('span.day-row__series', {},
                  ` \u00b7 ${book.series.name}${book.series.number ? ` #${book.series.number}` : ''}`)
              : null,
          ].filter(Boolean)),
        ]),
        el('span', { class: `chip chip--${book.status}` }, STATUSES[book.status].label),
      ]),

      el('p.day-row__lead', { class: `is-${state}` }, lead),

      large && book.description
        ? el('p.day-row__description', {}, book.description)
        : null,

      pace.ok
        ? el('dl.day-row__facts', {}, [
            fact('Plan', `${formatShort(book.schedule.start)} \u2013 ${formatShort(book.schedule.end ?? book.schedule.start)} (${pace.days} days)`),
            fact('Day', `${Math.min(Math.max(pace.dayIndex, 1), pace.days)} of ${pace.days}`),
            fact('Target by tonight', `${unit === 'minutes' ? '' : 'page '}${pace.cumulative} of ${pace.total}`.trim()),
            book.progress.page ? fact('Currently at', `${unit === 'minutes' ? '' : 'page '}${book.progress.page}`.trim()) : null,
            observedRow(book, todayKey, unit),
            projectedFinish(book, todayKey)
              ? fact('On current pace', `finishes ${formatShort(projectedFinish(book, todayKey))}`)
              : null,
          ].filter(Boolean))
        : null,

      standingLine(book, todayKey),

      el('details.day-row__log', { open: large || state === 'reading' }, [
        el('summary', {}, logSummary(book, dayKey, unit)),
        sessionLog({ bookId: book.id, fixedDate: dayKey, compact: !large, onChange: redraw }),
      ]),

      el('div.day-row__actions', {}, [
        book.status !== 'finished'
          ? el('button.btn.btn--quiet.btn--sm', {
              type: 'button',
              onClick: () => {
                setStatus(book.id, 'finished');
                toast(`${book.title} marked finished.`);
                redraw();
              },
            }, 'Mark finished')
          : null,
        el('button.btn.btn--quiet.btn--sm', {
          type: 'button',
          onClick: () => openMovePlan(book, { onDone: redraw }),
        }, 'Move plan\u2026'),
        el('button.btn.btn--quiet.btn--sm', {
          type: 'button',
          onClick: () => {
            beforeOpenRecord?.();
            openBookForm({ book });
          },
        }, 'Open record'),
      ].filter(Boolean)),
    ]),
  ]);
}

/**
 * Move a whole plan to another day, keeping its length.
 *
 * Dragging a cover across the calendar does this on a desktop, and did it
 * nowhere else: HTML5 drag-and-drop does not fire for touch at all, so on a
 * phone there was no way to move a book to another day short of editing both
 * dates by hand in the record. This is the same operation with buttons on it,
 * which also makes it reachable from the keyboard and from a screen reader.
 *
 * @param {object} book
 * @param {{onDone?: () => void}} [options]
 */
export function openMovePlan(book, { onDone } = {}) {
  const start = book.schedule.start;
  const end = book.schedule.end;
  const days = start ? spanLength(start, end ?? start) : 1;

  const field = el('input.input', {
    type: 'date',
    id: 'move-plan-start',
    value: start ?? '',
  });

  const note = el('p.field__hint', { 'aria-live': 'polite' });

  const refresh = () => {
    const value = field.value;
    if (!isValidKey(value)) {
      note.textContent = 'Pick a day to start on.';
      return;
    }
    note.textContent = end && start
      ? `${formatLong(value)} \u2013 ${formatLong(addDays(value, days - 1))} \u00b7 ${days} day${days === 1 ? '' : 's'}, the same length as now.`
      : `Starts ${formatLong(value)}. This book has no finish date, so only the start moves.`;
  };

  const shift = (delta) => {
    const from = isValidKey(field.value) ? field.value : start;
    if (!from) return;
    field.value = addDays(from, delta);
    refresh();
  };

  field.addEventListener('change', refresh);
  field.addEventListener('input', refresh);
  refresh();

  const modal = showModal({
    eyebrow: 'Reading plan',
    title: `Move ${book.title}`,
    body: [
      el('div.field', {}, [
        el('label.field__label', { for: 'move-plan-start' }, 'Start on'),
        field,
        note,
      ]),
      // The common moves are a day and a week either way. Typing a date to
      // push a book back one evening is more work than the move deserves.
      el('div.move-plan__steps', {}, [
        stepButton('\u2212 1 week', () => shift(-7)),
        stepButton('\u2212 1 day', () => shift(-1)),
        stepButton('+ 1 day', () => shift(1)),
        stepButton('+ 1 week', () => shift(7)),
      ]),
    ],
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn--stamp', {
        type: 'button',
        onClick: () => {
          if (!isValidKey(field.value)) {
            toast('Pick a day to start on.', { variant: 'error' });
            return;
          }
          const result = rescheduleBook(book.id, field.value);
          if (!result.ok) {
            toast('That book could not be moved.', { variant: 'error' });
            return;
          }
          modal.close();
          toast(`${book.title} moved to ${formatShort(result.book.schedule.start)}.`);
          onDone?.();
        },
      }, 'Move it'),
    ],
  });

  return modal;
}

const stepButton = (label, onClick) =>
  el('button.btn.btn--quiet.btn--sm', { type: 'button', onClick }, label);

const fact = (label, value) =>
  el('div.day-row__fact', {}, [el('dt', {}, label), el('dd', {}, value)]);

function observedRow(book, todayKey, unit) {
  const pace = observedPace(book, todayKey);
  if (!pace.ok) return null;
  const totals = bookTotals(book);
  const noun = unit === 'minutes' ? 'minutes' : 'pages';

  if (pace.source === 'sessions' && totals.minutes) {
    return fact(
      'Reading at',
      `${Math.round(pace.pagesPerDay)} ${noun}/day \u00b7 ${formatDuration(pace.minutesPerDay)}/day`
    );
  }
  return fact('Reading at', `${Math.round(pace.pagesPerDay)} ${noun} a day`);
}

function standingLine(book, todayKey) {
  const state = paceStanding(book, todayKey);
  if (!state) return null;
  return el('p.day-row__standing', { class: `is-${state.tone}` }, state.text);
}

/** What the log fold says before you open it. */
function logSummary(book, dayKey, unit) {
  const onThisDay = (book.sessions ?? []).filter((session) => session.date === dayKey);
  if (!onThisDay.length) return 'Log a sitting for this day';

  const minutes = onThisDay.reduce((sum, session) => sum + (session.minutes ?? 0), 0);
  const furthest = onThisDay.reduce((max, session) => Math.max(max, session.pageTo ?? 0), 0);
  return [
    `${onThisDay.length} sitting${onThisDay.length === 1 ? '' : 's'}`,
    minutes ? formatDuration(minutes) : null,
    furthest ? `to ${unit === 'minutes' ? '' : 'page '}${furthest}`.trim() : null,
  ].filter(Boolean).join(' \u00b7 ');
}
