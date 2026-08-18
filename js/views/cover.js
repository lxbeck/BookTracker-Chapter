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
import { cachedCoverUrl, peekCachedCoverUrl } from '../data/coverCache.js';

/**
 * @param {object} book
 * @param {Object} [options]
 * @param {string} [options.width] - any CSS length; height follows 2:3
 * @param {string} [options.alt] - overrides the default alt text
 * @param {'crop'|'whole'} [options.fit]
 *   `crop` locks every thumbnail to 2:3 and trims the overflow — right for
 *   grids and calendar tiles, where a ragged row of mismatched heights reads
 *   as broken. `whole` shows the entire cover at its own proportions, for
 *   anywhere the art itself is the point. Most covers are near enough to 2:3
 *   that cropping is invisible; the ones that aren't get beheaded, which is
 *   why detail views use `whole`.
 */
export function coverThumb(book, { width = '100%', alt, fit = 'crop' } = {}) {
  // A cover with no art still needs a box with a shape, so the fallback spine
  // keeps the fixed ratio even in `whole` mode.
  const whole = fit === 'whole' && Boolean(book.cover?.url);

  const node = el('div.cover', {
    class: whole ? 'cover--whole' : '',
    style: { width, containerType: 'inline-size' },
    'aria-hidden': alt === '' ? 'true' : null,
  });

  const fallback = () =>
    el('div.cover__spine', { style: { '--fallback-bg': spineColor(book.title || book.id) } }, [
      el('b', { text: book.title || 'Untitled' }),
      book.author && el('i', { text: book.author }),
    ]);

  if (book.cover?.url) {
    // A locally cached copy beats the network every time, and is the only
    // thing that renders at all when there isn't one.
    const cached = peekCachedCoverUrl(book.id);

    const img = el('img', {
      src: cached ?? book.cover.url,
      alt: alt ?? `Cover of ${book.title}`,
      loading: 'lazy',
      decoding: 'async',
    });
    // A dead cover URL is common with third-party art; degrade rather than
    // leave a broken-image glyph on the calendar. The ratio box has to come
    // back with it, or the fallback collapses to nothing.
    img.addEventListener('error', () => {
      node.classList.remove('cover--whole');
      node.replaceChildren(fallback());
    });
    node.append(img);

    // If the cache hadn't been warmed yet, swap in the local copy once it
    // resolves. Silent on failure — the network URL is already loading.
    if (!cached) {
      cachedCoverUrl(book.id).then((url) => {
        if (url && node.isConnected) img.src = url;
      }).catch(() => null);
    }
  } else {
    node.append(fallback());
  }

  return node;
}
