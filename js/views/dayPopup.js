/**
 * Day popup.
 *
 * Clicking a day opens the full picture for it: every book scheduled or in
 * progress, what each asks of you that day, and the actions you'd actually
 * want at that moment — mark finished, log where you got to, open the record,
 * or schedule something new starting that day.
 *
 * Everything the hover card shows appears here too, deliberately. Hover is a
 * convenience for a mouse; this is the accessible path to the same facts.
 */

import { el, fill, toast } from '../lib/dom.js';
import { showModal } from './modal.js';
import { openBookForm } from './bookForm.js';
import { coverThumb } from './cover.js';
import { entriesForDay } from '../logic/schedule.js';
import { paceFor, paceStanding, projectedFinish } from '../logic/pacing.js';
import { DAY_STATE_LABEL } from '../logic/schedule.js';
import { formatLong, formatShort, relativeDay, today } from '../lib/dates.js';
import { FORMATS, STATUSES } from '../data/schema.js';
import { allBooks, setStatus } from '../data/store.js';
import { sessionLog } from './sessionLog.js';
import { observedPace, formatDuration, bookTotals } from '../logic/sessions.js';

/**
 * @param {string} dayKey
 * @param {{book: object, state: string}[]} [entries] - precomputed by the grid
 */
export function openDayPopup(dayKey, entries) {
  const todayKey = today();
  const list = entries ?? entriesForDay(allBooks(), dayKey, todayKey);

  const body = el('div.day-popup');

  const draw = () => {
    const current = entriesForDay(allBooks(), dayKey, todayKey);
    fill(body, current.length
      ? current.map((entry) => dayRow(entry, dayKey, todayKey, draw, modal))
      : [emptyDay(dayKey, modal)]);
  };

  const modal = showModal({
    eyebrow: relativeDay(dayKey, todayKey),
    title: formatLong(dayKey),
    body,
    wide: true,
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Close'),
      el(
        'button.btn.btn--stamp',
        {
          type: 'button',
          onClick: () => {
            modal.close();
            openBookForm({ defaultStart: dayKey });
          },
        },
        'Schedule a book here'
      ),
    ],
  });

  fill(body, list.length
    ? list.map((entry) => dayRow(entry, dayKey, todayKey, draw, modal))
    : [emptyDay(dayKey, modal)]);

  return modal;
}

/* --- Rows ----------------------------------------------------------------- */

function dayRow({ book, state }, dayKey, todayKey, redraw, modal) {
  const pace = paceFor(book, dayKey, todayKey);
  const unit = FORMATS[book.format].unit;
  const noun = unit === 'minutes' ? 'minutes' : 'pages';

  const lead =
    state === 'finished'
      ? 'Finished on this day'
      : !pace.ok
        ? pace.reason
        : !pace.inPlan
          ? 'Outside this book\u2019s plan'
          : `${pace.todayTarget} ${noun} ${dayKey < todayKey ? 'were due' : dayKey === todayKey ? 'to read today' : 'due that day'}`;

  return el('article.day-row', {}, [
    coverThumb(book, { width: '76px', alt: '', fit: 'whole' }),

    el('div.day-row__body', {}, [
      el('header.day-row__head', {}, [
        el('div', {}, [
          el('h3.day-row__title', {}, book.title),
          el('p.day-row__author', {}, book.author || 'Unknown author'),
        ]),
        el('span', { class: `chip chip--${book.status}` }, STATUSES[book.status].label),
      ]),

      el('p.day-row__lead', { class: `is-${state}` }, lead),

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

      el('details.day-row__log', { open: state === 'reading' }, [
        el('summary', {}, logSummary(book, dayKey, unit)),
        sessionLog({ bookId: book.id, fixedDate: dayKey, compact: true, onChange: redraw }),
      ]),

      el('div.day-row__actions', {}, [
        book.status !== 'finished' &&
          el('button.btn.btn--quiet.btn--sm', {
            type: 'button',
            onClick: () => {
              setStatus(book.id, 'finished');
              toast(`${book.title} marked finished.`);
              redraw();
            },
          }, 'Mark finished'),
        el('button.btn.btn--quiet.btn--sm', {
          type: 'button',
          onClick: () => {
            modal.close();
            openBookForm({ book });
          },
        }, 'Open record'),
      ].filter(Boolean)),
    ]),
  ]);
}

/** The pace being read at, once there's a log to read it from. */
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

const fact = (label, value) => el('div.day-row__fact', {}, [el('dt', {}, label), el('dd', {}, value)]);

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
  const parts = [
    `${onThisDay.length} sitting${onThisDay.length === 1 ? '' : 's'}`,
    minutes ? formatDuration(minutes) : null,
    furthest ? `to ${unit === 'minutes' ? '' : 'page '}${furthest}`.trim() : null,
  ].filter(Boolean);
  return parts.join(' \u00b7 ');
}

function emptyDay(dayKey, modal) {
  return el('div.day-empty', {}, [
    el('p', {}, 'Nothing scheduled for this day.'),
    el('button.btn.btn--stamp.btn--sm', {
      type: 'button',
      onClick: () => {
        modal.close();
        openBookForm({ defaultStart: dayKey });
      },
    }, 'Schedule a book here'),
  ]);
}
