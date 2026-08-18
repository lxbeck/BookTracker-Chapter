/**
 * Day popup.
 *
 * Clicking a day opens the full picture for it. The rows themselves live in
 * dayRow.js, shared with the full-size Day view, so the two can't drift.
 */

import { el, fill } from '../lib/dom.js';
import { showModal } from './modal.js';
import { openBookForm } from './bookForm.js';
import { dayRow } from './dayRow.js';
import { entriesForDay } from '../logic/schedule.js';
import { formatLong, relativeDay, today } from '../lib/dates.js';
import { allBooks } from '../data/store.js';
import { goToDay } from './day.js';

/**
 * @param {string} dayKey
 * @param {{book: object, state: string}[]} [entries] - precomputed by the grid
 */
export function openDayPopup(dayKey, entries) {
  const todayKey = today();
  const body = el('div.day-popup');

  const draw = () => {
    const current = entriesForDay(allBooks(), dayKey, todayKey);
    fill(body, current.length
      ? current.map((entry) =>
          dayRow(entry, dayKey, todayKey, {
            redraw: draw,
            beforeOpenRecord: () => modal.close(),
            size: 'compact',
          }))
      : [emptyDay(dayKey, () => modal.close())]);
  };

  const modal = showModal({
    eyebrow: relativeDay(dayKey, todayKey),
    title: formatLong(dayKey),
    body,
    wide: true,
    secondaryAction: el('button.btn.btn--quiet', {
      type: 'button',
      onClick: () => {
        modal.close();
        goToDay(dayKey);
      },
    }, 'Open full day'),
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Close'),
      el('button.btn.btn--stamp', {
        type: 'button',
        onClick: () => {
          modal.close();
          openBookForm({ defaultStart: dayKey });
        },
      }, 'Schedule a book here'),
    ],
  });

  // The initial paint can reuse the entries the grid already computed.
  if (entries?.length) {
    fill(body, entries.map((entry) =>
      dayRow(entry, dayKey, todayKey, {
        redraw: draw,
        beforeOpenRecord: () => modal.close(),
        size: 'compact',
      })));
  } else {
    draw();
  }

  return modal;
}

function emptyDay(dayKey, close) {
  return el('div.day-empty', {}, [
    el('p', {}, 'Nothing scheduled for this day.'),
    el('button.btn.btn--stamp.btn--sm', {
      type: 'button',
      onClick: () => {
        close();
        openBookForm({ defaultStart: dayKey });
      },
    }, 'Schedule a book here'),
  ]);
}
