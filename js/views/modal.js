/**
 * A single modal shell every dialog in Chapter reuses: scrim, focus trap,
 * Escape to close, focus returned to whatever opened it.
 */

import { el, fill, trapFocus } from '../lib/dom.js';

let openModal = null;

/* --- The Back button ------------------------------------------------------
   A dialog that covers the screen looks like a place, and on a phone the
   gesture for leaving a place is Back — which, with nothing done about it,
   left the app entirely and lost whatever was half-typed in the form. So an
   open modal owns one history entry: opening pushes it, Back pops it and
   closes the dialog, and closing by any other means gives it back.

   The reconciliation is deferred to a microtask because several flows close
   one dialog and immediately open another, or close one and navigate. Acting
   on the state those flows *end* in, rather than on each step, is what keeps
   Back from swallowing the dialog that just opened.
   -------------------------------------------------------------------------- */

let historyEntry = false;
let hashAtOpen = null;
let popping = false;

function syncHistory() {
  queueMicrotask(() => {
    if (openModal && !historyEntry) {
      hashAtOpen = location.hash;
      history.pushState({ chapterModal: true }, '');
      historyEntry = true;
      return;
    }

    if (!openModal && historyEntry) {
      historyEntry = false;
      // Only wind the entry back if nothing else has navigated in the
      // meantime. "Close this and open the full day view" is one gesture, and
      // stepping back through the closed dialog on the way is not part of it.
      if (!popping && location.hash === hashAtOpen) history.back();
    }
  });
}

globalThis.addEventListener?.('popstate', () => {
  if (!openModal) return;
  historyEntry = false;
  popping = true;
  openModal.close();
  popping = false;
});

/**
 * @param {Object} config
 * @param {string} config.title
 * @param {string} [config.eyebrow] - small typewriter label above the title
 * @param {Node|Node[]} config.body
 * @param {Node[]} [config.actions] - footer buttons, rendered right-aligned
 * @param {Node} [config.secondaryAction] - footer button pinned left
 * @param {boolean} [config.wide]
 * @param {() => void} [config.onClose]
 * @returns {{close: () => void, panel: HTMLElement, setBody: (n: Node|Node[]) => void}}
 */
export function showModal({
  title,
  eyebrow,
  body,
  actions = [],
  secondaryAction = null,
  wide = false,
  onClose,
}) {
  openModal?.close();

  const titleId = `modal-title-${Math.random().toString(36).slice(2, 7)}`;
  const bodyNode = el('div.modal__body', {}, body);

  const panel = el(
    'div.modal__panel',
    {
      class: wide ? 'modal__panel--wide' : '',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
    },
    [
      el('div.modal__head', {}, [
        el('div', {}, [
          eyebrow && el('div.modal__eyebrow', { text: eyebrow }),
          el('h2.modal__title', { id: titleId, text: title }),
        ]),
        el('button.icon-btn', {
          type: 'button',
          'aria-label': 'Close',
          onClick: () => close(),
          text: '\u00d7',
        }),
      ]),
      bodyNode,
      (actions.length || secondaryAction) &&
        el('div.modal__foot', {}, [
          secondaryAction && el('span.spacer', {}, secondaryAction),
          ...actions,
        ]),
    ]
  );

  const root = el('div.modal', {}, [
    el('div.modal__scrim', { onClick: () => close() }),
    panel,
  ]);

  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };

  document.body.append(root);
  document.body.style.overflow = 'hidden';
  syncHistory();
  const release = trapFocus(panel);
  root.addEventListener('keydown', onKeydown);

  // Focus the first real control, not the close button, so keyboard users land
  // where they intend to type.
  const firstField = panel.querySelector('input, select, textarea, .btn--stamp');
  (firstField ?? panel).focus?.();

  function close() {
    if (openModal !== handle) return;
    openModal = null;
    root.removeEventListener('keydown', onKeydown);
    release();
    root.remove();
    document.body.style.overflow = '';
    syncHistory();
    onClose?.();
  }

  const handle = {
    close,
    panel,
    setBody: (next) => fill(bodyNode, next),
  };
  openModal = handle;
  return handle;
}

/**
 * Ask before doing something that cannot be taken back.
 *
 * The browser's own `confirm()` was doing this job in nine places, and it is
 * the one dialog in the app that ignores the theme, cannot be styled, cannot
 * say which button is the dangerous one, and is suppressed outright in some
 * embedded contexts — where it returns false and the action silently never
 * happens. This is the same shell as every other dialog, so it looks like the
 * app and behaves like it: Escape and Back close it, focus is trapped and
 * returned, and the destructive button is the one that looks destructive.
 *
 * @param {Object} config
 * @param {string} config.title
 * @param {string} [config.body] - the consequence, in a sentence
 * @param {string} [config.confirmLabel]
 * @param {string} [config.cancelLabel]
 * @param {boolean} [config.danger] - stamp the confirm button as destructive
 * @returns {Promise<boolean>} whether the person said yes
 */
export function confirmAction({
  title,
  body = '',
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  danger = true,
} = {}) {
  return new Promise((resolve) => {
    // Closing by any other route — Escape, the scrim, Back, the ✕ — is a no.
    let answer = false;

    const modal = showModal({
      title,
      body: body ? el('p', {}, body) : el('p', {}, 'This cannot be undone.'),
      onClose: () => resolve(answer),
      actions: [
        el('button.btn.btn--quiet', {
          type: 'button',
          onClick: () => modal.close(),
        }, cancelLabel),
        el(danger ? 'button.btn.btn--danger' : 'button.btn.btn--stamp', {
          type: 'button',
          onClick: () => {
            answer = true;
            modal.close();
          },
        }, confirmLabel),
      ],
    });
  });
}
