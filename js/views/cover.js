/**
 * Cover thumbnail.
 *
 * A book without cover art still needs to read as a book on the calendar, so
 * the fallback is a typeset spine — title and author on a deterministic colour
 * — rather than a grey box. Container queries let one component serve a 34px
 * calendar tile and a 180px detail panel without a size prop.
 */

import { el } from '../lib/dom.js';
import { spineColor } from '../data/schema.js';

/**
 * @param {object} book
 * @param {Object} [options]
 * @param {string} [options.width] - any CSS length; height follows 2:3
 * @param {string} [options.alt] - overrides the default alt text
 */
export function coverThumb(book, { width = '100%', alt } = {}) {
  const node = el('div.cover', {
    style: { width, containerType: 'inline-size' },
    'aria-hidden': alt === '' ? 'true' : null,
  });

  const fallback = () =>
    el('div.cover__spine', { style: { '--fallback-bg': spineColor(book.title || book.id) } }, [
      el('b', { text: book.title || 'Untitled' }),
      book.author && el('i', { text: book.author }),
    ]);

  if (book.cover?.url) {
    const img = el('img', {
      src: book.cover.url,
      alt: alt ?? `Cover of ${book.title}`,
      loading: 'lazy',
      decoding: 'async',
    });
    // A dead cover URL is common with third-party art; degrade rather than
    // leave a broken-image glyph on the calendar.
    img.addEventListener('error', () => node.replaceChildren(fallback()));
    node.append(img);
  } else {
    node.append(fallback());
  }

  return node;
}
