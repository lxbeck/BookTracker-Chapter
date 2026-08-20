/**
 * Dropping an image onto something.
 *
 * Used by the shelf, where the target is a book, and by the cover picker,
 * where the target is the preview. The behaviour has to be identical in both
 * or it isn't a gesture, it's a coincidence.
 *
 * Two shapes of drop are accepted, because both are things people actually do:
 * a file from the desktop, and an image dragged straight out of another
 * browser tab — which arrives as a URL, not as bytes.
 *
 * `dragenter` and `dragleave` fire for every child element the pointer crosses,
 * so a naive listener flickers the highlight on and off as the cursor moves
 * over a title, then a cover, then a chip. Counting entries and exits instead
 * of toggling is the standard fix and the reason this exists as a helper
 * rather than as six lines repeated twice.
 */

const IMAGE_URL = /^https?:\/\//i;

/**
 * What was dropped, if it was something we can use.
 * @returns {{file: File}|{url: string}|null}
 */
function imageFromDrop(event) {
  const file = [...(event.dataTransfer?.files ?? [])].find((entry) =>
    entry.type.startsWith('image/')
  );
  if (file) return { file };

  // Dragging an image between tabs gives a URL list; dragging one out of some
  // apps gives an HTML fragment with the <img> in it.
  const uri = event.dataTransfer?.getData('text/uri-list')?.split('\n')
    .find((line) => line && !line.startsWith('#'));
  if (uri && IMAGE_URL.test(uri)) return { url: uri.trim() };

  const html = event.dataTransfer?.getData('text/html') ?? '';
  const src = /<img[^>]+src="([^"]+)"/i.exec(html)?.[1];
  if (src && IMAGE_URL.test(src)) return { url: src };

  const text = event.dataTransfer?.getData('text/plain')?.trim();
  if (text && IMAGE_URL.test(text)) return { url: text };

  return null;
}

/** Whether a drag carries anything worth highlighting for. */
const carriesImage = (event) => {
  const types = [...(event.dataTransfer?.types ?? [])];
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html');
};

/**
 * Make a node accept dropped cover art.
 *
 * @param {HTMLElement} node
 * @param {Object} config
 * @param {(payload: {file?: File, url?: string}) => void} config.onImage
 * @param {string} [config.className] - applied while a drop would land here
 * @returns {HTMLElement} the same node, for chaining into an el() call
 */
export function acceptCoverDrop(node, { onImage, className = 'is-drop-target' }) {
  let depth = 0;

  const clear = () => {
    depth = 0;
    node.classList.remove(className);
  };

  node.addEventListener('dragenter', (event) => {
    if (!carriesImage(event)) return;
    event.preventDefault();
    depth += 1;
    node.classList.add(className);
  });

  node.addEventListener('dragover', (event) => {
    if (!carriesImage(event)) return;
    // Without this the browser navigates to the dropped file, which loses the
    // page and everything unsaved on it.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });

  node.addEventListener('dragleave', () => {
    depth -= 1;
    if (depth <= 0) clear();
  });

  node.addEventListener('drop', (event) => {
    if (!carriesImage(event)) return;
    event.preventDefault();
    event.stopPropagation();
    clear();

    const payload = imageFromDrop(event);
    if (payload) onImage(payload);
  });

  return node;
}

/**
 * Stop the browser opening an image dropped anywhere *else* on the page.
 *
 * A near-miss on a book should do nothing. Without this it replaces the app
 * with the image, which reads as having lost your library.
 */
export function guardStrayDrops() {
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => {
      if (event.target.closest?.('[data-cover-drop]')) return;
      if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return;
      event.preventDefault();
    });
  }
}
