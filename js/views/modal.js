/**
 * A single modal shell every dialog in Chapter reuses: scrim, focus trap,
 * Escape to close, focus returned to whatever opened it.
 */

import { el, fill, trapFocus } from '../lib/dom.js';

let openModal = null;

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

export const closeModal = () => openModal?.close();
