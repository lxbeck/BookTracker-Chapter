/**
 * Keyboard shortcuts.
 *
 * The app is dense enough to reward them: five views, a search field, and a
 * "new book" action that otherwise needs a trip to the library first. None of
 * it is deep, but all of it is repeated, and repeated navigation is exactly
 * what a keyboard is for.
 *
 * Two rules make shortcuts safe to add to an app full of forms:
 *
 * **Never steal a key from a field.** Anything typed into an input, textarea,
 * select or contenteditable belongs to that field. A single-letter shortcut
 * that fires while someone is typing a book title is not a shortcut, it is a
 * bug that eats text.
 *
 * **Never override the browser's own.** Nothing here binds a combination with
 * a modifier, so copy, paste, find, reload and every accessibility shortcut
 * keep working exactly as they did.
 */

import { el, fill } from '../lib/dom.js';
import { showModal } from './modal.js';
import { openBookForm } from './bookForm.js';
import { goToDay } from './dayCursor.js';
import { today } from '../lib/dates.js';

/** Where a keystroke belongs to something else. */
function isTyping(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

const go = (route) => {
  location.hash = `#/${route}`;
};

/**
 * The bindings, in the order they appear in the help sheet.
 *
 * Grouped the way someone would look for them rather than alphabetically: the
 * views first, since those are the ones worth learning, then the actions.
 */
const SHORTCUTS = [
  { keys: ['1'], label: 'Library', group: 'Go to', run: () => go('library') },
  { keys: ['2'], label: 'Calendar', group: 'Go to', run: () => go('calendar') },
  { keys: ['3'], label: 'Today', group: 'Go to', run: () => goToDay(today()) },
  { keys: ['4'], label: 'Year', group: 'Go to', run: () => go('year') },
  { keys: ['5'], label: 'Stats', group: 'Go to', run: () => go('stats') },
  { keys: ['6'], label: 'Reading lists', group: 'Go to', run: () => go('orders') },
  { keys: ['0'], label: 'Settings', group: 'Go to', run: () => go('settings') },

  {
    keys: ['n'],
    label: 'Add a book',
    group: 'Do',
    run: () => openBookForm({}),
  },
  {
    keys: ['/'],
    label: 'Search the library',
    group: 'Do',
    // The search box only exists on the library view, so go there first and
    // focus it once it has rendered.
    run: () => {
      go('library');
      requestAnimationFrame(() => {
        const field = document.querySelector('.library-search, input[aria-label="Search the library"]');
        field?.focus();
        field?.select?.();
      });
    },
  },
  { keys: ['?'], label: 'This list', group: 'Do', run: () => showShortcuts() },
];

/** Look up a binding for a plain keystroke. */
const bindingFor = (key) =>
  SHORTCUTS.find((shortcut) => shortcut.keys.includes(key));

/**
 * Start listening.
 *
 * Bound to the window at boot and never unbound: there is one document and one
 * app, and a shortcut layer that comes and goes with the view would need to be
 * torn down correctly on every render to avoid firing twice.
 */
export function installShortcuts() {
  window.addEventListener('keydown', (event) => {
    // Modifiers belong to the browser and the operating system.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTyping(event.target)) return;

    // A modal owns the keyboard while it is open — except for Escape, which it
    // already handles, and the help sheet, which should be closable the same
    // way it was opened.
    if (document.querySelector('.modal') && event.key !== '?') return;

    const binding = bindingFor(event.key);
    if (!binding) return;

    event.preventDefault();
    binding.run();
  });
}

/** The help sheet, opened with `?` or from Settings. */
export function showShortcuts() {
  const open = document.querySelector('.modal');
  if (open) return;

  const groups = [...new Set(SHORTCUTS.map((shortcut) => shortcut.group))];

  const modal = showModal({
    eyebrow: 'Keyboard',
    title: 'Shortcuts',
    body: [
      el('p.settings__note', {},
        'These work anywhere except inside a text field, and none of them uses a modifier, so nothing the browser does changes.'),
      ...groups.map((group) =>
        el('div.shortcut-group', {}, [
          el('h4.settings__subtitle', {}, group),
          el('dl.shortcut-list', {},
            SHORTCUTS.filter((shortcut) => shortcut.group === group).flatMap((shortcut) => [
              el('dt', {}, shortcut.keys.map((key) => el('kbd', {}, key))),
              el('dd', {}, shortcut.label),
            ])),
        ])),
    ],
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Close'),
    ],
  });

  return modal;
}
