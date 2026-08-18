# BookTracker-Chapter
A reading tracker. Helps to sort your books, plan them onto a calendar, and see your reading plan day by day.

## Running it

No build step, no dependencies — but there are two ways to run it, and they
behave differently.

**Shared across your devices (recommended):**

```bash
npm start        # node server.mjs, port 8090
```

It prints both a localhost address and a LAN address. Open the LAN one on your
phone (`http://192.168.x.x:8090`) and you get the *same* library, syncing live
in both directions.

If 8090 is taken, pick another: `npm start -- --port 8091`. The library and cover art are stored in `./data` on the
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

## A warning about changing the address

Browser storage is scoped to the exact origin — protocol, host *and* port. A
library built at `localhost:8080` is invisible at `localhost:8090`. Same
machine, same browser, same files; different storage.

So before changing ports, open the old address, go to Settings, and Export
JSON. Then import that file at the new one. Once you are running `npm start`,
the library lives in `./data` on disk and this stops being a concern, since
every device reads the same copy.

The server says as much on first run when it finds no library.

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

## What dragging a cover does

Dragging a cover to another day moves the **whole plan and keeps its length**: a
seven-day plan dropped on the 14th becomes the 14th to the 20th. It does not
move only the start, and it does not stretch the plan. If the book lands outside
the month on screen, the calendar follows it there. Shift plus the arrow keys
does the same thing from the keyboard — a day at a time, or a week with up and
down.

## Catching up on a slipped plan

Targets are cumulative from the plan's start, which means missing two days
would otherwise leave those pages piled on top of every day that follows — a
schedule that behaves like a debt. "Catch me up" rebases instead: from today,
what's left is spread across the days that are left, and the finish date is
extended if it has already gone.

Catching up **moves the plan's start date to today** — 9 August becomes 11
August — and remembers the original. An earlier version tracked the change
invisibly, which meant the form still said 9 August while the targets came
from the 11th. A plan you can't read off the record is not a plan.

A rebased plan still totals exactly the page count; `tests/calendar.test.js`
sums the daily targets and asserts it.

## Recording progress by percentage

Both the record and the reading log take a page number **or** a percentage —
useful for comics, an ebook that only reports a location, or judging by the
thickness of what's left. Switch units and whatever you've typed converts
rather than being reinterpreted.

Both halves are always stored consistently. One case is deliberately left
alone: a percentage on a book with no page count records the percentage and no
page, because a derived page number there would be fiction, and every pacing
figure in the app is built on that number.

## Reading the charts

Every mark on every chart is hoverable, focusable and tappable, with a floating
read-out naming the point and its value. Native SVG tooltips were the
alternative: about a second to appear, unstyleable, and invisible on a touch
screen.

This matters most on the pages-read chart, where the axis has room for three
labels and shows something like `07-04`. The read-out spells out "4 July 2026"
and adds what was actually read that day. Monthly bars name the month *and*
year. Bars get a full-height hit area, because a two-pixel bar for a quiet
month is impossible to hover and is exactly the month worth inspecting.

## Logging what you actually know

A session needs **either** where you got to **or** how long you read — not
both. Often you know you went from 40% to 60% and have no idea how long it
took, so minutes are genuinely optional and the form says so.

Positions can be given in pages or percent, with one unit switch for the whole
entry rather than one per field: "started on page 79, ended at 40%" is a
sentence nobody means, and offering it invites exactly that mistake. Switching
converts whatever is already typed.

## Joining a book part-way through

If you were 40% into Moby-Dick before you started tracking it, the plan counts
from page one and cheerfully reports you 95 pages ahead of a schedule you never
followed — technically true, completely useless. The record offers **"Start
plan from here"**: the plan restarts today at your current page, so every target
counts what is ahead of you rather than what is already behind.

Same mechanism as catching up, different framing, because "you are ahead" and
"start from here" lead to completely different actions.

## Reading that isn't daily

Start and finish dates describe a span, not a habit. Once there is a session
log, the calendar shows the days you actually read rather than filling
everything between — so a book picked up on 3 July and again on the 18th shows
two reading days, not sixteen. The record says so in words too: "Read on 2 days
across 16, with 1 break (longest 14 days)."

## Two pace numbers, which mean different things

The record shows both, because one on its own is misleading:

- **Average so far** — everything read divided by days *elapsed since you
  started*, including days you didn't open the book. Sitting on page 79 of a
  440-page book three days in reads as 26 pages a day even if you read all 79
  in one sitting. It's a description of the past, not a prediction.
- **Needed from here** — what's left divided by the days left in the plan.
  This is the number to act on.

Each carries a line saying what it's measured over.

## Why a finish estimate sometimes isn't shown

A pace needs more than one data point. With a single logged day, projecting
"finishes 20 August, five days past plan" is confident, specific and mostly
noise. So a projection needs either two days of logged reading or four days
elapsed with progress recorded; below that the record says so instead of
guessing.

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

## Importing from Calibre

In Calibre: select your books, then Convert books, Create a catalogue, CSV.

Everything arrives as an unscheduled **ebook**, since a Calibre catalogue
records what you own rather than what you've read. Titles, authors, series and
index, tags and ISBNs come across.

**Calibre catalogues carry no page count**, so lengths arrive empty. That's
deliberate rather than an oversight: pacing, progress and targets all derive
from the length, and a guessed one would quietly corrupt every figure that
depends on it. Add a length to any book you plan to schedule — an ISBN lookup
on the record fetches it.

Cover art is the part that works better here than anywhere else. Calibre's
`cover` column is an absolute path on your machine, useless to a browser but
perfectly readable by the sync server running on that same machine — so with
`npm start` the covers are copied straight off disk, with no lookups and no
rate limits, including for books that were never on Open Library.

Reading local paths is a real capability, so it's fenced: the path must name an
image, be a regular file of a sane size, and start with an actual image
signature. Nothing else is ever read or served. `npm start -- --no-local-covers`
disables it entirely.

## Bulk actions

Hover a book in the library and a checkbox appears. Click one, then
**shift-click another to select everything between them**, the way a file
manager behaves — ticking forty boxes individually is not a workflow.

Once anything is ticked the toolbar offers: set status, set format, shelve or
unshelve, fill in missing details, schedule, and remove. Bulk removal is
undoable from the toast, because deleting forty books by mistake should be
recoverable for longer than a toast normally lives.

Bulk scheduling lists the books **in the order you selected them**, with the
dates each will get, and arrows to reorder before committing. The order was
always the selection order; it just wasn't visible, which made it a guess.

## Filtering the calendar by kind

Above the month grid: **Everything, Books, Comics, Manga**. Toggling is
additive — comics and manga on together shows both and hides books. Turning
everything off is treated as everything on, since an empty calendar with no
obvious way back is a trap.

Six categories is right for a record and far too many for a row of toggles, so
they collapse: non-fiction and anthologies are books, graphic novels are
comics, manga stands alone. Every category belongs to exactly one group — one
belonging to none would make books silently vanish whenever a filter was on.

The toggles appear only when more than one kind is actually scheduled, and they
are the real answer to a crowded day: hiding what you are not looking for beats
a `+4` chip, which tells you something is missing without telling you what.

## The four views

- **Calendar** — a month, covers on the days they're scheduled.
- **Day** — one date filling the screen. Cards wrap into a grid sized to how
  many books there are: two side by side, four as a 2x2, nine as a 3x3. Nothing
  scrolls sideways, and covers keep their proportions rather than being
  squeezed.
- **Year** — twelve months of day-squares, shaded by how many books fall on
  each. Any twelve consecutive months, not just January to December, because a
  plan running August to August is a normal thing to want to see whole. A cover
  is illegible at this size, so the detail comes from hovering or clicking.
- **Library** — the records themselves.

## Backlog versus planned

"Planned" means **dated**. Everything you own but haven't scheduled lives in
the backlog, on its own shelf. Without the split, importing nine hundred books
from Goodreads buries the handful of things actually coming up.

The two convert automatically: give a backlog book dates and it becomes
planned; clear the dates and it drops back. A status that could contradict its
own dates would be worse than no status at all.

## Kinds of book

Category is separate from format: format is paper, screen or ears; category is
whether this is a novel, a comic, a manga volume. Neither implies the other — a
manga volume can be an ebook.

This exists because "8 books finished this year" is misleading when four of
them are single comic issues. The stats page shows the split, and the library
filters by it. Calibre imports guess a category from the metadata, which is a
guess and editable.

## Finding records that need work

An imported library always has gaps, and they're invisible until you can ask
for them directly. The "Needs work" filters show only the gaps that actually
exist: no length, not scheduled, no cover, no description, no author, no ISBN,
finished but unrated, started but never logged. Each shows its count, and
picking one switches to the whole library, since gaps span every shelf.

## Taking it offline

Settings has "Export offline copy": one self-contained HTML file with the
styles and covers built in. Send it to your phone, open it from Files, and read
your schedule with no network, no server and nothing installed.

Everything is inlined deliberately — a file that referenced `css/base.css`
would arrive as unstyled text on the other device, which is the exact failure
it exists to avoid. Covers can be left out to keep it small enough to message.

It's read-only. An editable copy would be a second library with no way to merge
it back, and editing it is the first thing anyone would try.

## Reading orders

A shelf is a set; a reading order is a **sequence**. "Poe tales, in
publication order" is not something tagging can express, and it's the whole
reason the Orders tab exists.

A book can sit in any number of lists at once — one for comics, one for manga,
one for a series reread — so membership lives on the list rather than on the
book. The alternative, an array on each book, would mean the position of book
#7 is stored on book #7, and reordering a fifty-book list would rewrite fifty
records on every drag.

Reorder with the arrows or by dragging. The arrows come first because they work
on a phone, with a keyboard, and with a screen reader, none of which is true of
drag-and-drop alone.

In the library, picking a list from the "Reading order" chips filters to it and
shows it **in its own sequence**, with each book's position on the card. That
overrides the sort, since sorting a sequence by title would throw away the only
thing that makes it a sequence.

Bulk "Add to list" appends in the order shown on screen — so sort by series
first and a run of comics arrives already sequenced.

When two devices edit the same list, the newer version wins whole rather than
interleaving: two sequences merged item by item would produce an order neither
person asked for.

## Filling in missing details

"Get details" — on a single record, or across a selection — looks a book up by
ISBN, or by title when there is no ISBN, and fills in **only the fields that
are currently empty**. Anything you typed always wins. That rule is absolute
and tested: a page count you corrected by hand must never be replaced by a
different edition's, because every pacing figure in the app derives from it.

Bulk lookups run one at a time with a pause between. Open Library is free and
donation-funded; several hundred parallel requests is both rude and the
quickest way to have all of them refused.

## If browser storage fills up

The cause is almost always an uploaded cover stored as a base64 data URL inside
the library record. Base64 costs a third more than the image, localStorage is
around 5 MB shared across everything you own, and once it's full *every*
save fails — logging a page, renaming a book, anything.

Uploaded images now go to IndexedDB (measured in hundreds of megabytes) and the
record keeps a short sentinel. Anything already stored the old way is moved
automatically at startup, and Settings has a "Reclaim space" button that does
the same on demand. Nothing is lost either way.

## Two decisions worth knowing about

**Dates are local day keys (`YYYY-MM-DD`), never timestamps.** A reading day is
a human day. Storing instants is how a book scheduled for the 4th shows up on
the 3rd for someone in a different zone. All arithmetic goes through
`js/lib/dates.js`.

**A book carries a plan and a record, separately.** `schedule.{start,end}` is
what you intended; `actual.{startedAt,finishedAt}` is what happened. Keeping
them apart is what lets the calendar distinguish planned from in-progress from
finished-that-day, and what lets pacing tell you whether you're behind.