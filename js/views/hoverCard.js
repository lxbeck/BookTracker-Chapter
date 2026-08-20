/**
 * Hover card.
 *
 * Hovering a cover on the calendar answers one question first — what does this
 * day ask of me — and then fills in the context behind it. A 700-page book
 * planned Sunday to Saturday says "100 pages to read today", because that is
 * the number you act on; the plan's shape is supporting detail.
 *
 * A hover-only affordance would leave keyboard and touch users with nothing,
 * so the same card opens on focus, and every fact in it also appears in the
 * day popup, which is reachable by click and by keyboard.
 */

import { el, fill } from '../lib/dom.js';
import { paceFor, paceStanding, projectedFinish } from '../logic/pacing.js';
import { dayState, DAY_STATE_LABEL } from '../logic/schedule.js';
import { formatShort, today } from '../lib/dates.js';
import { formatUnit } from '../data/schema.js';

const OPEN_DELAY = 140; // long enough that sweeping the mouse across a week is quiet
const CLOSE_DELAY = 90;
const GAP = 10;

let card = null;
let openTimer = null;
let closeTimer = null;

function ensureCard() {
  if (card) return card;
  card = el('div.hovercard', { role: 'tooltip', hidden: true });
  document.body.append(card);
  return card;
}

/**
 * Attach hover/focus behaviour to a calendar cover tile.
 * @param {HTMLElement} tile
 * @param {object} book
 * @param {string} dayKey
 */
export function attachHoverCard(tile, book, dayKey) {
  const open = () => {
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    openTimer = setTimeout(() => show(tile, book, dayKey), OPEN_DELAY);
  };

  const close = () => {
    clearTimeout(openTimer);
    closeTimer = setTimeout(hide, CLOSE_DELAY);
  };

  tile.addEventListener('mouseenter', open);
  tile.addEventListener('mouseleave', close);
  tile.addEventListener('focus', () => show(tile, book, dayKey));
  tile.addEventListener('blur', hide);
  // A card left hanging over a grid that has since re-rendered is a ghost.
  tile.addEventListener('dragstart', hide);
}

export function hide() {
  clearTimeout(openTimer);
  if (card) card.hidden = true;
}

function show(tile, book, dayKey) {
  const node = ensureCard();
  fill(node, cardBody(book, dayKey));
  node.hidden = false;
  position(node, tile);
}

/** Keep the card on screen: flip above when there's no room below. */
function position(node, tile) {
  const anchor = tile.getBoundingClientRect();
  const box = node.getBoundingClientRect();

  let left = anchor.left + anchor.width / 2 - box.width / 2;
  left = Math.max(GAP, Math.min(left, window.innerWidth - box.width - GAP));

  const below = anchor.bottom + GAP;
  const flip = below + box.height > window.innerHeight - GAP;
  const top = flip ? anchor.top - box.height - GAP : below;

  node.classList.toggle('hovercard--above', flip);
  node.style.left = `${Math.round(left + window.scrollX)}px`;
  node.style.top = `${Math.round(Math.max(GAP, top) + window.scrollY)}px`;
}

/* --- Content -------------------------------------------------------------- */

function cardBody(book, dayKey) {
  const todayKey = today();
  const state = dayState(book, dayKey, todayKey) ?? 'planned';
  const pace = paceFor(book, dayKey, todayKey);
  const unit = formatUnit(book);

  return [
    el('p.hovercard__eyebrow', {}, `${formatShort(dayKey)} \u00b7 ${DAY_STATE_LABEL[state]}`),
    el('h4.hovercard__title', {}, book.title),
    book.author && el('p.hovercard__author', {}, book.author),

    el('p.hovercard__lead', { class: `is-${state}` }, headline(book, pace, state, dayKey, todayKey)),

    pace.ok ? el('dl.hovercard__facts', {}, facts(book, pace, unit)) : null,

    standing(book, todayKey),
  ].filter(Boolean);
}

/** The single sentence the card exists to deliver. */
function headline(book, pace, state, dayKey, todayKey) {
  if (state === 'finished') return 'Finished on this day';
  if (!pace.ok) return pace.reason;
  if (!pace.inPlan) return 'Outside this book\u2019s plan';

  const noun = pace.unit === 'minutes' ? 'minutes' : 'pages';
  const verb = dayKey < todayKey ? 'were due' : dayKey === todayKey ? 'to read today' : 'due that day';
  return `${pace.todayTarget} ${noun} ${verb}`;
}

function facts(book, pace, unit) {
  const rows = [
    ['Plan', `${formatShort(book.schedule.start)} \u2013 ${formatShort(book.schedule.end ?? book.schedule.start)}`],
    ['Length', `${pace.total} ${unit}`],
    ['Day', `${Math.min(pace.dayIndex, pace.days)} of ${pace.days}`],
    ['By tonight', `${unit === 'minutes' ? '' : 'page '}${pace.cumulative}`.trim()],
  ];

  if (book.status === 'reading' && book.progress.page) {
    rows.push(['Actually at', `${unit === 'minutes' ? '' : 'page '}${book.progress.page}`.trim()]);
    const projected = projectedFinish(book);
    if (projected) rows.push(['On this pace', `finishes ${formatShort(projected)}`]);
  }

  return rows.flatMap(([label, value]) => [
    el('dt', {}, label),
    el('dd', {}, value),
  ]);
}

function standing(book, todayKey) {
  const state = paceStanding(book, todayKey);
  if (!state) return null;
  return el('p.hovercard__standing', { class: `is-${state.tone}` }, state.text);
}
