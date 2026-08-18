# BookTracker-Chapter
A reading tracker. Helps to sort your books, plan them onto a calendar, and see your reading plan day by day.

## Running it

No build step, no dependencies — but there are two ways to run it, and they
behave differently.

**Shared across your devices (recommended):**

```bash
npm start        # node server.mjs
```

It prints both a localhost address and a LAN address. Open the LAN one on your
phone (`http://192.168.x.x:8080`) and you get the *same* library, syncing live
in both directions. The library and cover art are stored in `./data` on the
machine running the server.

**Static, single browser:**

```bash
npm run static   # python3 -m http.server 8080
```

The library lives in that one browser and goes no further. Another device
opening the same address gets its own separate, empty library — that isn't a
bug, it's what browser storage is.

Tests are node's built-in runner, also dependency-free:

```bash
npm test
```

## Where things live

```
index.html            app shell
css/tokens.css        design tokens — palette, type, spacing, motion
css/base.css          reset, typography, shell layout
css/components.css    buttons, fields, slips, modal, chips, covers
css/covers.css        cover picker
css/library.css       record lists
css/calendar.css      month grid, day cells, cover tiles
css/dayview.css       hover card and day popup
css/sessions.css      reading log
css/stats.css         stats, settings, day view, tags, ratings
js/app.js             bootstrap + hash router
js/lib/dom.js         element helper, focus trap, toasts
js/lib/dates.js       day-key arithmetic and the month grid
js/data/schema.js     the Book record: defaults, normalise, validate
js/data/store.js      persistence, migrations, CRUD, pub/sub
js/data/covers.js     Open Library + Google Books lookup, upload downscaling
js/data/seed.js       sample library for demos
js/logic/schedule.js  which books land on which day, in which state
js/logic/pacing.js    daily targets, ahead/behind, projected finish
js/logic/sessions.js  session totals, reading streak, observed pace
js/logic/stats.js     monthly rollups, breakdowns, goal progress
js/lib/charts.js      hand-rolled SVG charts (no chart library)
js/data/coverCache.js IndexedDB store for offline cover art
js/data/transfer.js   JSON and CSV export, merge-aware import
sw.js                 service worker: offline app shell
js/views/             one module per view
tests/                data-layer tests
```

## Using the calendar

Each day holds up to six cover tiles at full width, dropping to four and then
three on narrower screens. Tiles are packed into rows by count — one fills the
whole day, three span it in a single row, four make a 2x2, five sit 3 above a
centred 2, six stack 3 and 3 — and every row is sized from the cell's height,
so no layout leaves a gap where a book isn't.

Clicking a day opens the popup; clicking the date number opens the full Day
view. Two weights of the same gesture, so a quick look doesn't cost a page.

The board is sized from an explicit `--board-height` token rather than
stretching to fit its contents. That is load-bearing, not cosmetic: a tile
derives its width from its height, and that only resolves if some ancestor has
a *definite* height. Without one the browser falls back to content sizing, the
covers size themselves from the column width, and the calendar becomes seven
very tall columns. `tests/layout.test.js` guards the rules that keep the chain
resolvable.

- **Hover or focus a cover** for what that day asks of you: a 700-page book
  planned Sunday to Saturday reads "100 pages to read today", with the plan's
  shape underneath.
- **Click a day** for every book on it, with targets, current standing, and
  inline progress logging.
- **Drag a cover to another day** to move its plan, keeping the same length.
  Keyboard equivalent: focus a cover and press Shift + arrow keys — left and
  right shift by a day, up and down by a week.

Daily targets are computed cumulatively rather than as a flat rate. 448 pages
over 11 days is 40.72 a day; a flat rounded 41 would drift you past the end of
the book. Targets are the difference between two points on the cumulative
curve, so rounding self-corrects and the daily numbers always sum to exactly
the page count.

## Logging what you read

A session is one sitting: a date, minutes, and optionally the pages it covered.
Log one from a book's record for the full history, or from the day popup to
date it to that day automatically. Logging moves a planned book to reading and
backdates its start to the earliest sitting, because that is when it actually
began.

Progress follows the furthest page ever logged rather than the most recent
session, so backdating a sitting you forgot doesn't drag your progress
backwards.

The streak counts consecutive days with any logged reading, across the whole
library. It is deliberately forgiving: today counts as unbroken until the day
is over, so the number doesn't reset every morning and read as a telling-off
before you've had a chance to open a book. Two silent days ends it.

## Progress and pace

Everything on the progress strip is derived, never entered. How far in you are
comes from the furthest page in the log; the rate comes from pages logged over
days *elapsed* rather than days read, because skipped days are part of how long
a book really takes; the projected finish follows that rate; and the verdict
compares it against the date you planned for. When the log has minutes in it,
the remaining time is estimated from the minutes-per-page you're actually
reading at.

The rule that progress equals the furthest logged page is enforced in
`normalizeBook`, not on the store's write path, so a record loaded from disk or
imported from a backup can never disagree with its own sessions.

## Using it on your phone

`localStorage` is scoped to one browser on one device. Two devices opening the
same URL do not share anything, and no amount of client-side code changes that
— so `server.mjs` exists to hold the one shared copy.

Each device still keeps its own full copy and reads from it, so the app stays
usable with the server unreachable; changes merge back on reconnect.

**Merging is per record, by `updatedAt`.** Last-write-wins on the whole library
would mean a phone holding a five-minute-old copy could silently erase an hour
of work done on the laptop. Deletions leave tombstones, kept 90 days, because
otherwise a device that never saw the delete would push the book straight back.
Edit the same book on two devices within the same second and the later
timestamp wins — that case is genuinely lost, and it's the one thing this
design does not solve.

The server is plain HTTP with no authentication. It is meant for your own
network. Don't port-forward it.

## Is my library actually saved?

The header carries a live indicator, and Settings has a panel that answers it
properly: how many books are written, under which storage key, how many
kilobytes of the roughly 5 MB budget they occupy, and when the last write
happened. The indicator turns red the moment a write fails, which is the only
time it matters.

To check independently: developer tools, Application, Local Storage. Or just
quit the browser, reopen it, and see that the books are still there.

Settings can also ask the browser to mark the data persistent, which reduces
the chance of eviction under storage pressure. Browsers usually decline unless
the site is installed or frequently used; the data is saved either way.

## Working offline

Two separate mechanisms, because they solve different halves of the problem:

- **The app itself** is precached by a service worker (`sw.js`), so the page
  loads with no network. The shell is served network-first, so an update is
  never masked by a stale cache; images stay cache-first, since they don't
  change. Bump `CACHE_VERSION` when you ship changes.
- **Cover art** has three sources, tried in order: the browser's own stored
  copy, the sync server's copy, then the original host. Each failure falls
  through to the next and the typeset spine catches anything left.

  The server matters here. A browser cannot store an image from a host that
  sends no CORS headers, and most cover hosts don't — which is why covers
  didn't reliably persist before. The server has no such restriction: it
  fetches each cover once, keeps it in `data/covers`, and serves it to every
  device afterwards. Settings has a button to store them all.

  Covers are also warmed from storage before the first paint, which is the
  difference between covers that work offline and covers that merely exist
  offline.

Records themselves were always offline — they live in this browser's local
storage. Clearing site data erases the library, so Settings has JSON export.

## Importing from Goodreads

Goodreads: My Books, then Import and Export, then Export Library. Upload the
CSV in Settings. Titles, authors, ISBNs, page counts, ratings, reviews,
shelves, read dates and formats all come across; a re-read count becomes a
note. Books arrive unscheduled, so nothing lands on your calendar until you
plan it, and anything already in your library is skipped rather than
duplicated. You see a summary and confirm before anything is written.

The parser handles Goodreads' quirks: ISBNs wrapped as `="9780486266848"` to
stop spreadsheets eating leading zeros, reviews containing line breaks,
US-formatted dates, and the byte-order mark Excel adds. StoryGraph exports
mostly work too, since columns are matched by alias.

## Two decisions worth knowing about

**Dates are local day keys (`YYYY-MM-DD`), never timestamps.** A reading day is
a human day. Storing instants is how a book scheduled for the 4th shows up on
the 3rd for someone in a different zone. All arithmetic goes through
`js/lib/dates.js`.

**A book carries a plan and a record, separately.** `schedule.{start,end}` is
what you intended; `actual.{startedAt,finishedAt}` is what happened. Keeping
them apart is what lets the calendar distinguish planned from in-progress from
finished-that-day, and what lets pacing tell you whether you're behind.