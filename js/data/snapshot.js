/**
 * Offline snapshot export.
 *
 * A single self-contained HTML file: open it from a phone's Files app with no
 * network, no server, and no app installed, and read the schedule.
 *
 * Everything is inlined — styles, data, covers as data URLs — because a file
 * sent over a messaging app arrives on its own. A page that referenced
 * `css/base.css` would render as unstyled text on the other device, which is
 * the failure this exists to avoid.
 *
 * It is deliberately read-only. A snapshot you could edit would be a second
 * copy of the library with no way to merge it back, and the first thing anyone
 * would do is edit it.
 */

import { allBooks } from './store.js';
import { entriesForDay, DAY_STATE_LABEL } from '../logic/schedule.js';
import { paceFor } from '../logic/pacing.js';
import { today, addDays, formatLong, formatShort, eachDay } from '../lib/dates.js';
import { formatUnit } from './schema.js';
import { kindLabel } from './kinds.js';
import { cachedCoverUrl, serverCoverUrl, LOCAL_COVER } from './coverCache.js';

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Read a book's cover back out as bytes.
 *
 * Needed by anything that has to carry an image somewhere else — the offline
 * snapshot, and the full backup. `cover.url` is not enough on its own: an
 * uploaded cover's URL is the sentinel `local:cover`, which means nothing
 * outside this browser, and a fetched cover's URL points at a host that may
 * not exist by the time the backup is restored.
 *
 * Sources in order of what will still work later: the browser's own stored
 * copy, then the server's, then the original host.
 *
 * @param {object} book
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<string|null>} a data URL, or null if there is nothing to read
 */
export async function coverAsDataUrl(book, { maxBytes = 400 * 1024 } = {}) {
  try {
    const local = await cachedCoverUrl(book.id);
    const source = local ?? serverCoverUrl(book.id) ?? book.cover?.url;
    if (!source || source === LOCAL_COVER) return null;

    const response = await fetch(source);
    if (!response.ok) return null;

    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) return null;
    if (blob.size > maxBytes) return null;

    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** A blob URL is useless in another document; covers must be real bytes. */
async function inlineCover(book, { includeCovers }) {
  if (!includeCovers) return null;
  return coverAsDataUrl(book);
}

/**
 * Build the snapshot.
 *
 * @param {Object} options
 * @param {number} [options.days] - how far ahead to include
 * @param {boolean} [options.includeCovers]
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<{html: string, days: number, books: number, bytes: number}>}
 */
export async function buildSnapshot({ days = 30, includeCovers = true, onProgress } = {}) {
  const todayKey = today();
  const from = todayKey;
  const to = addDays(todayKey, days - 1);
  const books = allBooks();

  const dayKeys = eachDay(from, to);
  const schedule = dayKeys.map((key) => ({
    key,
    entries: entriesForDay(books, key, todayKey),
  }));

  // Only books that actually appear in the window get carried.
  const needed = new Map();
  for (const day of schedule) {
    for (const { book } of day.entries) needed.set(book.id, book);
  }

  const covers = new Map();
  let done = 0;
  for (const book of needed.values()) {
    const dataUrl = await inlineCover(book, { includeCovers });
    if (dataUrl) covers.set(book.id, dataUrl);
    done += 1;
    onProgress?.(done, needed.size);
  }

  const html = renderSnapshot({ schedule, covers, todayKey, from, to });

  return {
    html,
    days,
    books: needed.size,
    covers: covers.size,
    bytes: new Blob([html]).size,
  };
}

/**
 * The snapshot is the schedule and nothing else.
 *
 * Reading orders were in here and shouldn't be: they are a planning tool, not
 * something you consult on a train, and appending a list of every book in every
 * order after the days doubled the file for content nobody was going to read
 * offline.
 */
function renderSnapshot({ schedule, covers, todayKey, from, to }) {
  const dayCards = schedule
    .filter((day) => day.entries.length)
    .map((day) => renderDay(day, covers, todayKey))
    .join('\n');

  const scheduled = schedule.filter((day) => day.entries.length).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Chapter — reading plan from ${formatLong(from)}</title>
<style>${SNAPSHOT_CSS}</style>
</head>
<body>
<header class="head">
  <h1>Chapter</h1>
  <p class="sub">${formatLong(from)} &ndash; ${formatLong(to)} &middot; ${scheduled} days with reading</p>
  <p class="note">A read-only snapshot taken ${formatLong(todayKey)}. Nothing here syncs back.</p>
</header>
<main>
${dayCards || '<p class="empty">Nothing scheduled in this window.</p>'}
</main>
</body>
</html>`;
}

function renderDay(day, covers, todayKey) {
  const isToday = day.key === todayKey;

  const cards = day.entries.map(({ book, state }) => {
    const pace = paceFor(book, day.key, todayKey);
    const unit = formatUnit(book);
    const cover = covers.get(book.id);

    const art = cover
      ? `<img src="${cover}" alt="">`
      : `<div class="spine"><b>${escapeHtml(book.title)}</b><i>${escapeHtml(book.author)}</i></div>`;

    const target = pace.ok && pace.inPlan
      ? `<p class="target">${pace.todayTarget} ${unit} due</p>
         <p class="meta">Day ${Math.min(Math.max(pace.dayIndex, 1), pace.days)} of ${pace.days} &middot; to ${unit === 'minutes' ? '' : 'page '}${pace.cumulative}</p>`
      : `<p class="meta">${escapeHtml(pace.reason || DAY_STATE_LABEL[state])}</p>`;

    return `<article class="card ${state}">
      <div class="art">${art}</div>
      <div class="body">
        <p class="state">${DAY_STATE_LABEL[state]} &middot; ${escapeHtml(kindLabel(book.category))}</p>
        <h3>${escapeHtml(book.title)}</h3>
        <p class="author">${escapeHtml(book.author || 'Unknown author')}</p>
        ${target}
      </div>
    </article>`;
  }).join('');

  return `<section class="day${isToday ? ' is-today' : ''}">
    <h2>${formatShort(day.key)}${isToday ? ' <span class="today">today</span>' : ''}</h2>
    <div class="cards">${cards}</div>
  </section>`;
}

/**
 * Inlined stylesheet.
 *
 * A pared-down copy of the app's tokens rather than the real sheets: the
 * snapshot has no interaction, so most of the CSS would be dead weight in a
 * file meant to travel over a messaging app.
 */
const SNAPSHOT_CSS = `
:root{--bg:#1b2c3b;--lift:#24394b;--edge:#142230;--slip:#f3f0e8;--ink:#171c22;
--ink-soft:#515a63;--inv:#f1f4f7;--inv-soft:#a5bacb;--stamp:#9db4f7;
--reading:#e0aa4c;--planned:#8fa6f2;--finished:#6fb495;
--slip-font:"Courier New",ui-monospace,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--inv);
font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5;
-webkit-font-smoothing:antialiased}
.head{padding:20px 16px 16px;border-bottom:1px solid rgba(241,244,247,.14);background:var(--lift)}
.head h1{margin:0;font-family:Georgia,serif;font-size:26px;font-weight:500}
.sub{margin:4px 0 0;font-family:var(--slip-font);font-size:12px;letter-spacing:.08em;
text-transform:uppercase;color:var(--inv-soft)}
.note{margin:8px 0 0;font-size:12px;color:var(--inv-soft);opacity:.8}
main{padding:16px;max-width:900px;margin:0 auto}
.day{margin-bottom:24px}
.day h2{font-family:var(--slip-font);font-size:12px;letter-spacing:.14em;text-transform:uppercase;
color:var(--inv-soft);margin:0 0 8px;padding-bottom:6px;
border-bottom:1px solid rgba(241,244,247,.12)}
.day.is-today h2{color:var(--stamp)}
.today{background:rgba(157,180,247,.2);border:1px solid var(--stamp);border-radius:2px;
padding:1px 5px;margin-left:6px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.card{display:flex;gap:12px;background:var(--edge);border-radius:3px;padding:10px;
border-left:3px solid transparent;min-width:0}
.card.reading{border-left-color:var(--reading)}
.card.planned{border-left-color:var(--planned)}
.card.finished{border-left-color:var(--finished)}
.art{flex:none;width:56px;height:84px;border-radius:2px;overflow:hidden;background:#2b4257}
.art img{width:100%;height:100%;object-fit:cover;display:block}
.spine{width:100%;height:100%;padding:6px;display:flex;flex-direction:column;
justify-content:space-between;background:#2b4257}
.spine b{font-family:Georgia,serif;font-size:10px;line-height:1.15;overflow:hidden}
.spine i{font-family:var(--slip-font);font-style:normal;font-size:8px;opacity:.7;overflow:hidden}
.body{min-width:0;flex:1}
.body h3{margin:2px 0;font-family:Georgia,serif;font-weight:500;font-size:15px;line-height:1.2}
.state{margin:0;font-family:var(--slip-font);font-size:9px;letter-spacing:.1em;
text-transform:uppercase;color:var(--inv-soft)}
.author{margin:0;font-size:12px;color:var(--inv-soft)}
.target{margin:6px 0 0;font-family:var(--slip-font);font-size:13px;color:var(--stamp)}
.meta{margin:2px 0 0;font-size:11px;color:var(--inv-soft);opacity:.85}
.empty{color:var(--inv-soft);text-align:center;padding:40px 0}
@media(max-width:520px){.cards{grid-template-columns:1fr}main{padding:12px}}
`;
