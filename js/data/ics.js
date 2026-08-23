/**
 * The reading plan as a calendar file.
 *
 * A plan that lives only in this app is a plan you have to remember to come
 * and look at. Everyone already has a calendar they check without deciding to,
 * and a book scheduled from the 3rd to the 10th is exactly the shape of thing
 * that belongs in it.
 *
 * Exported rather than subscribed to: a subscription needs a URL that is
 * reachable from wherever the calendar app runs, which for a library living in
 * a browser tab or on a laptop at home is usually nowhere. A file you import
 * works everywhere and never surprises you by changing.
 *
 * The format is fussier than it looks, and most of the fussiness is
 * unforgiving: lines fold at 75 octets, breaks are CRLF, commas and semicolons
 * in text must be escaped, and an all-day event's end date is the day *after*
 * the last day it covers. Getting any of those wrong produces a file that some
 * apps accept and others reject with no explanation.
 */

import { addDays } from '../lib/dates.js';
import { formatUnit } from './schema.js';

/** iCalendar text: backslash, semicolon, comma and newline all mean something. */
function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold a line to 75 octets, continuing with a leading space.
 *
 * Counted in octets rather than characters because the limit is bytes: a
 * title full of accented characters or CJK folds sooner than its length
 * suggests, and folding by character count produces lines that are still too
 * long for a strict parser.
 */
function fold(line) {
  const bytes = [...new TextEncoder().encode(line)];
  if (bytes.length <= 75) return line;

  const decoder = new TextDecoder();
  const chunks = [];
  let at = 0;

  while (at < bytes.length) {
    const size = chunks.length === 0 ? 75 : 74;
    let end = Math.min(at + size, bytes.length);

    // Never split a multi-byte character: continuation bytes are 10xxxxxx.
    while (end > at && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;

    chunks.push((chunks.length ? ' ' : '') + decoder.decode(new Uint8Array(bytes.slice(at, end))));
    at = end;
  }

  return chunks.join('\r\n');
}

const stamp = (date = new Date()) => `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;

/** A local day key as an iCalendar DATE value. */
const dateValue = (dayKey) => String(dayKey).replace(/-/g, '');

/**
 * Build the calendar.
 *
 * One all-day event per scheduled book, spanning its planned dates. Books with
 * no start date are skipped rather than dropped on today, since a plan you did
 * not make is worse than no entry.
 *
 * @param {object[]} books
 * @param {{name?: string, includeFinished?: boolean}} [options]
 * @returns {string} an .ics file
 */
export function buildIcs(books, { name = 'Reading plan', includeFinished = true } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Chapter//Reading plan//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    // Without this most clients poll far more often than a static file wants.
    'X-PUBLISHED-TTL:PT12H',
  ];

  const now = stamp();

  for (const book of books) {
    const start = book.schedule?.start;
    if (!start) continue;
    if (!includeFinished && book.status === 'finished') continue;

    // DTEND on an all-day event is exclusive: a book read on the 3rd through
    // the 10th ends on the 11th. Using the last day itself silently drops a
    // day off every plan in the calendar.
    const last = book.schedule.end || start;
    const end = addDays(last, 1);

    const detail = [
      book.author ? `by ${book.author}` : null,
      book.pageCount ? `${book.pageCount} ${formatUnit(book)}` : null,
      book.series?.name
        ? `${book.series.name}${book.series.number != null ? ` #${book.series.number}` : ''}`
        : null,
      book.description || null,
    ].filter(Boolean).join('\n');

    lines.push(
      'BEGIN:VEVENT',
      // Stable across exports, so re-importing updates the entry rather than
      // creating a second copy of every book.
      `UID:${book.id}@chapter`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${dateValue(start)}`,
      `DTEND;VALUE=DATE:${dateValue(end)}`,
      `SUMMARY:${escapeText(book.title)}`,
      detail ? `DESCRIPTION:${escapeText(detail)}` : null,
      `CATEGORIES:${escapeText(book.category ?? 'book')}`,
      book.status === 'finished' ? 'STATUS:CONFIRMED' : 'STATUS:TENTATIVE',
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');

  return lines.filter(Boolean).map(fold).join('\r\n');
}

/** How many events an export would actually contain. */
export const icsEventCount = (books, { includeFinished = true } = {}) =>
  books.filter(
    (book) => book.schedule?.start && (includeFinished || book.status !== 'finished')
  ).length;
