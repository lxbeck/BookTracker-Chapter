/**
 * Date utilities.
 *
 * Chapter stores every date as a local-calendar day key: `YYYY-MM-DD`, no time,
 * no zone. A reading day is a human day, not an instant — using `Date` objects
 * or ISO timestamps here is how you end up with a book that shows on the 4th in
 * Utah and the 3rd in Tokyo. All arithmetic goes through these helpers.
 */

/** @typedef {string} DayKey `YYYY-MM-DD` */

const pad = (n) => String(n).padStart(2, '0');

/** Today as a DayKey, in the user's local zone. */
export function today() {
  return toKey(new Date());
}

/** @param {Date} date @returns {DayKey} */
export function toKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parse a DayKey into a local Date at midnight. @param {DayKey} key */
export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** True if the string is a well-formed, real calendar date. */
export function isValidKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  return toKey(fromKey(key)) === key;
}

/** Shift a DayKey by `days` (may be negative). */
export function addDays(key, days) {
  const date = fromKey(key);
  date.setDate(date.getDate() + days);
  return toKey(date);
}

/** Whole days from `a` to `b`. Negative if `b` is earlier. */
export function daysBetween(a, b) {
  const MS_PER_DAY = 86400000;
  // Compare UTC-normalised midnights so a DST transition can't yield 0.96 days.
  const utc = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(b) - utc(a)) / MS_PER_DAY);
}

/** Inclusive day count of a range, minimum 1. */
export function spanLength(start, end) {
  return Math.max(1, daysBetween(start, end) + 1);
}

/** True if `key` falls within [start, end] inclusive. Open ends are ignored. */
export function withinRange(key, start, end) {
  if (start && key < start) return false;
  if (end && key > end) return false;
  return Boolean(start || end);
}

/** Every DayKey from start to end inclusive, capped to avoid runaway loops. */
export function eachDay(start, end, cap = 3660) {
  const out = [];
  let cursor = start;
  while (cursor <= end && out.length < cap) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/**
 * Build the 6-row grid a month calendar renders, padded with the surrounding
 * month's days so every week is complete.
 * @param {number} year
 * @param {number} month 0-indexed
 * @param {number} [weekStartsOn] 0 = Sunday, 1 = Monday
 * @returns {{key: DayKey, date: number, inMonth: boolean}[]}
 */
export function monthGrid(year, month, weekStartsOn = 0) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  const start = new Date(year, month, 1 - offset);

  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { key: toKey(date), date: date.getDate(), inMonth: date.getMonth() === month };
  });
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const monthName = (month) => MONTHS[month];

/** Weekday initials in display order for a given week start. */
export function weekdayLabels(weekStartsOn = 0) {
  return Array.from({ length: 7 }, (_, i) => WEEKDAYS[(i + weekStartsOn) % 7]);
}

/** `Sun 12 Oct` — the compact form used on slips and hover cards. */
export function formatShort(key) {
  const date = fromKey(key);
  return `${WEEKDAYS[date.getDay()].slice(0, 3)} ${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)}`;
}

/** `12 October 2026` — the long form used in modal headers. */
export function formatLong(key) {
  const date = fromKey(key);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** Relative phrasing for humans: Today, Tomorrow, in 4 days, 3 days ago. */
export function relativeDay(key, from = today()) {
  const delta = daysBetween(from, key);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Tomorrow';
  if (delta === -1) return 'Yesterday';
  return delta > 0 ? `in ${delta} days` : `${Math.abs(delta)} days ago`;
}
