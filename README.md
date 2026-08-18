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
css/library.css       record lists
js/app.js             bootstrap + hash router
js/lib/dom.js         element helper, focus trap, toasts
js/lib/dates.js       day-key arithmetic and the month grid
js/data/schema.js     the Book record: defaults, normalise, validate
js/data/store.js      persistence, migrations, CRUD, pub/sub
js/views/             one module per view
tests/                data-layer tests