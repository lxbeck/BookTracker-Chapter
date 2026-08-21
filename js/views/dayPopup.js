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
import { goToDay } from './dayCursor.js';

/**
 * The whole of one day — plan and log together, whichever calendar you came
 * from. The grid used to hand its own entries over for the first paint, but
 * those are filtered by kind and by which calendar is on screen, so the popup
 * opened showing a subset and then redrew itself with everything the moment
 * you logged a sitting. It computes its own now.
 *
 * @param {string} dayKey
 */
export function openDayPopup(dayKey) {
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

  draw();

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
