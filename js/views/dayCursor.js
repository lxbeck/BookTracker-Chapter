/**
 * Which day the day view is showing, and how to send it somewhere.
 *
 * This is one variable and two lines of routing, and it lives here rather than
 * in `day.js` because of what happened when it did not. The calendar, the year
 * grid and the day popup all need to say "open this date"; the day popup is
 * also opened *by* the day view. So `day.js` imported `dayPopup.js` and
 * `dayPopup.js` imported `day.js`, and the two modules sat in a loop.
 *
 * It worked, which is the dangerous part. A cycle between modules that only
 * call each other from event handlers resolves fine, because by the time
 * anything runs both modules have finished loading. Move one line of work to
 * the top level of either file — a constant built from the other's export, a
 * lookup table, anything — and it becomes `undefined` at import time and a
 * blank screen with an error that names neither module usefully.
 *
 * Pulling the shared state into a leaf module both can import breaks the loop
 * and costs nothing.
 */

import { today } from '../lib/dates.js';

/** The day on screen. Module state, like the calendar's month cursor. */
let cursor = null;

export const currentDay = () => cursor ?? today();

export const setCurrentDay = (dayKey) => {
  cursor = dayKey;
};

/** Send the app to the day view, showing this date. */
export function goToDay(dayKey) {
  cursor = dayKey;
  location.hash = '#/day';
}
