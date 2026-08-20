# Chapter

A reading tracker. Helps to sort your books, plan them onto a calendar, and see your reading plan day by day.

It runs from a folder of files and
keeps your library in your browser, or in a folder on your own machine if you
start the little sync server.

Each section below folds open. Start with **Getting started**; everything else
is there when a question comes up.


## Getting started

<details>
<summary><strong>Running it</strong> — Two ways to start it, and why the second one matters</summary>

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

</details>

<details>
<summary><strong>Using it on your phone</strong> — Reaching the same library from another device</summary>

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

</details>

<details>
<summary><strong>A warning about changing the address</strong> — Why the port you use is part of where your library lives</summary>

Browser storage is scoped to the exact origin — protocol, host *and* port. A
library built at `localhost:8080` is invisible at `localhost:8090`. Same
machine, same browser, same files; different storage.

So before changing ports, open the old address, go to Settings, and Export
JSON. Then import that file at the new one. Once you are running `npm start`,
the library lives in `./data` on disk and this stops being a concern, since
every device reads the same copy.

The server says as much on first run when it finds no library.

</details>

<details>
<summary><strong>The four views</strong> — What each screen is for</summary>

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

</details>


## Planning and reading

<details>
<summary><strong>Using the calendar</strong> — Plans on a grid, and dragging them about</summary>

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

</details>

<details>
<summary><strong>Filtering the calendar by kind</strong> — Showing only what you are looking for</summary>

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

</details>

<details>
<summary><strong>Backlog versus planned</strong> — Owned, and owned-and-dated</summary>

"Planned" means **dated**. Everything you own but haven't scheduled lives in
the backlog, on its own shelf. Without the split, importing nine hundred books
from Goodreads buries the handful of things actually coming up.

The two convert automatically: give a backlog book dates and it becomes
planned; clear the dates and it drops back. A status that could contradict its
own dates would be worse than no status at all.

</details>

<details>
<summary><strong>Logging what you read</strong> — Recording a sitting</summary>

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

</details>

<details>
<summary><strong>Logging what you actually know</strong> — Partial records beat no record</summary>

A session needs **either** where you got to **or** how long you read — not
both. Often you know you went from 40% to 60% and have no idea how long it
took, so minutes are genuinely optional and the form says so.

Positions can be given in pages or percent, with one unit switch for the whole
entry rather than one per field: "started on page 79, ended at 40%" is a
sentence nobody means, and offering it invites exactly that mistake. Switching
converts whatever is already typed.

</details>

<details>
<summary><strong>Progress and pace</strong> — How far through, and how far behind</summary>

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

</details>

<details>
<summary><strong>Two pace numbers, which mean different things</strong> — Average so far, and needed from here</summary>

The record shows both, because one on its own is misleading:

- **Average so far** — everything read divided by days *elapsed since you
  started*, including days you didn't open the book. Sitting on page 79 of a
  440-page book three days in reads as 26 pages a day even if you read all 79
  in one sitting. It's a description of the past, not a prediction.
- **Needed from here** — what's left divided by the days left in the plan.
  This is the number to act on.

Each carries a line saying what it's measured over.

</details>

<details>
<summary><strong>Recording progress by percentage</strong> — For books with no page numbers</summary>

Both the record and the reading log take a page number **or** a percentage —
useful for comics, an ebook that only reports a location, or judging by the
thickness of what's left. Switch units and whatever you've typed converts
rather than being reinterpreted.

Both halves are always stored consistently. One case is deliberately left
alone: a percentage on a book with no page count records the percentage and no
page, because a derived page number there would be fiction, and every pacing
figure in the app is built on that number.

</details>

<details>
<summary><strong>Joining a book part-way through</strong> — Starting a plan from where you already are</summary>

If you were 40% into Moby-Dick before you started tracking it, the plan counts
from page one and cheerfully reports you 95 pages ahead of a schedule you never
followed — technically true, completely useless. The record offers **"Start
plan from here"**: the plan restarts today at your current page, so every target
counts what is ahead of you rather than what is already behind.

Same mechanism as catching up, different framing, because "you are ahead" and
"start from here" lead to completely different actions.

</details>

<details>
<summary><strong>Reading that isn't daily</strong> — Plans that skip days</summary>

Start and finish dates describe a span, not a habit. Once there is a session
log, the calendar shows the days you actually read rather than filling
everything between — so a book picked up on 3 July and again on the 18th shows
two reading days, not sixteen. The record says so in words too: "Read on 2 days
across 16, with 1 break (longest 14 days)."

</details>

<details>
<summary><strong>Catching up on a slipped plan</strong> — Replanning without losing the record</summary>

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

</details>

<details>
<summary><strong>Why a finish estimate sometimes isn't shown</strong> — When there is not enough to go on</summary>

A pace needs more than one data point. With a single logged day, projecting
"finishes 20 August, five days past plan" is confident, specific and mostly
noise. So a projection needs either two days of logged reading or four days
elapsed with progress recorded; below that the record says so instead of
guessing.

</details>

<details>
<summary><strong>Reading orders</strong> — Sequences, and reordering them</summary>

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

</details>

<details>
<summary><strong>Reading the charts</strong> — What the stats page is showing</summary>

Every mark on every chart is hoverable, focusable and tappable, with a floating
read-out naming the point and its value. Native SVG tooltips were the
alternative: about a second to appear, unstyleable, and invisible on a touch
screen.

This matters most on the pages-read chart, where the axis has room for three
labels and shows something like `07-04`. The read-out spells out "4 July 2026"
and adds what was actually read that day. Monthly bars name the month *and*
year. Bars get a full-height hit area, because a two-pixel bar for a quiet
month is impossible to hover and is exactly the month worth inspecting.

</details>


## Your library

<details>
<summary><strong>Kinds of book</strong> — Books, comics, manga and anything you add</summary>

Category is separate from format: format is paper, screen or ears; category is
whether this is a novel, a comic, a manga volume. Neither implies the other — a
manga volume can be an ebook.

This exists because "8 books finished this year" is misleading when four of
them are single comic issues. The stats page shows the split, and the library
filters by it. Calibre imports guess a category from the metadata, which is a
guess and editable.

</details>

<details>
<summary><strong>One book, more than one format</strong> — Reading and listening at once</summary>

Reading the paperback with the audiobook playing is one book being read once —
the same story, the same progress, the same finish date. Two records for it
would double every count, split the reading log in half, and need the schedule
kept in step by hand. So a book has **formats**, plural: tick both in the form.

A comic and its audio drama are a different matter and should stay two records.
Different scripts, different lengths, different things.

There is no "primary" to choose, because the rule is obvious once stated:
**pages beat minutes.** A page count is a property of the book; a running time
is a property of one recording. So a book that is both physical and audio is
measured in pages, and only an audio-only book is measured in minutes.

Everything downstream follows from that one helper rather than from
`book.format` read directly, which is what makes the change small: pacing,
targets, the day view, the hover card, the session form and every label ask
`formatUnit(book)`.

- **Filtering** by format matches a book that is *any* of them.
- **Bulk actions** separate "also audiobook" from "only audiobook", because
  adding a form must not erase the one already recorded.
- **A sitting** can say which way it happened, on books that are more than one
  thing. "Both" is the default and the reason the feature exists — reading the
  page while the narrator reads it aloud is one sitting, and logging it twice
  would double the time recorded.
- **Calibre** imports a record holding an EPUB and an M4B as one book in two
  forms rather than as an ebook.

Records saved before formats were plural still work: `format` alone is read as
a list of one, and the two fields are kept in step on every save rather than
stored independently, since two fields that can disagree about the same fact
eventually will.

</details>

<details>
<summary><strong>Searching, and what "get details" actually does</strong> — Finding books, and filling them in</summary>

The search field reads titles, authors, genres, series names, **descriptions,
notes and tags**. Descriptions were not searched before, which made a blurb
something you could write and never find again — and finding it again six
months later is the entire reason to write one. When the only reason a book is
on screen is a phrase four paragraphs into its blurb, the card shows that
phrase instead of the opening line.

"Get details" fills empty fields and only empty fields. It asks the catalogues
in two passes:

1. **By ISBN**, when the record has one, since that identifies an edition and
   so gets the page count right.
2. **By title and author**, when the first pass left something out. An edition
   nobody has catalogued fully is a dead end — a regional printing may be
   indexed with a title and nothing else while the work everyone else owns has
   a blurb, a page count and a cover. A title search finds the work, so its
   page count belongs to some printing and its ISBN is never claimed as yours.

### Open Library has no descriptions in its search index

This was a real bug and worth writing down. Open Library's search API returns
titles, authors, page counts and cover ids, and no description, however you ask
for it — the blurb lives on the *work* record, one level up from any edition.
So a lookup could find a book, return everything search knows, and report that
there was nothing the record was missing, while the description sat on a page
you could open in a browser and read.

The work record is now fetched as a second request, made only when something is
still missing. Its subject list stands in for a genre, which Open Library does
not have as a field at all — with cataloguing artefacts ("Accessible book",
"Protected DAISY") and Library of Congress headings filtered out, since neither
is a word anyone would use.

When a lookup finds the book but not the gap, it now says which gap survived.
"No description in any catalogue searched" tells you to write your own; "the
lookup had nothing this book was missing" reads as a shrug.

</details>

<details>
<summary><strong>Filling in missing details</strong> — Looking a book up</summary>

"Get details" — on a single record, or across a selection — looks a book up by
ISBN, or by title when there is no ISBN, and fills in **only the fields that
are currently empty**. Anything you typed always wins. That rule is absolute
and tested: a page count you corrected by hand must never be replaced by a
different edition's, because every pacing figure in the app derives from it.

Bulk lookups run one at a time with a pause between. Open Library is free and
donation-funded; several hundred parallel requests is both rude and the
quickest way to have all of them refused.

</details>

<details>
<summary><strong>Finding records that need work</strong> — The gaps worth closing</summary>

An imported library always has gaps, and they're invisible until you can ask
for them directly. The "Needs work" filters show only the gaps that actually
exist: no length, not scheduled, no cover, no description, no author, no ISBN,
finished but unrated, started but never logged. Each shows its count, and
picking one switches to the whole library, since gaps span every shelf.

</details>

<details>
<summary><strong>The same book twice</strong> — Finding and merging duplicates</summary>

Duplicates arrive on their own: an import that ran before an ISBN was filled
in, a book catalogued on two devices before sync was set up, a volume added as
"Vol. 1" once and "Volume 1" the next. The cost is a reading log split across
two records, so neither one is true.

Settings > **The same book twice** finds them three ways — same ISBN, same
title and author, or same title where only one names an author. It is
deliberately not fuzzier than that: a finder that suggests merging two volumes
of a series is worse than no finder, because the only thing worse than a split
reading log is a wrongly merged one. Anything it raises can be dismissed as
**Not duplicates**.

Merging, not deleting. The fullest record survives — a reading log outweighs
everything, being the only part no catalogue can supply again — and the others
contribute only what it is missing. Sessions from every copy are combined and
de-duplicated, tags are unioned, progress becomes the furthest anyone got, and
a finish date on any copy finishes the book. Reading orders are repointed to
the survivor in the slot the duplicate held, rather than quietly losing an
entry.

</details>

<details>
<summary><strong>Bulk actions</strong> — Editing many books at once</summary>

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

</details>


## Cover art

<details>
<summary><strong>Where covers come from, and where they end up</strong> — Three catalogues, and where the files go</summary>

Three catalogues, all free and none needing a key: **Open Library** (the best
page counts and the strongest on older and public domain titles), **Google
Books** (the widest coverage of recent, translated and self-published work, and
by far the best blurbs) and **Apple Books** (the largest artwork). By default a
search asks all three at once and keeps the best field from each, which is why
a title that used to return nothing now usually returns a row of covers to pick
from.

Settings has two selects, not one: where **book details** come from and where
**cover art** comes from. They are separate because the answers differ —
Open Library knows how long a 1937 printing is and has no picture of it, Apple
has a 600px cover and no idea how long it is.

Amazon is not on the list and cannot be. The Product Advertising API needs an
affiliate account with qualifying sales, and the `images-amazon.com/images/P/`
URLs people pass around are unsanctioned and increasingly answered with a blank
image. The honest substitute is in the cover picker: right-click a cover
anywhere, copy its image address, paste it in. Dragging the image itself onto
the book does the same thing.

### Changing a cover you don't like

Three ways, in ascending order of effort:

1. **Drag an image onto the book** in the library — from your desktop or from
   another browser tab. Nothing to open first.
2. **Paste an image address** into the cover picker in the book form.
3. **Search the catalogues** from the picker and choose a different edition;
   each result is labelled with which catalogue it came from.

### The covers folder

With `npm start` running, cover art is written to `data/covers` as ordinary
files named after their book:

```
data/covers/the-hobbit.jpg
data/covers/dune.jpg
data/covers/dune-2.jpg          a second book with the same title
data/cover-index.json           which file belongs to which record
```

They used to be named after the record id — `bk-9f2c1a04.jpg` — which is
stable, correct and completely unreadable. Opening the folder told you nothing
and replacing one cover by hand was impossible without first looking up an id.
The index is what makes titles safe as filenames: titles are neither unique nor
permanent, so the mapping is written down rather than inferred. Rename a book
and its file is renamed to follow on the next sync; drop a replacement image
into the folder under the same name and it is picked up on the next load. Older
id-named files are renamed automatically the first time the server starts.

Without a server there is no folder — the art lives in this browser's image
store (IndexedDB), keyed by record id, and there is nowhere on disk to go and
look at it.

### When a catalogue won't answer a browser

Providers block cross-origin requests without warning and change their minds
about it. When the sync server is running, lookups go through `api/lookup`
instead, which makes the call server-side and hands back the JSON. The proxy is
locked to the four provider hostnames — an open proxy left running on a home
network is a genuinely bad thing to ship.

</details>

<details>
<summary><strong>Which covers do you actually have</strong> — Files you own versus addresses you borrow</summary>

A cover on screen is not a cover you have. It might be a file in the covers
folder, a copy in this browser's image store, or nothing but a URL pointing at
a catalogue that answers today and 404s in three years. All three look
identical on the shelf, which is the problem.

Settings > **Where the cover art is** counts them, ranked by how much of the
image survives the internet going away:

| Verdict | What it means |
| --- | --- |
| In the covers folder | A file on the server. Survives clearing this browser; every device sees it. |
| This browser only | In the image store here. Lost with site data, invisible elsewhere. |
| Linked, not saved | An address. Blank spine the day the source stops serving it. |
| No cover | Nothing but a typeset spine. |

Each row has a **Which?** button, because the question behind "how many" is
always "which ones". One button turns every linked cover into a file. Files
belonging to no book — left by a deletion on another device, or by a library
restored onto a server that kept its old folder — are reported as orphans.

The cover picker answers the same question for one book: *Saved in the covers
folder as the-hobbit.jpg*, or *Linked from the web, not saved*.

</details>

<details>
<summary><strong>What dragging a cover does</strong> — Setting a cover by dropping an image</summary>

Dragging a cover to another day moves the **whole plan and keeps its length**: a
seven-day plan dropped on the 14th becomes the 14th to the 20th. It does not
move only the start, and it does not stretch the plan. If the book lands outside
the month on screen, the calendar follows it there. Shift plus the arrow keys
does the same thing from the keyboard — a day at a time, or a week with up and
down.

</details>

<details>
<summary><strong>Loose files in the covers folder</strong> — Finding and clearing orphans</summary>

Files belonging to no book accumulate: a book deleted on another device, a
library restored onto a server that kept its old folder. Settings lists them
with the two things that are actually knowable — the filename, which is the
book's title, and when the file was last written. Between them they usually
settle which is which: a run modified on the same old date is a leftover
folder, a single recent one is a deletion elsewhere.

Deleting them is a two-step endpoint. The client sends the ids of every book it
still has, and the server removes only files no book claims; the list is
fetched with a dry run first, so opening it can never delete anything. Nothing
is removed on a bare request, because pruning against a library that has not
finished syncing is how a lag becomes lost cover art.

</details>


## Importing and exporting

<details>
<summary><strong>Importing from Goodreads</strong> — Bringing a Goodreads export in</summary>

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

</details>

<details>
<summary><strong>Importing from Calibre</strong> — Bringing a Calibre catalogue in</summary>

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

</details>

<details>
<summary><strong>Importing the same catalogue twice</strong> — Filling gaps instead of skipping</summary>

A Calibre import that met a book already in the library used to skip it. That
is the safe answer and the wrong one: the reason to export a catalogue again
after an evening of writing descriptions into Calibre is precisely that the
books are already here and the descriptions are not.

A second import now **fills**. The rule is the one enrichment already used and
it is strict and one-directional: only empty fields are written. A length you
corrected by hand, a description you rewrote, a status, a schedule, a rating —
none of them can be touched by an import, ever. What can arrive is what is not
there yet: author, ISBN, length, description, genre, series name, series
number, series length, notes.

Two fields are additive rather than filled. Tags are a set, so new ones are
added and none are removed. Cover art is fetched for a matched book that has
none, whether or not any text field was empty.

Books are matched on ISBN first, then on title and author, then on title alone
— but only when exactly one book carries that title and one of the two authors
is blank. Every credited author is compared, not just the first: the same
graphic novel is "Fábio Moon & Terry Moore" in one catalogue and "Terry Moore"
in a record typed by hand, and reading only the first credit files it twice.

The preview says what will happen before it happens — how many will be added,
how many filled, and which fields across all of them ("12 × description, 7 ×
series number").

### Column names

Descriptions come from Calibre's **comments** field, which is what the Comments
box in its editor writes to and what every library has. A handful of other
names are accepted as fallbacks for catalogues that keep their blurbs
elsewhere, and column names are matched without regard to case, to spaces
against underscores, or to a leading hash — `Series Index` and `series_index`
are the same column.

Preference order is the list's, not the file's. A catalogue carrying two
columns that both hold a blurb used to get whichever one the export happened to
write first, which is not a rule anyone could predict from looking at their
library.

Tick the fields you want in Calibre's catalogue options before exporting;
anything left unticked is not in the file at all.

### Series numbers are not integers

A side story published between volumes four and five is genuinely #4.5, and
rounding it to 4 or 5 files it under a volume that already exists. Series
numbers are stored to two decimals; the form accepts them and sequences sort by
them. How many books are in a series stays a whole number — you can own volume
4.5, you cannot own 4.5 volumes.

A series also votes on what kind of thing it is. `Little Nemo, Volume 2` is
obviously a comic and `Little Nemo: A Slumberland Interlude` is obviously
nothing at all; read together they are plainly the same shelf, so a run whose
volumes are mostly comics makes its odd one out a comic too.

</details>

<details>
<summary><strong>What is in a backup</strong> — Everything the JSON export carries</summary>

Settings > Export JSON writes one file containing books, reading sessions,
progress, shelves, tags, ratings, notes, series, reading order lists and their
order, your settings, and the tombstones recording what you have deleted. The
tombstones matter: restore without them onto a device that still has a book you
deleted elsewhere and the book comes back.

**Cover art is the exception**, and it is opt-in. Tick "Include cover art" and
the images are read back out of the image store and written into the file as
data URLs. Untick it and the file stays small enough to keep a weekly copy of.
Only art that would otherwise be lost is carried — an uploaded cover, or one
dropped onto a book — since a plain `https://` cover URL will still be a plain
`https://` cover URL after a restore.

Import merges by default. Books match on id first and then on title and author;
lists match on id and then on name. A list that exists on both sides takes the
imported sequence and keeps anything added here since on the end, rather than
one silently overwriting the other. Book ids are rewritten on the way in, so a
sequence restored onto a device that catalogued the same books separately points
at the records that are actually there.

CSV remains lossy by design: one row per book, no sessions, no lists.

</details>

<details>
<summary><strong>The plan as a calendar file</strong> — Exporting to .ics</summary>

Settings exports the reading plan as `.ics`: one all-day event per scheduled
book, spanning its planned dates. A plan that lives only in this app is one you
have to remember to look at, and everyone already has a calendar they check
without deciding to.

Exported rather than subscribed to, since a subscription needs a URL reachable
from wherever the calendar app runs, which for a library in a browser tab is
usually nowhere. Each event carries a stable id, so re-importing after a
replan updates the entries instead of doubling them.

</details>

<details>
<summary><strong>Taking it offline</strong> — A standalone HTML snapshot</summary>

Settings has "Export offline copy": one self-contained HTML file with the
styles and covers built in. Send it to your phone, open it from Files, and read
your schedule with no network, no server and nothing installed.

Everything is inlined deliberately — a file that referenced `css/base.css`
would arrive as unstyled text on the other device, which is the exact failure
it exists to avoid. Covers can be left out to keep it small enough to message.

It's read-only. An editable copy would be a second library with no way to merge
it back, and editing it is the first thing anyone would try.

</details>


## Making it yours

<details>
<summary><strong>Making it yours</strong> — Colours, a name, kinds and clutter</summary>

**Appearance.** Seven colour schemes, and every colour in them editable. The
palette has always lived in CSS custom properties, so changing it is a handful
of `setProperty` calls at boot — the interesting decision is which colours to
expose. Seven, not the twenty-five `tokens.css` defines: chrome, card stock,
text, accent, reading, finished, behind. Every variation — the wash behind a
selected row, the hairline between cards, the accent as it appears on the dark
chrome — is *computed* from those seven, so changing the accent moves its whole
family and nothing is left mismatched. Text on the chrome flips between light
and dark automatically, because a scheme with cream chrome and cream text on it
is not a scheme.

Switching preset drops any custom colours: they were adjustments to a different
scheme, and carrying an accent chosen against cream paper onto a black one is
how a theme picker produces something unreadable.

**A name.** The library is called "The library" until you call it something
else, at which point the heading, the wordmark and the browser tab follow.

**Kinds of book.** Six built-in kinds is a guess at what a library holds, and
every guess of that shape is wrong for somebody — research papers, cookbooks,
rulebooks and art books are all real shelves being told they are "Books". Add
your own in Settings. Built-ins can only be renamed, not deleted, since every
record refers to them by id. A record naming a kind this device has not heard
of yet is kept as it is rather than reclassified, because the setting and the
book arrive over sync separately.

**The "needs work" row.** Hideable entirely or one prompt at a time. A gap you
have decided not to care about stops being a gap: a library of comics has no
ISBNs and never will, and a row permanently announcing "No ISBN (312)" is not a
prompt, it is furniture — and it teaches you to ignore the row that would have
told you something useful.

**Shelves and lists.** A shelf has no record of its own; it exists because
books carry its name, which made it free to create and impossible to delete.
Renaming or deleting one now rewrites the tag on every book that has it, and
renaming onto an existing shelf merges the two. Reading lists can be deleted
from Settings as well as from the Orders page.

</details>

<details>
<summary><strong>Keyboard shortcuts</strong> — Getting around without the mouse</summary>

`1`–`6` and `0` move between the views, `n` adds a book, `/` focuses the search
field, and `?` lists them all. Nothing uses a modifier, so every browser and
accessibility shortcut keeps working, and nothing fires while the cursor is in
a text field — a single-letter shortcut that steals a keystroke mid-title is
not a shortcut, it is a bug that eats text.

</details>


## Keeping your data

<details>
<summary><strong>Is my library actually saved?</strong> — Checking, rather than trusting</summary>

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

</details>

<details>
<summary><strong>Working offline</strong> — What works with no network</summary>

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

</details>

<details>
<summary><strong>Undo that outlives the message</strong> — Restoring something you deleted</summary>

Deleting a book has always left a tombstone so other devices agree it is gone.
It now keeps the record alongside it, so Settings can list what you deleted and
put any of it back — with its reading log, shelves and progress intact. Undo
used to last exactly as long as the toast, which is fine for the deletion you
notice immediately and no use at all for the one you notice on Thursday.

The archive is capped at the last 40 records. Older entries keep the tombstone
and drop the copy: dropping the tombstone instead would free more space and
resurrect the book on the next sync, which is the one outcome worse than losing
the archive.

</details>

<details>
<summary><strong>If browser storage fills up</strong> — Reclaiming space</summary>

The cause is almost always an uploaded cover stored as a base64 data URL inside
the library record. Base64 costs a third more than the image, localStorage is
around 5 MB shared across everything you own, and once it's full *every*
save fails — logging a page, renaming a book, anything.

Uploaded images now go to IndexedDB (measured in hundreds of megabytes) and the
record keeps a short sentinel. Anything already stored the old way is moved
automatically at startup, and Settings has a "Reclaim space" button that does
the same on demand. Nothing is lost either way.

</details>


## How it is built

<details>
<summary><strong>Where things live</strong> — The module map</summary>

```
css/base.css            reset, typography, shell layout
css/calendar.css        month grid, day cells, cover tiles
css/components.css      buttons, fields, slips, modal, chips
css/covers.css          cover picker
css/dayview.css         day view, hover card, day popup
css/library.css         shelves and record cards
css/sessions.css        reading log
css/settings.css        settings page, themes, reports
css/stats.css           stats page and charts
css/tokens.css          design tokens — palette, type, spacing, motion
index.html              app shell
js/app.js               bootstrap, hash router, settings applied app-wide
js/data/calibre.js      Calibre catalogue import
js/data/coverActions.js one path for setting a cover, wherever it came from
js/data/coverAudit.js   which covers are files and which are only addresses
js/data/coverCache.js   IndexedDB store for offline cover art
js/data/coverNames.js   what a cover file is called, and which folder it goes in
js/data/covers.js       which catalogue to ask, and upload downscaling
js/data/duplicates.js   finding and merging the same book twice
js/data/enrich.js       looking a book up and closing its gaps
js/data/fill.js         filling only the fields a record is missing
js/data/goodreads.js    Goodreads CSV import
js/data/ics.js          the reading plan as a calendar file
js/data/kinds.js        built-in and user-defined kinds of book
js/data/merge.js        last-write-wins merge with tombstones, for sync
js/data/providers.js    Open Library, Google Books, Apple Books
js/data/schema.js       the Book record: defaults, normalise, validate
js/data/seed.js         sample library for demos
js/data/snapshot.js     standalone offline HTML export
js/data/store.js        persistence, migrations, CRUD, pub/sub
js/data/sync.js         talking to the sync server
js/data/theme.js        colour schemes, and everything derived from them
js/data/transfer.js     JSON and CSV export, merge-aware import
js/lib/charts.js        hand-rolled SVG charts (no chart library)
js/lib/csv.js           CSV parsing that survives quoted commas
js/lib/dates.js         day-key arithmetic and the month grid
js/lib/dom.js           element helper, focus trap, toasts
js/logic/pacing.js      daily targets, ahead/behind, projected finish
js/logic/schedule.js    which books land on which day, in which state
js/logic/sessions.js    session totals, reading streak, observed pace
js/logic/stats.js       monthly rollups, breakdowns, goal progress
server.mjs              optional sync server — one library across devices
sw.js                   service worker: the offline app shell

js/views/               one module per view:
  bookForm.js           adding and editing a book
  calendar.js           the month grid
  cover.js              rendering a cover, with a typeset fallback
  coverDrop.js          drag-and-drop wiring for cover art
  coverPicker.js        choosing cover art
  day.js                one day in full
  dayCursor.js          which day the day view is showing
  dayPopup.js           a day's books, from the calendar
  dayRow.js             a book as a row, shared by the popup and the day view
  hoverCard.js          the pacing card on hover
  library.js            the shelves
  modal.js              the dialog layer
  orders.js             reading orders
  sessionLog.js         logging a sitting
  settings.js           everything configurable
  shortcuts.js          keyboard shortcuts and the help sheet
  stats.js              charts and totals
  year.js               the year at a glance

tests/                  data layer, imports, exports and stylesheets
```

</details>

<details>
<summary><strong>Two decisions worth knowing about</strong> — The choices everything else rests on</summary>

**Dates are local day keys (`YYYY-MM-DD`), never timestamps.** A reading day is
a human day. Storing instants is how a book scheduled for the 4th shows up on
the 3rd for someone in a different zone. All arithmetic goes through
`js/lib/dates.js`.

**A book carries a plan and a record, separately.** `schedule.{start,end}` is
what you intended; `actual.{startedAt,finishedAt}` is what happened. Keeping
them apart is what lets the calendar distinguish planned from in-progress from
finished-that-day, and what lets pacing tell you whether you're behind.

</details>

<details>
<summary><strong>Checking the app against itself</strong> — What the tests actually guard</summary>

With no build step there is nothing between a typo and a blank screen. A
misspelled import is valid JavaScript that parses, loads, and throws only when
the browser reaches the line — which for a rarely opened dialog can be weeks
later. Most view modules touch `document` at import time, so the tests cannot
simply load them all and find out.

`tests/imports.test.js` reads the source as text instead and checks four
things: every module imported exists, every *name* imported is actually
exported by the module it comes from, no two modules import each other in a
loop, and nothing imports the same name twice.

The cycle check earned its place immediately. `day.js` imported `dayPopup.js`
and `dayPopup.js` imported `day.js`, which worked — both modules only called
each other from event handlers, by which time both had finished loading. Move
one line of that work to the top level of either file and it becomes
`undefined` at import time and a blank screen naming neither module usefully.
The shared state now lives in `dayCursor.js`, a leaf both can import.

Three other things nothing else could catch:

- **`tests/styles.test.js`** checks every stylesheet is linked from the page,
  precached by the service worker, and brace-balanced. `settings.css` sat
  unlinked for several releases: it existed, it was valid, and it did nothing,
  and the result looked like a dozen unrelated spacing bugs rather than one
  missing line.
- **The theme contrast checks** run across every scheme, so a palette that
  turns author names into grey mist on grey paper fails rather than ships. They
  were written after a derivation that mixed every button outline *toward* the
  background instead of toward the ink.
- **`tests/readme.test.js`** checks this file against the source tree: every
  module appears in the map above, and every path in the map still exists. A
  module map is the first thing to rot and the last thing anyone checks, since
  prose has no compiler.

</details>
