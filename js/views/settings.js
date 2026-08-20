/**
 * Settings: the yearly goal, offline storage, and getting your data out.
 *
 * Export sits here rather than behind a menu because a backup nobody can find
 * is a backup nobody takes.
 */

import { el, fill, toast } from '../lib/dom.js';
import { showModal } from './modal.js';
import {
  allBooks, getSettings, updateSettings, replaceAll, mergeBooks,
  storageStatus, requestPersistentStorage,
} from '../data/store.js';
import {
  exportJson, exportJsonWithCovers, exportCsv, exportSessionsCsv,
  importJson, restoreCovers, download, backupFilename,
} from '../data/transfer.js';
import { cacheAll, cachedIds, cacheSize, evacuateDataUrls } from '../data/coverCache.js';
import { updateBook } from '../data/store.js';
import { goalProgress } from '../logic/stats.js';
import { sampleBooks } from '../data/seed.js';
import { parseGoodreadsCsv } from '../data/goodreads.js';
import { parseCalibreCsv } from '../data/calibre.js';
import { fillMissing, matchExisting } from '../data/fill.js';
import { auditCovers, VERDICTS, VERDICT_ORDER } from '../data/coverAudit.js';
import { findDuplicates, mergePlan } from '../data/duplicates.js';
import { buildSnapshot } from '../data/snapshot.js';
import {
  storeLocalCoverOnServer, storeCoverOnServer, storeUploadedCoverOnServer,
  cachedCoverUrl, isLocalCover, hasServer, LOCAL_COVER,
} from '../data/coverCache.js';
import { coverUrlForIsbn, configureSources } from '../data/covers.js';
import { SOURCE_CHOICES, EVERY_SOURCE, PROVIDERS } from '../data/providers.js';
import { syncStatus } from '../data/sync.js';
import { addBook } from '../data/store.js';

export function renderSettings(mount) {
  const books = allBooks();
  const settings = getSettings();
  const redraw = () => renderSettings(mount);

  fill(mount, [
    el('div.view-head', {}, [
      el('div', {}, [
        el('h2.view-title', {}, 'Settings'),
        el('p.view-sub', {}, `${books.length} books \u00b7 stored in this browser`),
      ]),
    ]),

    syncSection(),
    sourcesSection(settings, redraw),
    storageSection(redraw),
    coverStorageSection(books, redraw),
    duplicatesSection(books, redraw),
    snapshotSection(),
    goalSection(books, settings, redraw),
    offlineSection(books),
    dataSection(books, redraw),
    aboutSection(),
  ]);
}

/* --- Yearly goal ---------------------------------------------------------- */

function goalSection(books, settings, redraw) {
  const goal = settings.goal ?? { type: 'books', target: null };

  const typeSelect = el('select.select', { 'aria-label': 'Goal type' }, [
    el('option', { value: 'books', selected: goal.type === 'books' }, 'Books'),
    el('option', { value: 'pages', selected: goal.type === 'pages' }, 'Pages'),
  ]);

  const targetInput = el('input.input', {
    type: 'number', min: '1', value: goal.target ?? '',
    placeholder: goal.type === 'pages' ? '12000' : '24',
    'aria-label': 'Goal target',
  });

  const save = () => {
    const target = Number.parseInt(targetInput.value, 10);
    updateSettings({
      goal: Number.isFinite(target) && target > 0 ? { type: typeSelect.value, target } : null,
    });
    toast(target > 0 ? 'Goal saved.' : 'Goal cleared.');
    redraw();
  };

  const progress = goalProgress(books, settings.goal);

  return section('Reading goal', [
    el('p.settings__hint', {}, 'A target for the year. Progress counts books you finish this calendar year.'),
    el('div.settings__row', {}, [
      targetInput,
      typeSelect,
      el('button.btn.btn--stamp.btn--sm', { type: 'button', onClick: save }, 'Save goal'),
    ]),
    progress
      ? el('p.settings__note', {},
          `${progress.done} of ${progress.target} so far \u00b7 ${progress.onTrack ? 'on pace' : `${Math.abs(progress.delta)} behind pace`}`)
      : null,
  ].filter(Boolean));
}

/* --- Where lookups go ------------------------------------------------------ */

/**
 * Which catalogue answers "what is this book" and which one supplies the art.
 *
 * Two settings rather than one because they are genuinely different questions.
 * Open Library has the page count of a 1937 printing and no picture of it;
 * Apple has a 600px cover and no idea how long it is. Forcing one choice for
 * both means picking which half of the answer to get wrong.
 */
function sourcesSection(settings, redraw) {
  const current = settings.sources ?? { metadata: EVERY_SOURCE, covers: EVERY_SOURCE };

  const pick = (name, value) =>
    el('select.select', { 'aria-label': name },
      SOURCE_CHOICES.map((choice) =>
        el('option', { value: choice.id, selected: choice.id === value }, choice.label)));

  const metadata = pick('Where details come from', current.metadata);
  const covers = pick('Where cover art comes from', current.covers);

  const hint = el('p.settings__note', { 'aria-live': 'polite' });
  const describe = () => {
    hint.textContent = [
      SOURCE_CHOICES.find((choice) => choice.id === metadata.value)?.hint,
      metadata.value === covers.value
        ? null
        : SOURCE_CHOICES.find((choice) => choice.id === covers.value)?.hint,
    ].filter(Boolean).join(' ');
  };
  metadata.addEventListener('change', describe);
  covers.addEventListener('change', describe);
  describe();

  const save = () => {
    const sources = { metadata: metadata.value, covers: covers.value };
    updateSettings({ sources });
    // The lookup layer is told directly rather than reading the store, so a
    // change takes effect on the next search instead of the next reload.
    configureSources(sources);
    toast('Lookup sources saved.');
    redraw();
  };

  return section('Where details and covers come from', [
    el('p.settings__hint', {},
      'Searches ask these catalogues. "Every source" asks all of them at once and keeps the best of each \u2014 Open Library\u2019s page counts, Google\u2019s blurbs, Apple\u2019s artwork \u2014 which is why it is the default. Narrow it if one catalogue keeps returning the wrong edition.'),
    el('div.settings__row', {}, [
      el('label.field.field--inline', {}, [el('span.field__label', {}, 'Book details'), metadata]),
      el('label.field.field--inline', {}, [el('span.field__label', {}, 'Cover art'), covers]),
      el('button.btn.btn--stamp.btn--sm', { type: 'button', onClick: save }, 'Save sources'),
    ]),
    hint,
    el('p.settings__hint', {},
      'Amazon is not on the list, and cannot be: its catalogue needs an affiliate account with qualifying sales, and the cover URLs people pass around are unsanctioned and increasingly answered with a blank image. The honest substitute is in the cover picker \u2014 right-click any cover anywhere, copy its image address, and paste it in. Dragging the image onto the book does the same thing.'),
    coversFolderNote(),
  ]);
}

/**
 * Where the cover files actually are, in words.
 *
 * "Somewhere in the browser" is not an answer anyone can act on, and the
 * answer differs depending on whether a sync server is running.
 */
function coversFolderNote() {
  const note = el('p.settings__note', { 'aria-live': 'polite' },
    hasServer()
      ? 'Checking the covers folder\u2026'
      : 'No sync server is running, so cover art is kept in this browser\u2019s image store rather than in a folder. Start the server with "npm start" and covers are written to data/covers as ordinary files.');

  if (!hasServer()) return note;

  fetch('api/covers')
    .then((response) => response.json())
    .then((body) => {
      note.textContent =
        `${body.count} cover files in data/covers, ` +
        `about ${(body.bytes / 1048576).toFixed(1)} MB. ` +
        'Each is named after its book \u2014 the-hobbit.jpg \u2014 and renamed if you edit the title. ' +
        'Drop a replacement in the folder under the same name and it is picked up on the next load.';
    })
    .catch(() => {
      note.textContent = 'The covers folder could not be read just now.';
    });

  return note;
}

/* --- Where the covers are -------------------------------------------------- */

/**
 * Which covers are files and which are only addresses.
 *
 * The question this answers cannot be answered by looking at the shelf: a
 * cover fetched live from a catalogue and a cover sitting in the folder are
 * pixel-identical until the day the catalogue stops serving it, at which point
 * one of them is gone and you find out by scrolling past a blank spine.
 */
function coverStorageSection(books, redraw) {
  const report = el('div.cover-report', {}, el('p.settings__note', {}, 'Checking\u2026'));

  const storeButton = el('button.btn.btn--stamp.btn--sm', {
    type: 'button', hidden: true,
  }, 'Save the rest to the folder');

  loadCoverAudit(books).then((audit) => {
    fill(report, [
      el('ul.cover-report__list', {}, VERDICT_ORDER.map((verdict) => {
        const count = audit.counts[verdict];
        if (!count) return null;
        return el('li.cover-report__row', { class: `is-${verdict}` }, [
          el('span.cover-report__count', {}, String(count)),
          el('div', {}, [
            el('span.cover-report__label', {}, VERDICTS[verdict].label),
            el('span.cover-report__hint', {}, VERDICTS[verdict].hint),
          ]),
          // Naming a few is worth more than a number: "which ones" is the
          // actual question behind "how many".
          count
            ? el('button.btn.btn--quiet.btn--sm', {
                type: 'button',
                onClick: () => showCoverList(verdict, audit.byVerdict[verdict]),
              }, 'Which?')
            : null,
        ].filter(Boolean));
      }).filter(Boolean)),

      audit.orphans.length
        ? el('p.settings__note', {},
            `${audit.orphans.length} files in the folder belong to no book in this library \u2014 left behind by a book deleted elsewhere, or by a library restored onto a server that kept its old folder.`)
        : null,
    ].filter(Boolean));

    if (audit.storable) {
      storeButton.hidden = false;
      storeButton.textContent = `Save ${audit.storable} more to the folder`;
      storeButton.onclick = () => storeMissingCovers(audit, storeButton, redraw);
    }
  }).catch(() => {
    fill(report, el('p.settings__note', {}, 'The covers could not be checked just now.'));
  });

  return section('Where the cover art is', [
    el('p.settings__hint', {}, hasServer()
      ? 'A cover on screen is not necessarily a cover you have. Files in the covers folder are yours; the rest are addresses that work until the catalogue serving them stops.'
      : 'No sync server is running, so there is no covers folder. Art is held in this browser and disappears with its site data. Start the server with "npm start" to keep covers as files.'),
    report,
    el('div.settings__row', {}, [storeButton]),
  ]);
}

/** Ask every source where the covers are, then classify. */
async function loadCoverAudit(books) {
  const ids = books.map((book) => book.id);
  const onDevice = await cachedIds(ids).catch(() => []);

  let files = {};
  let onServer = [];
  if (hasServer()) {
    try {
      const body = await (await fetch('api/covers')).json();
      files = body.byBook ?? {};
      onServer = Object.keys(files);
    } catch {
      /* the folder could not be read; every cover falls back to its weaker copy */
    }
  }

  return auditCovers(books, { onServer, onDevice, files, hasServer: hasServer() });
}

function showCoverList(verdict, entries) {
  const modal = showModal({
    eyebrow: 'Cover art',
    title: VERDICTS[verdict].label,
    body: [
      el('p.settings__note', {}, VERDICTS[verdict].hint),
      el('ul.plain-list', {}, entries.slice(0, 200).map((entry) =>
        el('li.plain-list__row', {}, [
          el('span', {}, entry.title),
          entry.file ? el('code.plain-list__aside', {}, entry.file) : null,
        ].filter(Boolean)))),
      entries.length > 200
        ? el('p.settings__note', {}, `\u2026and ${entries.length - 200} more.`)
        : null,
    ].filter(Boolean),
    actions: [el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Close')],
  });
}

/** Turn every linked cover into a file, one at a time. */
async function storeMissingCovers(audit, button, redraw) {
  const targets = [...audit.byVerdict.linked, ...audit.byVerdict.device];
  button.disabled = true;

  let stored = 0;
  for (const [index, entry] of targets.entries()) {
    button.textContent = `Saving ${index + 1} of ${targets.length}\u2026`;
    const book = allBooks().find((candidate) => candidate.id === entry.id);
    if (!book) continue;

    if (entry.verdict === 'device') {
      // Already bytes on this machine; send those rather than refetching a
      // URL that may no longer resolve.
      const dataUrl = await cachedCoverUrl(book.id).then((url) =>
        url ? fetch(url).then((r) => r.blob()).then(blobToDataUrl) : null
      ).catch(() => null);

      if (dataUrl && await storeUploadedCoverOnServer(book.id, dataUrl, book.title)) {
        stored += 1;
        continue;
      }
    }

    if (book.cover?.url && !isLocalCover(book.cover.url)) {
      if (await storeCoverOnServer(book.id, book.cover.url, book.title)) stored += 1;
    }
  }

  button.disabled = false;
  toast(stored
    ? `${stored} covers saved to the folder.`
    : 'None of those could be saved \u2014 the sources did not answer.');
  redraw();
}

const blobToDataUrl = (blob) => new Promise((resolve) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => resolve(null);
  reader.readAsDataURL(blob);
});

/* --- The same book twice --------------------------------------------------- */

/**
 * Find records that are the same book, and offer to fold them together.
 *
 * Merging rather than deleting, because the thing worth saving is the reading
 * log: a session is a fact about an evening and belongs to the book however
 * many records happened to be open at the time. Deleting the spare copy throws
 * that away silently, which is why "find duplicates" tools are usually more
 * dangerous than the duplicates.
 */
function duplicatesSection(books, redraw) {
  const summary = el('p.settings__note', { 'aria-live': 'polite' });

  return section('The same book twice', [
    el('p.settings__hint', {},
      'Duplicates arrive on their own \u2014 an import that ran before an ISBN was filled in, a book catalogued on two devices before sync was set up, a volume added as "Vol. 1" once and "Volume 1" the next time. The cost is a reading log split across two records, so neither one is true.'),
    el('div.settings__row', {}, [
      el('button.btn.btn--quiet.btn--sm', {
        type: 'button',
        onClick: () => {
          const groups = findDuplicates(books);
          if (!groups.length) {
            summary.textContent = `No duplicates among ${books.length} books.`;
            return;
          }
          summary.textContent = '';
          showDuplicates(groups, redraw);
        },
      }, 'Check for duplicates'),
    ]),
    summary,
  ]);
}

const REASON_TEXT = {
  isbn: 'Same ISBN \u2014 the same edition, whatever the titles say.',
  both: 'Same title and author.',
  title: 'Same title, and only one of them names an author.',
};

function showDuplicates(groups, redraw) {
  const body = el('div.dupes');

  const draw = () => {
    // Recomputed against the live library so a merged group disappears rather
    // than sitting there offering to merge records that are already gone.
    const remaining = findDuplicates(allBooks()).filter(
      (group) => !group.books.every((book) => dismissed.has(book.id))
    );

    fill(body, remaining.length
      ? remaining.map((group) => duplicateGroup(group, () => {
          draw();
          redraw();
        }))
      : el('p.settings__note', {}, 'Nothing left to merge.'));
  };

  draw();

  const modal = showModal({
    eyebrow: 'Duplicates',
    title: `${groups.length} possible ${groups.length === 1 ? 'duplicate' : 'duplicates'}`,
    body: [
      el('p.settings__note', {},
        'Merging keeps the fullest record, fills its empty fields from the others, and combines every reading session. Nothing you have already entered is overwritten.'),
      body,
    ],
    actions: [el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Done')],
  });
}

function duplicateGroup(group, done) {
  const plan = mergePlan(group.books);

  return el('div.dupes__group', {}, [
    el('p.dupes__reason', {}, REASON_TEXT[group.reason] ?? 'These look like the same book.'),
    el('ul.plain-list', {}, plan.survivor
      ? [plan.survivor, ...plan.absorbed].map((book, index) =>
          el('li.plain-list__row', { class: index === 0 ? 'is-keeping' : '' }, [
            el('span', {}, `${book.title}${book.author ? ` \u00b7 ${book.author}` : ''}`),
            el('span.plain-list__aside', {},
              [
                index === 0 ? 'kept' : 'merged in',
                `${book.sessions.length} ${book.sessions.length === 1 ? 'session' : 'sessions'}`,
              ].join(' \u00b7 ')),
          ]))
      : []),

    plan.gains.length
      ? el('p.settings__note', {}, `The kept record gains: ${plan.gains.join(', ')}.`)
      : el('p.settings__note', {}, 'The kept record already has everything the others hold.'),

    el('div.settings__row', {}, [
      el('button.btn.btn--stamp.btn--sm', {
        type: 'button',
        onClick: () => {
          const result = mergeBooks(
            plan.survivor.id,
            plan.absorbed.map((book) => book.id),
            plan.patch
          );
          toast(result.ok
            ? `Merged into ${plan.survivor.title}.`
            : Object.values(result.errors ?? {})[0] ?? 'That merge could not be applied.');
          done();
        },
      }, `Merge into "${plan.survivor.title}"`),
      el('button.btn.btn--quiet.btn--sm', {
        type: 'button',
        onClick: () => {
          // A title collision between two genuinely different books is a
          // real thing; there has to be a way to say so.
          group.books.forEach((book) => dismissed.add(book.id));
          done();
        },
      }, 'Not duplicates'),
    ]),
  ]);
}

/**
 * Groups the person has said are not duplicates.
 *
 * Session-scoped rather than stored: a persisted "ignore" list is a second
 * thing to keep in sync and to explain, and re-running the check is cheap.
 */
const dismissed = new Set();

/* --- Offline -------------------------------------------------------------- */

function offlineSection(books) {
  const status = el('p.settings__note', { 'aria-live': 'polite' }, 'Checking\u2026');
  const withArt = books.filter((book) => book.cover?.url && !book.cover.url.startsWith('data:'));

  const refresh = async () => {
    const cached = await cachedIds(withArt.map((book) => book.id));
    const size = await cacheSize();
    status.textContent =
      `${cached.size} of ${withArt.length} covers stored on this device` +
      (size ? ` \u00b7 about ${(size / 1048576).toFixed(1)} MB used` : '');
  };

  const button = el('button.btn.btn--stamp.btn--sm', {
    type: 'button',
    onClick: async () => {
      button.disabled = true;
      const result = await cacheAll(books, (done, total) => {
        status.textContent = `Storing covers\u2026 ${done} of ${total}`;
      });
      button.disabled = false;
      toast(
        result.failed
          ? `${result.cached} covers stored, ${result.failed} could not be reached.`
          : `${result.cached} covers stored for offline use.`
      );
      refresh();
    },
  }, 'Store covers offline');

  refresh();

  return section('Offline', [
    el('p.settings__hint', {},
      'Your books are already saved in this browser and work without a connection. Cover art is fetched from the internet unless you store it here. Some publishers block downloading, so a few covers may fall back to their typeset spine.'),
    el('div.settings__row', {}, [button]),
    status,
  ]);
}

/* --- Data ----------------------------------------------------------------- */

function dataSection(books, redraw) {
  const fileInput = el('input', {
    type: 'file', accept: '.json,application/json', class: 'visually-hidden',
    onChange: async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const result = importJson(text, { mode: 'merge' });
      event.target.value = '';

      if (!result.ok) {
        toast(result.error, { variant: 'error' });
        return;
      }

      toast(
        [
          `${result.added} added`,
          `${result.updated} updated`,
          result.orders ? `${result.orders} reading ${result.orders === 1 ? 'list' : 'lists'}` : null,
        ].filter(Boolean).join(', ') + '.'
      );
      redraw();

      // Cover art comes back after the books, because writing a few hundred
      // images should not hold up the thing you actually asked for.
      try {
        const parsed = JSON.parse(text);
        const { restored } = await restoreCovers(parsed, result.remapped);
        if (restored) {
          toast(`${restored} ${restored === 1 ? 'cover' : 'covers'} restored.`);
          redraw();
        }
      } catch {
        /* a backup without covers is the normal case */
      }
    },
  });

  const withCovers = el('input', { type: 'checkbox', id: 'backup-covers' });
  const exportNote = el('p.settings__note', { 'aria-live': 'polite' });

  const exportButton = el('button.btn.btn--quiet.btn--sm', {
    type: 'button',
    onClick: async () => {
      if (!withCovers.checked) {
        download(backupFilename('json'), exportJson());
        exportNote.textContent = 'Backup saved. Cover art is not inside it \u2014 tick the box to include it.';
        return;
      }

      exportButton.disabled = true;
      exportNote.textContent = 'Gathering cover art\u2026';
      try {
        const json = await exportJsonWithCovers((done, total) => {
          exportNote.textContent = `Gathering cover art\u2026 ${done} of ${total}`;
        });
        download(backupFilename('json'), json);
        exportNote.textContent = `Backup saved, ${(new Blob([json]).size / 1048576).toFixed(1)} MB with covers included.`;
      } catch (error) {
        exportNote.textContent = `The backup could not be built: ${error.message}`;
      } finally {
        exportButton.disabled = false;
      }
    },
  }, 'Export JSON');

  return section('Your data', [
    el('p.settings__hint', {},
      'JSON is the full backup and restores everything. CSV is for spreadsheets and keeps one row per book \u2014 it is lossy by design, and cannot carry your sessions or your lists.'),
    el('div.settings__row', {}, [
      exportButton,
      el('label.bulk-check', { for: 'backup-covers' }, [withCovers, el('span', {}, 'Include cover art')]),
      el('button.btn.btn--quiet.btn--sm', {
        type: 'button',
        onClick: () => download(backupFilename('csv'), exportCsv(), 'text/csv'),
      }, 'Export books CSV'),
      el('button.btn.btn--quiet.btn--sm', {
        type: 'button',
        onClick: () => download(`chapter-sessions-${backupFilename('csv').slice(-14)}`, exportSessionsCsv(), 'text/csv'),
      }, 'Export sessions CSV'),
      el('button.btn.btn--quiet.btn--sm', {
        type: 'button', onClick: () => fileInput.click(),
      }, 'Import JSON'),
      fileInput,
    ]),
    exportNote,
    el('p.settings__note', {},
      'The JSON backup carries books, reading sessions, shelves, tags, ratings, notes, reading order lists, your settings and the record of what you have deleted. Cover art is the one thing left out by default, because it makes the file many times larger; tick the box when you are moving to a new machine.'),
    el('p.settings__note', {}, 'Importing merges by title and author, so restoring a backup updates books rather than duplicating them. Reading order lists are merged the same way, by name.'),

    goodreadsRow(redraw),
    calibreRow(redraw),

    !books.length
      ? el('div.settings__row', {}, [
          el('button.btn.btn--ghost.btn--sm', {
            type: 'button',
            onClick: () => {
              replaceAll(sampleBooks());
              toast('Sample library loaded.');
              redraw();
            },
          }, 'Load a sample library'),
        ])
      : null,
  ].filter(Boolean));
}

/* --- Offline snapshot ------------------------------------------------------ */

/**
 * A file you can send to a phone and open with no network at all.
 *
 * Distinct from the JSON backup: that's for restoring, this is for reading.
 * One self-contained HTML file, covers inlined, no server required.
 */
function snapshotSection() {
  const daysSelect = el('select.select', { 'aria-label': 'How far ahead' }, [
    el('option', { value: '7' }, 'Next week'),
    el('option', { value: '14' }, 'Next fortnight'),
    el('option', { value: '30', selected: true }, 'Next month'),
    el('option', { value: '90' }, 'Next three months'),
  ]);

  const coversToggle = el('input', { type: 'checkbox', checked: true, id: 'snap-covers' });
  const status = el('p.settings__note', { 'aria-live': 'polite' });

  const button = el('button.btn.btn--stamp.btn--sm', {
    type: 'button',
    onClick: async () => {
      button.disabled = true;
      status.textContent = 'Building the file\u2026';

      try {
        const result = await buildSnapshot({
          days: Number.parseInt(daysSelect.value, 10),
          includeCovers: coversToggle.checked,
          onProgress: (done, total) => {
            status.textContent = `Gathering covers\u2026 ${done} of ${total}`;
          },
        });

        download(`chapter-plan-${new Date().toISOString().slice(0, 10)}.html`, result.html, 'text/html');
        status.textContent =
          `Saved: ${result.books} books over ${result.days} days, ` +
          `${result.covers} covers included, ${(result.bytes / 1024).toFixed(0)} KB.`;
      } catch (error) {
        status.textContent = `Could not build the file: ${error.message}`;
        toast('The snapshot could not be built.', { variant: 'error' });
      } finally {
        button.disabled = false;
      }
    },
  }, 'Export offline copy');

  return section('Take it offline', [
    el('p.settings__hint', {},
      'Saves your schedule as a single HTML file with the covers built in. Send it to your phone and open it from Files \u2014 no network, no server, nothing to install. It is read-only: a copy you could edit would be a second library with no way to merge it back.'),
    el('div.settings__row', {}, [
      daysSelect,
      el('label.bulk-check', { for: 'snap-covers' }, [coversToggle, el('span', {}, 'Include covers')]),
      button,
    ]),
    status,
    el('p.settings__note', {},
      'Covers make the file much larger. Without them it is a few kilobytes and sends anywhere.'),
  ]);
}

/* --- Sync ----------------------------------------------------------------- */

function syncSection() {
  const status = syncStatus();

  const copy = {
    local: {
      verdict: 'This browser only',
      detail:
        'No sync server is running, so the library lives in this browser and nowhere else. Another device opening the same address gets its own separate library. Run "npm start" instead of a plain static server to share one library across devices.',
      tone: 'is-local',
    },
    syncing: {
      verdict: 'Shared with every device on your network',
      detail:
        'A sync server is running. Changes made here appear on your other devices within a second, and theirs appear here. Each device also keeps its own copy, so going offline changes nothing until you reconnect.',
      tone: 'is-ok',
    },
    offline: {
      verdict: 'Working offline',
      detail:
        'The sync server cannot be reached right now. Everything still works and is saved in this browser; it will merge back when the server returns.',
      tone: 'is-failing',
    },
  }[status.mode];

  const time = status.lastSyncedAt
    ? status.lastSyncedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  return section('Other devices', [
    el('p.storage-verdict', { class: copy.tone }, [
      el('span.save-status__dot', { 'aria-hidden': 'true' }),
      copy.verdict,
    ]),
    el('p.settings__hint', {}, copy.detail),
    time ? el('p.settings__note', {}, `Last synced at ${time}.`) : null,
    status.error ? el('p.settings__note', {}, status.error) : null,
  ].filter(Boolean));
}

/* --- Storage -------------------------------------------------------------- */

function storageSection(redraw) {
  const status = storageStatus();
  const kb = (status.bytes / 1024).toFixed(1);
  // localStorage is around 5MB in every browser that matters.
  const percent = Math.min(100, Math.round((status.bytes / (5 * 1024 * 1024)) * 100));

  const persistNote = el('p.settings__note', { 'aria-live': 'polite' },
    'Browsers may clear site data when storage runs low.');

  navigator.storage?.persisted?.().then((already) => {
    if (already) persistNote.textContent = 'This browser has marked your library as persistent.';
  }).catch(() => null);

  return section('Is my library saved?', [
    el('p.storage-verdict', { class: status.saved ? 'is-ok' : 'is-failing' }, [
      el('span.save-status__dot', { 'aria-hidden': 'true' }),
      status.saved
        ? `Yes \u2014 ${status.books} books are written to this browser.`
        : 'No \u2014 changes are not reaching storage in this browser.',
    ]),
    el('dl.storage-facts', {}, [
      storageFact('Where', 'This browser, on this device'),
      storageFact('Under the key', status.key),
      storageFact('Size', `${kb} KB of about 5 MB (${percent}%)`),
      storageFact('Last written', status.lastSavedAt
        ? status.lastSavedAt.toLocaleString()
        : 'Not yet this session'),
    ]),
    el('p.settings__hint', {},
      'To check it yourself: open developer tools, go to Application, then Local Storage. Or close the browser entirely, reopen it, and see that your books are still here \u2014 that is the same test that matters.'),
    el('div.settings__row', {}, [
      reclaimButton(redraw),
      el('button.btn.btn--quiet.btn--sm', {
        type: 'button',
        onClick: async () => {
          const granted = await requestPersistentStorage();
          toast(granted
            ? 'This browser will now keep your library through storage pressure.'
            : 'The browser declined. Data is still saved, just evictable under pressure.');
          redraw();
        },
      }, 'Ask browser to keep this data'),
    ]),
    persistNote,
  ]);
}

/**
 * The fix for a full browser store.
 *
 * An uploaded cover kept as base64 inside the library record costs roughly a
 * third more than the image itself and counts against a ~5 MB budget shared
 * with every book you own. Moving those images to the image store is almost
 * always the whole problem.
 */
function reclaimButton(redraw) {
  const button = el('button.btn.btn--stamp.btn--sm', {
    type: 'button',
    onClick: async () => {
      button.disabled = true;
      const books = allBooks();
      const heavy = books.filter((book) => book.cover?.url?.startsWith('data:')).length;

      const { moved, freedBytes, ids } = await evacuateDataUrls(books);
      for (const id of ids) {
        updateBook(id, { cover: { url: 'local:cover', source: 'upload' } });
      }
      button.disabled = false;

      toast(
        moved
          ? `Moved ${moved} ${moved === 1 ? 'cover' : 'covers'} out of browser storage, freeing about ${Math.round(freedBytes / 1024)} KB. Nothing was lost.`
          : heavy
            ? 'Those covers could not be moved — this browser is blocking its image store.'
            : 'Nothing to reclaim; no images are being kept in browser storage.'
      );
      redraw();
    },
  }, 'Reclaim space');

  return button;
}

const storageFact = (label, value) =>
  el('div.storage-facts__row', {}, [el('dt', {}, label), el('dd', {}, value)]);

/* --- Goodreads ------------------------------------------------------------ */

function goodreadsRow(redraw) {
  const summary = el('p.settings__note', { 'aria-live': 'polite' });

  const fileInput = el('input', {
    type: 'file',
    accept: '.csv,text/csv',
    class: 'visually-hidden',
    onChange: async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      summary.textContent = 'Reading that export\u2026';
      const parsed = parseGoodreadsCsv(await file.text());

      if (!parsed.ok) {
        summary.textContent = parsed.error;
        toast(parsed.error, { variant: 'error' });
        return;
      }

      // Never drop hundreds of books in unannounced; show what's there first.
      confirmImport(parsed, summary, redraw);
    },
  });

  return el('div', {}, [
    el('h4.settings__subhead', {}, 'From Goodreads'),
    el('p.settings__hint', {},
      'On Goodreads: My Books, then Import and Export, then Export Library. Upload the CSV here. Shelves, ratings, reviews, read dates and page counts all come across; cover art is fetched separately.'),
    el('div.settings__row', {}, [
      el('button.btn.btn--quiet.btn--sm', { type: 'button', onClick: () => fileInput.click() },
        'Import Goodreads CSV'),
      fileInput,
    ]),
    summary,
  ]);
}

/* --- Calibre --------------------------------------------------------------- */

function calibreRow(redraw) {
  const summary = el('p.settings__note', { 'aria-live': 'polite' });

  const fileInput = el('input', {
    type: 'file', accept: '.csv,text/csv', class: 'visually-hidden',
    onChange: async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      summary.textContent = 'Reading that catalogue\u2026';
      const parsed = parseCalibreCsv(await file.text());

      if (!parsed.ok) {
        summary.textContent = parsed.error;
        toast(parsed.error, { variant: 'error' });
        return;
      }
      confirmCalibre(parsed, summary, redraw);
    },
  });

  return el('div', {}, [
    el('h4.settings__subhead', {}, 'From Calibre'),
    el('p.settings__hint', {},
      'In Calibre: select your books, then Convert books \u2192 Create a catalogue, and choose CSV. Tick every field you want carried across \u2014 comments is the one that holds your descriptions. New books arrive unscheduled, since a Calibre catalogue records what you own rather than what you have read.'),
    el('p.settings__hint', {},
      'Importing the same catalogue again is safe and useful: books already here keep everything you have entered and only gain the fields they are missing. Write descriptions into Calibre, export again, and they arrive.'),
    el('p.settings__hint', {},
      hasServer()
        ? 'The sync server is running, so cover art will be copied straight from the paths in the catalogue \u2014 no lookups needed.'
        : 'Covers will be looked up by ISBN. Run the app with "npm start" instead and they can be copied directly from the paths in the catalogue.'),
    el('div.settings__row', {}, [
      el('button.btn.btn--quiet.btn--sm', { type: 'button', onClick: () => fileInput.click() },
        'Import Calibre CSV'),
      fileInput,
    ]),
    summary,
  ]);
}

/**
 * Preview a Calibre catalogue, then import it.
 *
 * A book already in the library is no longer skipped. Skipping was the safe
 * answer and the wrong one: re-exporting a catalogue after an evening of
 * writing descriptions into Calibre is *because* the books are already here.
 * Matched books get their empty fields filled and nothing else touched.
 */
function confirmCalibre(parsed, summary, redraw) {
  const { books, paths, authors, skipped, withCovers, withIsbn, withDescriptions } = parsed;

  // Worked out before the dialog opens so the button can say what will happen
  // rather than how many rows are in the file.
  const plan = books.map((book) => {
    const incoming = { ...book, authors: authors.get(book.id) ?? [] };
    const match = matchExisting(allBooks(), incoming);
    if (!match) return { book, incoming, action: 'add' };

    const hasCover = Boolean(match.cover?.url);
    const { patch, filled } = fillMissing(match, incoming, {
      cover: Boolean(paths.get(book.id)) || Boolean(book.isbn),
    });

    return {
      book, incoming, match, patch, filled,
      action: filled.length ? 'fill' : 'complete',
      needsCover: !hasCover,
    };
  });

  const additions = plan.filter((entry) => entry.action === 'add');
  const fills = plan.filter((entry) => entry.action === 'fill');
  const complete = plan.filter((entry) => entry.action === 'complete');

  // Which fields, across all of them — "12 books will gain a description" is
  // a far more useful sentence than "12 books will be updated".
  const fieldCounts = new Map();
  for (const entry of fills) {
    for (const label of entry.filled) {
      fieldCounts.set(label, (fieldCounts.get(label) ?? 0) + 1);
    }
  }
  const fieldSummary = [...fieldCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${count} \u00d7 ${label}`)
    .join(', ');

  const series = new Set(books.map((book) => book.series.name).filter(Boolean)).size;

  const modal = showModal({
    eyebrow: 'Calibre catalogue',
    title: `${books.length} books found`,
    body: [
      el('p', {}, `${series} series detected, ${withIsbn} with an ISBN, ${withDescriptions} with a description, ${withCovers} with a cover on disk.`),

      additions.length
        ? el('p', {}, `${additions.length} will be added as ${additions.length === 1 ? 'a new record' : 'new records'}.`)
        : null,

      fills.length
        ? el('div', {}, [
            el('p', {}, `${fills.length} ${fills.length === 1 ? 'is' : 'are'} already in your library and will have their empty fields filled in.`),
            el('p.settings__note', {}, `Filling: ${fieldSummary}.`),
            el('p.settings__note', {},
              'Only empty fields are written. Anything you have already typed \u2014 a corrected length, a description you rewrote, a status, a schedule \u2014 is left exactly as it is.'),
          ])
        : null,

      complete.length
        ? el('p.settings__note', {}, `${complete.length} ${complete.length === 1 ? 'is' : 'are'} already complete and will not be touched.`)
        : null,

      !withDescriptions
        ? el('p.settings__note', {},
            'No descriptions in this catalogue. Tick the comments field in Calibre\u2019s catalogue options before exporting, and they will come across.')
        : null,

      el('p.settings__note', {},
        'Calibre catalogues carry no page count, so lengths arrive empty. Pacing and progress need a length, so add one to any book you plan to schedule \u2014 an ISBN lookup on the record will fetch it.'),

      skipped ? el('p.settings__note', {}, `${skipped} rows had no title and will be ignored.`) : null,
    ].filter(Boolean),
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn--stamp', {
        type: 'button',
        disabled: !additions.length && !fills.length,
        onClick: async () => {
          modal.close();
          let added = 0;
          let updated = 0;
          let fieldsFilled = 0;
          const queued = [];

          for (const entry of plan) {
            const coverPath = paths.get(entry.book.id);
            // An ISBN gives a usable cover URL without a lookup round trip.
            const coverUrl = entry.book.isbn ? coverUrlForIsbn(entry.book.isbn, 'L') : null;

            if (entry.action === 'add') {
              const result = addBook(
                coverUrl ? { ...entry.book, cover: { url: coverUrl, source: 'openlibrary' } } : entry.book
              );
              if (!result.ok) continue;

              added += 1;
              queued.push({
                id: result.book.id, title: result.book.title, path: coverPath, url: coverUrl,
              });
              continue;
            }

            if (entry.action === 'fill') {
              const result = updateBook(entry.match.id, entry.patch);
              if (result.ok) {
                updated += 1;
                fieldsFilled += entry.filled.length;
              }
            }

            // A book already here but with no art still wants the cover this
            // catalogue can point at, whether or not any text field was empty.
            if (entry.needsCover && (coverPath || coverUrl)) {
              queued.push({
                id: entry.match.id, title: entry.match.title, path: coverPath, url: coverUrl,
              });
            }
          }

          summary.textContent = added || updated
            ? `${added} added, ${updated} filled in. Fetching covers\u2026`
            : 'Fetching covers\u2026';
          redraw();

          // Covers are stored one at a time after the books land, so a slow
          // disk or a rate-limited lookup never blocks the import itself.
          let stored = 0;
          for (const entry of queued) {
            const fromDisk = entry.path
              ? await storeLocalCoverOnServer(entry.id, entry.path, entry.title)
              : false;

            if (fromDisk) {
              // Record that the art exists, or a book with no ISBN would have
              // a cover on the server and a blank field saying it has none.
              updateBook(entry.id, { cover: { url: LOCAL_COVER, source: 'upload' } });
              stored += 1;
              continue;
            }
            if (entry.url && await storeCoverOnServer(entry.id, entry.url, entry.title)) stored += 1;
          }

          summary.textContent = [
            added ? `${added} books added` : null,
            updated ? `${updated} books filled in (${fieldsFilled} fields)` : null,
            stored ? `${stored} covers stored` : null,
          ].filter(Boolean).join(', ') + '.';

          toast(
            added && updated
              ? `${added} added, ${updated} filled in from Calibre.`
              : updated
                ? `${updated} books filled in from Calibre.`
                : `${added} books imported from Calibre.`
          );
          redraw();
        },
      },
        additions.length && fills.length
          ? `Add ${additions.length}, fill ${fills.length}`
          : fills.length
            ? `Fill in ${fills.length} books`
            : `Import ${additions.length} books`),
    ],
  });
}

function confirmImport(parsed, summary, redraw) {
  const { books, counts, skipped, source } = parsed;
  const breakdown = Object.entries(counts)
    .map(([status, count]) => `${count} ${STATUS_WORD[status] ?? status}`)
    .join(', ');

  const existing = new Set(
    allBooks().map((book) => `${book.title.toLowerCase()}|${book.author.toLowerCase()}`)
  );
  const duplicates = books.filter((book) =>
    existing.has(`${book.title.toLowerCase()}|${book.author.toLowerCase()}`)
  ).length;

  const modal = showModal({
    eyebrow: `${source} export`,
    title: `${books.length} books found`,
    body: [
      el('p', {}, breakdown ? `That breaks down as ${breakdown}.` : 'No status information found.'),
      duplicates
        ? el('p', {}, `${duplicates} of them are already in your library and will be skipped, not duplicated.`)
        : null,
      skipped
        ? el('p.settings__note', {}, `${skipped} rows had no title and will be ignored.`)
        : null,
      el('p.settings__note', {},
        'Imported books arrive unscheduled, so nothing lands on your calendar until you plan it.'),
    ].filter(Boolean),
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn--stamp', {
        type: 'button',
        onClick: () => {
          let added = 0;
          for (const book of books) {
            const key = `${book.title.toLowerCase()}|${book.author.toLowerCase()}`;
            if (existing.has(key)) continue;
            if (addBook(book).ok) {
              existing.add(key);
              added += 1;
            }
          }
          modal.close();
          summary.textContent = `Imported ${added} books${duplicates ? `, skipped ${duplicates} already present` : ''}.`;
          toast(`${added} books imported.`);
          redraw();
        },
      }, `Import ${books.length - duplicates} books`),
    ],
  });
}

const STATUS_WORD = {
  finished: 'finished',
  reading: 'currently reading',
  planned: 'to read',
  dnf: 'not finished',
  'on-hold': 'on hold',
};

function aboutSection() {
  return section('A warning worth reading', [
    el('p.settings__hint', {},
      'Everything lives in this browser and nowhere else. Clearing site data, using a private window, or opening the app from a different address or port will not show this library. Export a JSON backup before doing any of those.'),
  ]);
}

const section = (title, children) =>
  el('section.settings-block.slip.slip--plain', {}, [
    el('h3.settings-block__title', {}, title),
    ...children,
  ]);
