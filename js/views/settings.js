/**
 * Settings: the yearly goal, offline storage, and getting your data out.
 *
 * Export sits here rather than behind a menu because a backup nobody can find
 * is a backup nobody takes.
 */

import { el, fill, toast } from '../lib/dom.js';
import { allBooks, getSettings, updateSettings, replaceAll } from '../data/store.js';
import { exportJson, exportCsv, exportSessionsCsv, importJson, download, backupFilename } from '../data/transfer.js';
import { cacheAll, cachedIds, cacheSize } from '../data/coverCache.js';
import { goalProgress } from '../logic/stats.js';
import { sampleBooks } from '../data/seed.js';

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
      toast(`Imported: ${result.added} added, ${result.updated} updated.`);
      redraw();
    },
  });

  return section('Your data', [
    el('p.settings__hint', {},
      'JSON is the full backup and restores everything, including your reading log. CSV is for spreadsheets and keeps one row per book.'),
    el('div.settings__row', {}, [
      el('button.btn.btn--quiet.btn--sm', {
        type: 'button',
        onClick: () => download(backupFilename('json'), exportJson()),
      }, 'Export JSON'),
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
    el('p.settings__note', {}, 'Importing merges by title and author, so restoring a backup updates books rather than duplicating them.'),

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

function aboutSection() {
  return section('Where your data lives', [
    el('p.settings__hint', {},
      'Records are kept in this browser\u2019s local storage, and stored covers in its database. Nothing is sent anywhere. Clearing site data for this address erases the library, so export a backup before you do.'),
  ]);
}

const section = (title, children) =>
  el('section.settings-block.slip.slip--plain', {}, [
    el('h3.settings-block__title', {}, title),
    ...children,
  ]);
