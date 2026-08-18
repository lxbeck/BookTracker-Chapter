# BookTracker-Chapter
A reading tracker. Helps to sort your books, plan them onto a calendar, and see your reading plan day by day.

## Running it

No build step, no dependencies. The app uses ES modules, so it needs to be
served over HTTP rather than opened from the filesystem:

```bash
npm run dev      # python3 -m http.server 8080
# then open http://localhost:8080
```

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
js/app.js             bootstrap + hash router
js/lib/dom.js         element helper, focus trap, toasts
js/lib/dates.js       day-key arithmetic and the month grid
js/data/schema.js     the Book record: defaults, normalise, validate
js/data/store.js      persistence, migrations, CRUD, pub/sub
js/data/covers.js     Open Library + Google Books lookup, upload downscaling
js/data/seed.js       sample library for demos
js/logic/schedule.js  which books land on which day, in which state
js/logic/pacing.js    daily targets, ahead/behind, projected finish
js/views/             one module per view
tests/                data-layer tests