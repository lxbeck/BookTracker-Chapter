/**
 * Library view.
 *
 * Step 1 scope: a flat list of every record, enough to prove CRUD works.
 * Step 3 turns this into the shelved TBR / reading / finished views.
 */

import { el, fill } from '../lib/dom.js';
import { allBooks } from '../data/store.js';
import { STATUSES, FORMATS } from '../data/schema.js';
import { coverThumb } from './cover.js';
import { openBookForm } from './bookForm.js';
import { formatShort } from '../lib/dates.js';

export function renderLibrary(mount) {
  const books = allBooks();

  const head = el('div.view-head', {}, [
    el('div', {}, [
      el('h2.view-title', {}, 'The library'),
      el('p.view-sub', {}, `${books.length} record${books.length === 1 ? '' : 's'}`),
    ]),
    el('button.btn.btn--stamp', { type: 'button', onClick: () => openBookForm() }, 'Add a book'),
  ]);

  if (!books.length) {
    fill(mount, [
      head,
      el('div.empty', {}, [
        el('h3', {}, 'Nothing catalogued yet'),
        el('p', {}, 'Add your first book to start building the shelf. Title is the only thing required — everything else can come later.'),
        el('button.btn.btn--stamp', { type: 'button', onClick: () => openBookForm() }, 'Add a book'),
      ]),
    ]);
    return;
  }

  const rows = [...books]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((book) => bookRow(book));

  fill(mount, [head, el('ul.record-list', {}, rows)]);
}

function bookRow(book) {
  const status = STATUSES[book.status];
  const unit = FORMATS[book.format].unit;

  const plan = book.schedule.start
    ? `${formatShort(book.schedule.start)}${book.schedule.end ? ` \u2192 ${formatShort(book.schedule.end)}` : ''}`
    : 'Unscheduled';

  return el('li.record.slip', {}, [
    coverThumb(book, { width: '48px', alt: '' }),
    el('div.record__main', {}, [
      el('h3.record__title', {}, book.title),
      el('p.record__byline', {}, [
        book.author || 'Unknown author',
        book.genre && el('span.record__dot', {}, '\u00b7'),
        book.genre,
      ]),
    ]),
    el('div.record__meta', {}, [
      el('span.record__stat', {}, book.pageCount ? `${book.pageCount} ${unit}` : '\u2014'),
      el('span.record__stat', {}, plan),
    ]),
    el('span', { class: `chip chip--${book.status}` }, status.label),
    el('button.btn.btn--quiet.btn--sm', {
      type: 'button',
      onClick: () => openBookForm({ book }),
    }, 'Edit'),
  ]);
}
