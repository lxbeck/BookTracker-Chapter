/**
 * Cover picker.
 *
 * Sits inside the book form. Three ways to get art, in the order people
 * actually reach for them: look it up from the ISBN they just typed, search by
 * title, or upload their own. All three converge on the same shape —
 * `{url, source}` — so the rest of the app never cares where a cover came from.
 */

import { el, fill, toast } from '../lib/dom.js';
import { coverThumb } from './cover.js';
import {
  lookupByIsbn, searchByText, fileToCoverDataUrl, normalizeCoverUrl,
} from '../data/covers.js';
import { PROVIDERS } from '../data/providers.js';
import { acceptCoverDrop } from './coverDrop.js';
import {
  cacheCover, storeCoverOnServer, storeUploadedCover, storeUploadedCoverOnServer,
  cachedIds, removeCachedCover, deleteCoverOnServer, hasServer, LOCAL_COVER,
} from '../data/coverCache.js';

const SOURCE_LABEL = {
  ...Object.fromEntries(Object.values(PROVIDERS).map((provider) => [provider.id, provider.label])),
  upload: 'Uploaded',
  url: 'Pasted address',
};

/**
 * @param {Object} config
 * @param {object} config.draft - the book being edited (read for isbn/title)
 * @param {() => {isbn: string, title: string, author: string}} config.readForm
 * @param {(cover: {url: string|null, source: string|null}, meta?: object) => void} config.onPick
 *   `meta` carries title/author/pageCount a lookup found, for autofill.
 */
export function coverPicker({ draft, readForm, onPick }) {
  let cover = { ...draft.cover };

  const preview = acceptCoverDrop(
    el('div.cover-picker__preview', { dataset: { coverDrop: 'picker' } }),
    { onImage: (payload) => (payload.file ? handleUpload(payload.file) : useUrl(payload.url)) }
  );
  const status = el('p.cover-picker__status', { 'aria-live': 'polite' });
  const results = el('div.cover-picker__results', { hidden: true });

  const fileInput = el('input', {
    type: 'file',
    accept: 'image/*',
    class: 'visually-hidden',
    onChange: (event) => handleUpload(event.target.files?.[0]),
  });

  function drawPreview() {
    fill(preview, [
      coverThumb({ ...draft, cover }, { width: '104px', alt: '', fit: 'whole' }),
      el('span.cover-picker__source', {
        text: cover.url ? SOURCE_LABEL[cover.source] ?? 'Custom' : 'No cover',
      }),
      whereNote,
    ]);
    describeWhere();
  }

  /**
   * Whether this cover is a file you have or an address you are borrowing.
   *
   * The same question the report in Settings answers for the whole library,
   * asked about the book in front of you — which is where it actually comes
   * up, since "is this one safe" is what you want to know while looking at it.
   */
  const whereNote = el('span.cover-picker__where', { 'aria-live': 'polite' });

  async function describeWhere() {
    if (!cover.url) {
      whereNote.textContent = '';
      return;
    }
    if (!draft.id) {
      whereNote.textContent = 'Saved when you save the book.';
      return;
    }

    if (hasServer()) {
      try {
        const body = await (await fetch('api/covers')).json();
        const file = body.byBook?.[draft.id];
        if (file) {
          whereNote.textContent = `Saved in the covers folder as ${file}`;
          return;
        }
      } catch {
        /* fall through to the weaker copy */
      }
    }

    const cached = await cachedIds([draft.id]).catch(() => []);
    whereNote.textContent = cached.length
      ? 'Held in this browser only \u2014 not in the covers folder.'
      : 'Linked from the web, not saved \u2014 it will go blank if the source does.';
  }

  function setCover(next, meta) {
    cover = next;
    drawPreview();
    onPick(cover, meta);
    // Store the bytes locally straight away, so the book is offline-ready the
    // moment it's saved rather than only after a manual sweep in Settings.
    if (next.url && draft.id) {
      cacheCover(draft.id, next.url).catch(() => null);
      // The title goes with it: the server files cover art under the book's
      // name, and the draft's title is the freshest one there is.
      storeCoverOnServer(draft.id, next.url, readForm().title || draft.title)
        .catch(() => null);
    }
  }

  function setBusy(busy, message = '') {
    status.textContent = message;
    for (const button of buttons) button.disabled = busy;
  }

  /* --- Actions ------------------------------------------------------------ */

  async function handleIsbnLookup() {
    const { isbn } = readForm();
    if (!isbn.trim()) {
      status.textContent = 'Enter an ISBN above first, or search by title instead.';
      return;
    }

    setBusy(true, 'Looking up that ISBN\u2026');
    try {
      const found = await lookupByIsbn(isbn);
      if (!found) {
        setBusy(false, 'No match for that ISBN. Try a title search, or upload your own art.');
        return;
      }
      setCover({ url: found.coverUrl, source: found.source }, found);
      setBusy(false, `Found on ${SOURCE_LABEL[found.source]}.`);
    } catch (error) {
      setBusy(false, error.message.includes('ISBN') ? error.message : 'The lookup service did not respond. Upload your own art, or try again in a moment.');
    }
  }

  async function handleTextSearch() {
    const { title, author } = readForm();
    const query = [title, author].filter(Boolean).join(' ').trim();
    if (!query) {
      status.textContent = 'Enter a title above first.';
      return;
    }

    setBusy(true, `Searching for "${query}"\u2026`);
    try {
      const matches = await searchByText(query);
      if (!matches.length) {
        results.hidden = true;
        setBusy(false, 'Nothing came back for that. Try adding the author, or upload your own art.');
        return;
      }
      showResults(matches);
      setBusy(false, `${matches.length} match${matches.length === 1 ? '' : 'es'} — pick one.`);
    } catch {
      results.hidden = true;
      setBusy(false, 'The search service did not respond. Upload your own art, or try again in a moment.');
    }
  }

  /**
   * Use an image address typed or pasted in.
   *
   * The catalogue of last resort. Every provider here is a catalogue with
   * gaps, and for anything unusual — a small press, a fan translation, a
   * boxed set with its own art — the picture that exists on the publisher's
   * own page is better than the three that don't exist anywhere else.
   */
  function useUrl(value) {
    try {
      const url = normalizeCoverUrl(value);
      setCover({ url, source: 'url' });
      results.hidden = true;
      urlInput.value = '';
      status.textContent = 'Using that image.';
    } catch (error) {
      status.textContent = error.message;
    }
  }

  const urlInput = el('input.input.cover-picker__url', {
    type: 'url',
    placeholder: 'or paste an image address\u2026',
    'aria-label': 'Cover image address',
    onKeydown: (event) => {
      if (event.key !== 'Enter') return;
      // Enter in a field inside a form means submit, which would save the book
      // half way through choosing its cover.
      event.preventDefault();
      useUrl(urlInput.value);
    },
  });

  function showResults(matches) {
    results.hidden = false;
    fill(
      results,
      matches.map((match) =>
        el(
          'button.cover-option',
          {
            type: 'button',
            onClick: () => {
              setCover({ url: match.coverUrl, source: match.source }, match);
              results.hidden = true;
              status.textContent = `Using the edition from ${SOURCE_LABEL[match.source]}.`;
            },
          },
          [
            coverThumb({ title: match.title, author: match.author, cover: { url: match.coverUrl } }, { width: '100%', alt: '' }),
            el('span.cover-option__title', { text: match.title }),
            el('span.cover-option__meta', {
              text: [match.author, match.year].filter(Boolean).join(' \u00b7 '),
            }),
            // Which catalogue each candidate came from, because two results
            // for the same book with different art is a choice, not a bug.
            el('span.cover-option__source', { text: SOURCE_LABEL[match.source] ?? match.source }),
          ]
        )
      )
    );
  }

  async function handleUpload(file) {
    if (!file) return;
    setBusy(true, 'Processing that image\u2026');
    try {
      const dataUrl = await fileToCoverDataUrl(file);

      // The image goes to the image store; the record keeps a short sentinel.
      // Putting base64 in the record is what fills localStorage and makes
      // every later save fail.
      try {
        await storeUploadedCover(draft.id, dataUrl);
        setCover({ url: LOCAL_COVER, source: 'upload' });
      } catch {
        // No IndexedDB: fall back to the old behaviour rather than losing it.
        setCover({ url: dataUrl, source: 'upload' });
      }
      // An upload only exists on the device that made it until the server has
      // a copy, which is not what "my library is on both my devices" implies.
      storeUploadedCoverOnServer(draft.id, dataUrl, readForm().title || draft.title)
        .catch(() => null);
      setBusy(false, 'Using your image.');
    } catch (error) {
      setBusy(false, error.message);
      toast(error.message, { variant: 'error' });
    } finally {
      fileInput.value = '';
    }
  }

  /* --- Markup ------------------------------------------------------------- */

  const buttons = [
    el('button.btn.btn--quiet.btn--sm', { type: 'button', onClick: handleIsbnLookup }, 'Find by ISBN'),
    el('button.btn.btn--quiet.btn--sm', { type: 'button', onClick: handleTextSearch }, 'Search by title'),
    el('button.btn.btn--quiet.btn--sm', { type: 'button', onClick: () => fileInput.click() }, 'Upload'),
    el('button.btn.btn--danger.btn--sm', {
      type: 'button',
      onClick: () => {
        setCover({ url: null, source: null });
        results.hidden = true;
        status.textContent = 'Cover removed.';

        // Clearing the field is not removing the cover. The file stayed in the
        // covers folder and the copy stayed in this browser's image store, so
        // a removed cover still counted as stored, still synced to every other
        // device, and came back the moment anything re-read either copy.
        if (draft.id) {
          removeCachedCover(draft.id).catch(() => null);
          deleteCoverOnServer(draft.id).catch(() => null);
        }
      },
    }, 'Remove'),
  ];

  drawPreview();

  return el('div.cover-picker', {}, [
    preview,
    el('div.cover-picker__controls', {}, [
      el('div.cover-picker__actions', {}, buttons),
      el('div.cover-picker__url-row', {}, [
        urlInput,
        el('button.btn.btn--quiet.btn--sm', {
          type: 'button', onClick: () => useUrl(urlInput.value),
        }, 'Use address'),
      ]),
      el('p.field__hint', {}, 'You can also drag an image straight onto the cover \u2014 from your desktop, or from another browser tab.'),
      status,
      results,
      fileInput,
    ]),
  ]);
}
