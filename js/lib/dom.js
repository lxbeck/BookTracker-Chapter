/**
 * Minimal DOM helpers. Deliberately tiny — Chapter has no framework, so these
 * exist to keep view code declarative and to make escaping the default.
 */

/**
 * Create an element.
 * @param {string} tag - Tag name, optionally with `.class` and `#id` suffixes
 *   (e.g. `div.slip.calendar-day#today`).
 * @param {Object} [attrs] - Attributes. `class`, `dataset`, `style` objects and
 *   `on*` event handlers are all handled. Nullish values are skipped.
 * @param {Array|string|Node} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const node = document.createElement(name);

  for (const token of rest) {
    if (token[0] === '.') node.classList.add(token.slice(1));
    else node.id = token.slice(1);
  }

  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') {
      node.classList.add(...String(value).split(/\s+/).filter(Boolean));
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [property, setting] of Object.entries(value)) {
        if (setting == null) continue;
        // Custom properties have to go through setProperty: assigning them as
        // object keys silently does nothing, which is a very quiet way to lose
        // every CSS variable a view sets.
        if (property.startsWith('--')) node.style.setProperty(property, String(setting));
        else node.style[property] = setting;
      }
    } else if (key === 'text') {
      node.textContent = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, value);
    }
  }

  append(node, children);
  return node;
}

/** Append a child, array of children, or text to a node. */
export function append(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Replace all children of `node` with `children`. */
export function fill(node, children) {
  node.replaceChildren();
  return append(node, children);
}

export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Show a transient message. Errors stay up longer.
 *
 * An `action` turns it into the offer of a way back — "Session deleted. Undo."
 * — which is the difference between a destructive action you can risk and one
 * you have to be sure about first. A toast carrying one stays up long enough
 * to be read and reached.
 *
 * @param {string} message
 * @param {{variant?: 'info'|'error', ms?: number, action?: {label: string, onClick: () => void}}} [options]
 */
export function toast(message, { variant = 'info', ms = 2600, action = null } = {}) {
  let rail = $('.toast-rail');
  if (!rail) {
    rail = el('div.toast-rail', { role: 'status', 'aria-live': 'polite' });
    document.body.append(rail);
  }

  const node = el('div.toast', {
    class: [variant === 'error' ? 'toast--error' : '', action ? 'toast--action' : ''].filter(Boolean).join(' '),
  }, [
    el('span', {}, message),
    action
      ? el('button.toast__action', {
          type: 'button',
          onClick: () => {
            node.remove();
            action.onClick();
          },
        }, action.label)
      : null,
  ].filter(Boolean));

  rail.append(node);

  const life = action ? Math.max(ms, 7000) : variant === 'error' ? ms + 1800 : ms;
  setTimeout(() => node.remove(), life);
}

/**
 * Trap Tab focus inside `container` and restore it on teardown.
 * @returns {() => void} release function
 */
export function trapFocus(container) {
  const previous = document.activeElement;
  const selector =
    'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

  const onKeydown = (event) => {
    if (event.key !== 'Tab') return;
    const focusable = $$(selector, container).filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKeydown);
  return () => {
    container.removeEventListener('keydown', onKeydown);
    if (previous instanceof HTMLElement) previous.focus();
  };
}
