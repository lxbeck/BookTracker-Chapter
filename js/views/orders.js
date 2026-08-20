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
import { compareTitles } from '../lib/titles.js';
import {
  allOrders, allBooks, getBook, createOrder, updateOrder, removeOrder,
  addToOrder, removeFromOrder, moveInOrder, moveOrder, setOrderSequence,
} from '../data/store.js';
import { showModal } from './modal.js';
import { coverThumb } from './cover.js';
import { openBookForm } from './bookForm.js';
import { STATUSES } from '../data/schema.js';

/** Which list is expanded. Module state; not worth persisting. */
let openId = null;

/**
 * The sequence as it was before the last change, per list.
 *
 * A reordering has no natural inverse once a drag is involved — "where did
 * that row come from" is exactly the thing you have already forgotten by the
 * time you notice it went to the wrong place. Keeping the previous array is
 * both simpler and more honest than replaying moves backwards.
 *
 * One step deep on purpose. A stack of twenty would need a visible history to
 * be usable, and the mistake this exists for is always the move you just made.
 * @type {Map<string, string[]>}
 */
const undoStack = new Map();

/** Remember where a list was before changing it. */
function rememberSequence(order) {
  undoStack.set(order.id, [...order.bookIds]);
}

/** Spoken aloud after a move, since the visual change is the only other cue. */
function announce(message) {
  const region = document.querySelector('.order-announce');
  if (region) region.textContent = message;
}

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

    // A move is announced rather than only shown: a row sliding one place up
    // is invisible to a screen reader and easy to miss on a long list.
    el('p.order-announce.visually-hidden', { role: 'status', 'aria-live': 'polite' }),

    orders.length
      ? el('div.order-list', {}, orders.map((order, index) =>
          orderPanel(order, index, orders.length, redraw)))
      : el('div.empty', {}, [
          el('h3', {}, 'No reading orders yet'),
          el('p', {}, 'A reading order is a sequence: the Poe tales books in publication order, a manga backlog, a series reread. A book can sit in as many of them as you like.'),
          el('button.btn.btn--stamp', {
            type: 'button', onClick: () => openOrderForm(null, redraw),
          }, 'Make one'),
        ]),
  ]);
}

function orderPanel(order, index, total, redraw) {
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
        // The lists themselves have an order too. Whichever one you are
        // working through belongs at the top, and there is otherwise no way to
        // put it there short of deleting and remaking it.
        move('\u2191', `Move ${order.name} up`, index > 0, () => {
          moveOrder(order.id, -1);
          announce(`${order.name} moved up.`);
          redraw();
        }),
        move('\u2193', `Move ${order.name} down`, index < total - 1, () => {
          moveOrder(order.id, 1);
          announce(`${order.name} moved down.`);
          redraw();
        }),
        undoStack.has(order.id)
          ? el('button.btn.btn--quiet.btn--sm', {
              type: 'button',
              onClick: () => {
                setOrderSequence(order.id, undoStack.get(order.id));
                undoStack.delete(order.id);
                toast(`${order.name} put back.`);
                announce(`${order.name} restored to its previous order.`);
                redraw();
              },
            }, 'Undo move')
          : null,
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
      ].filter(Boolean)),
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

/**
 * One book in a sequence.
 *
 * Reordering is offered three ways because they fail in different situations.
 * Arrows work on a phone, with a keyboard and with a screen reader, none of
 * which is true of drag-and-drop. The edge buttons exist because moving a book
 * from twentieth to first with an arrow is nineteen clicks. Dragging is the
 * fastest when it works, which is on a mouse, on a list you can see all of.
 */
function orderRow(order, book, index, total, redraw) {
  const reorder = (toIndex, message) => {
    rememberSequence(order);
    moveInOrder(order.id, book.id, toIndex);
    announce(message);
    redraw();
  };

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
      move('\u21c8', `Move ${book.title} to the top`, index > 0,
        () => reorder(0, `${book.title} moved to the top.`)),
      move('\u2191', 'Move up', index > 0,
        () => reorder(index - 1, `${book.title} moved to position ${index}.`)),
      move('\u2193', 'Move down', index < total - 1,
        () => reorder(index + 1, `${book.title} moved to position ${index + 2}.`)),
      move('\u21ca', `Move ${book.title} to the bottom`, index < total - 1,
        () => reorder(total - 1, `${book.title} moved to the bottom.`)),
      el('button.icon-btn', {
        type: 'button', 'aria-label': `Remove ${book.title} from this list`,
        onClick: () => {
          rememberSequence(order);
          removeFromOrder(order.id, book.id);
          announce(`${book.title} removed from ${order.name}.`);
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

  row.addEventListener('dragend', () => {
    row.classList.remove('is-dragging');
    clearDropMarks(row.parentElement);
  });

  /**
   * Which side of this row a drop would land on.
   *
   * The old version dropped everything *at* the target's index, which meant a
   * downward drag landed after the row you aimed at and an upward drag landed
   * before it — the same gesture doing two different things depending on which
   * way you came from. Splitting the row at its midpoint makes the rule one
   * rule, and drawing a line where the book will land means you can see it
   * before you let go.
   */
  const dropsAfter = (event) => {
    const box = row.getBoundingClientRect();
    return event.clientY > box.top + box.height / 2;
  };

  row.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    row.classList.toggle('is-drop-after', dropsAfter(event));
    row.classList.toggle('is-drop-before', !dropsAfter(event));
  });

  row.addEventListener('dragleave', () => {
    row.classList.remove('is-drop-before', 'is-drop-after');
  });

  row.addEventListener('drop', (event) => {
    event.preventDefault();
    const after = dropsAfter(event);
    clearDropMarks(row.parentElement);

    const draggedId = event.dataTransfer.getData('text/plain');
    if (!draggedId || draggedId === book.id) return;

    const from = order.bookIds.indexOf(draggedId);
    if (from === -1) return;

    // The target's index shifts by one once the dragged row is lifted out of
    // the list above it, which is the off-by-one that made drops land a place
    // further down than they looked like they would.
    let target = index + (after ? 1 : 0);
    if (from < target) target -= 1;

    rememberSequence(order);
    moveInOrder(order.id, draggedId, target);
    announce(`${getBook(draggedId)?.title ?? 'Book'} moved to position ${target + 1}.`);
    redraw();
  });

  return row;
}

const clearDropMarks = (list) => {
  for (const node of list?.querySelectorAll('.is-drop-before, .is-drop-after') ?? []) {
    node.classList.remove('is-drop-before', 'is-drop-after');
  }
};

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
        compareTitles(a.title, b.title))
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
