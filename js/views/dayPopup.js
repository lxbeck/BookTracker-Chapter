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
import { allBooks, updateBook, setStatus } from '../data/store.js';

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
            projectedFinish(book, todayKey)
              ? fact('On current pace', `finishes ${formatShort(projectedFinish(book, todayKey))}`)
              : null,
          ].filter(Boolean))
        : null,

      standingLine(book, todayKey),

      el('div.day-row__actions', {}, [
        progressControl(book, unit, redraw),
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

const fact = (label, value) => el('div.day-row__fact', {}, [el('dt', {}, label), el('dd', {}, value)]);

function standingLine(book, todayKey) {
  const state = paceStanding(book, todayKey);
  if (!state) return null;
  return el('p.day-row__standing', { class: `is-${state.tone}` }, state.text);
}

/**
 * Logging where you got to is the single most common thing you do on a day, so
 * it lives inline rather than behind the record. Step 5 grows this into full
 * session logging; the field it writes to is already the right one.
 */
function progressControl(book, unit, redraw) {
  if (!book.pageCount || book.status === 'finished') return null;

  const input = el('input.input.day-row__progress', {
    type: 'number',
    min: '0',
    max: String(book.pageCount),
    value: book.progress.page || '',
    placeholder: unit === 'minutes' ? 'minutes in' : 'page',
    'aria-label': `Current ${unit === 'minutes' ? 'minute' : 'page'} in ${book.title}`,
  });

  const save = () => {
    const value = Number.parseInt(input.value, 10);
    if (!Number.isFinite(value) || value < 0) return;
    updateBook(book.id, {
      progress: { page: Math.min(value, book.pageCount), percent: 0 },
      status: book.status === 'planned' ? 'reading' : book.status,
    });
    redraw();
  };

  input.addEventListener('change', save);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  });

  return el('label.day-row__progress-wrap', {}, [
    el('span.day-row__progress-label', {}, unit === 'minutes' ? 'At minute' : 'At page'),
    input,
  ]);
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
