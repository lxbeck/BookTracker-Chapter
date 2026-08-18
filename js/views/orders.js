/**
 * Reading orders — named sequences of books.
 *
 * A shelf answers "which books are these"; an order answers "in what order do
 * I read them". Comics and manga make the difference obvious: a run of
 * newspaper strip collections has a publication order that no amount of
 * tagging expresses.
 *
 * Reordering is by arrows and by drag. Arrows first, because they work on a
 * phone, with a keyboard, and with a screen reader, none of which is true of
 * drag-and-drop on its own.
 */

import { el, fill, toast } from '../lib/dom.js';
import {
  allOrders, allBooks, getBook, createOrder, updateOrder, removeOrder,
  addToOrder, removeFromOrder, moveInOrder,
} from '../data/store.js';
import { showModal } from './modal.js';
import { coverThumb } from './cover.js';
import { openBookForm } from './bookForm.js';
import { STATUSES } from '../data/schema.js';

/** Which list is expanded. Module state; not worth persisting. */
let openId = null;

export function renderOrders(mount) {
  const orders = allOrders();
  const redraw = () => renderOrders(mount);

  fill(mount, [
    el('div.view-head', {}, [
      el('div', {}, [
        el('h2.view-title', {}, 'Reading orders'),
        el('p.view-sub', {}, `${orders.length} list${orders.length === 1 ? '' : 's'}`),
      ]),
      el('button.btn.btn--stamp', {
        type: 'button', onClick: () => openOrderForm(null, redraw),
      }, 'New list'),
    ]),

    orders.length
      ? el('div.order-list', {}, orders.map((order) => orderPanel(order, redraw)))
      : el('div.empty', {}, [
          el('h3', {}, 'No reading orders yet'),
          el('p', {}, 'A reading order is a sequence: the Poe tales books in publication order, a manga backlog, a series reread. A book can sit in as many of them as you like.'),
          el('button.btn.btn--stamp', {
            type: 'button', onClick: () => openOrderForm(null, redraw),
          }, 'Make one'),
        ]),
  ]);
}

function orderPanel(order, redraw) {
  const expanded = openId === order.id;
  const books = order.bookIds.map((id) => getBook(id)).filter(Boolean);
  const finished = books.filter((book) => book.status === 'finished').length;
  const next = books.find((book) => book.status !== 'finished');

  return el('section.order-panel.slip.slip--plain', { class: expanded ? 'is-open' : '' }, [
    el('header.order-panel__head', {}, [
      el('button.order-panel__toggle', {
        type: 'button',
        'aria-expanded': String(expanded),
        onClick: () => {
          openId = expanded ? null : order.id;
          redraw();
        },
      }, [
        el('span.order-panel__caret', { 'aria-hidden': 'true' }, expanded ? '\u2212' : '+'),
        el('div', {}, [
          el('h3.order-panel__name', {}, order.name),
          el('p.order-panel__meta', {},
            books.length
              ? `${books.length} books \u00b7 ${finished} finished${next ? ` \u00b7 next up: ${next.title}` : ''}`
              : 'Empty list'),
        ]),
      ]),
      el('div.order-panel__actions', {}, [
        el('button.btn.btn--quiet.btn--sm', {
          type: 'button', onClick: () => openAddDialog(order, redraw),
        }, 'Add books'),
        el('button.btn.btn--quiet.btn--sm', {
          type: 'button', onClick: () => openOrderForm(order, redraw),
        }, 'Rename'),
        el('button.btn.btn--danger.btn--sm', {
          type: 'button',
          onClick: () => {
            if (!confirm(`Delete the list "${order.name}"? The books themselves stay in your library.`)) return;
            removeOrder(order.id);
            toast('List deleted.');
            redraw();
          },
        }, 'Delete'),
      ]),
    ]),

    order.description ? el('p.order-panel__description', {}, order.description) : null,

    expanded
      ? books.length
        ? el('ol.order-books', {}, books.map((book, index) =>
            orderRow(order, book, index, books.length, redraw)))
        : el('p.order-panel__empty', {}, 'Nothing in this list yet.')
      : null,
  ].filter(Boolean));
}

function orderRow(order, book, index, total, redraw) {
  const row = el('li.order-row', {
    draggable: 'true',
    dataset: { bookId: book.id, index: String(index) },
  }, [
    el('span.order-row__n', {}, String(index + 1)),
    coverThumb(book, { width: '30px', alt: '' }),
    el('div.order-row__body', {}, [
      el('span.order-row__title', {}, book.title),
      el('span.order-row__author', {}, book.author || 'Unknown author'),
    ]),
    el('span', { class: `chip chip--${book.status}` }, STATUSES[book.status].label),
    el('div.order-row__moves', {}, [
      move('\u2191', 'Move up', index > 0, () => {
        moveInOrder(order.id, book.id, index - 1);
        redraw();
      }),
      move('\u2193', 'Move down', index < total - 1, () => {
        moveInOrder(order.id, book.id, index + 1);
        redraw();
      }),
      el('button.icon-btn', {
        type: 'button', 'aria-label': `Remove ${book.title} from this list`,
        onClick: () => {
          removeFromOrder(order.id, book.id);
          redraw();
        },
      }, '\u00d7'),
      el('button.icon-btn', {
        type: 'button', 'aria-label': `Open ${book.title}`,
        onClick: () => openBookForm({ book }),
      }, '\u2261'),
    ]),
  ]);

  row.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', book.id);
    event.dataTransfer.effectAllowed = 'move';
    row.classList.add('is-dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
  row.addEventListener('dragover', (event) => {
    event.preventDefault();
    row.classList.add('is-drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
  row.addEventListener('drop', (event) => {
    event.preventDefault();
    row.classList.remove('is-drop-target');
    const draggedId = event.dataTransfer.getData('text/plain');
    if (draggedId && draggedId !== book.id) {
      moveInOrder(order.id, draggedId, index);
      redraw();
    }
  });

  return row;
}

const move = (glyph, label, enabled, onClick) =>
  el('button.icon-btn.order-row__move', {
    type: 'button', 'aria-label': label, disabled: !enabled, onClick,
  }, glyph);

/* --- Dialogs --------------------------------------------------------------- */

function openOrderForm(order, redraw) {
  const nameInput = el('input.input', {
    value: order?.name ?? '',
    placeholder: 'Poe, in order',
    'aria-label': 'List name',
  });
  const descriptionInput = el('textarea.textarea', {
    rows: '2',
    placeholder: 'What this list is for.',
    'aria-label': 'Description',
  }, order?.description ?? '');

  const save = () => {
    const payload = { name: nameInput.value, description: descriptionInput.value };
    const result = order ? updateOrder(order.id, payload) : createOrder(payload);
    if (!result.ok) {
      toast(Object.values(result.errors)[0], { variant: 'error' });
      return;
    }
    if (!order) openId = result.order.id;
    modal.close();
    redraw();
  };

  const modal = showModal({
    eyebrow: order ? 'Reading order' : 'New list',
    title: order ? 'Rename this list' : 'New reading order',
    body: [
      el('label.field', {}, [el('span.field__label', {}, 'Name'), nameInput]),
      el('label.field', {}, [el('span.field__label', {}, 'Description'), descriptionInput]),
    ],
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn--stamp', { type: 'button', onClick: save }, order ? 'Save' : 'Create'),
    ],
  });
}

function openAddDialog(order, redraw) {
  const chosen = new Set();
  const search = el('input.input', {
    type: 'search', placeholder: 'Search your library\u2026', 'aria-label': 'Search books',
  });
  const list = el('div.order-picker');

  const paint = () => {
    const needle = search.value.trim().toLowerCase();
    const candidates = allBooks()
      .filter((book) => !order.bookIds.includes(book.id))
      .filter((book) =>
        !needle ||
        [book.title, book.author, book.series.name].filter(Boolean)
          .some((value) => value.toLowerCase().includes(needle)))
      // Series first, then index, so adding a run of comics lands in the right
      // sequence without any dragging afterwards.
      .sort((a, b) =>
        (a.series.name || '~').localeCompare(b.series.name || '~') ||
        (a.series.number ?? 0) - (b.series.number ?? 0) ||
        a.title.localeCompare(b.title))
      .slice(0, 60);

    fill(list, candidates.length
      ? candidates.map((book) =>
          el('label.order-picker__row', {}, [
            el('input', {
              type: 'checkbox',
              checked: chosen.has(book.id),
              onChange: (event) => {
                if (event.target.checked) chosen.add(book.id);
                else chosen.delete(book.id);
                count.textContent = `${chosen.size} selected`;
              },
            }),
            el('span.order-picker__title', {}, book.title),
            el('span.order-picker__meta', {},
              [book.series.name && `${book.series.name}${book.series.number ? ` #${book.series.number}` : ''}`,
               book.author].filter(Boolean).join(' \u00b7 ')),
          ]))
      : [el('p.settings__note', {}, 'Nothing left to add from your library.')]);
  };

  const count = el('span.settings__note', {}, '0 selected');
  search.addEventListener('input', paint);
  paint();

  const modal = showModal({
    eyebrow: order.name,
    title: 'Add books to this list',
    wide: true,
    body: [
      search,
      el('p.field__hint', {}, 'Ticked books are appended in series order, so a run of comics arrives already sequenced. Reorder afterwards with the arrows.'),
      list,
    ],
    secondaryAction: count,
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn--stamp', {
        type: 'button',
        onClick: () => {
          if (!chosen.size) return;
          // Append in the order shown, not the order ticked, so the sequence
          // matches what was on screen.
          const ordered = [...list.querySelectorAll('input:checked')]
            .map((input) => input.closest('.order-picker__row'))
            .map((row) => row.querySelector('.order-picker__title').textContent);

          const ids = ordered
            .map((title) => allBooks().find((book) => book.title === title)?.id)
            .filter((id) => id && chosen.has(id));

          addToOrder(order.id, ids.length ? ids : [...chosen]);
          modal.close();
          toast(`${chosen.size} books added to ${order.name}.`);
          openId = order.id;
          redraw();
        },
      }, 'Add to list'),
    ],
  });
}
