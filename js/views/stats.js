/**
 * Stats view.
 *
 * Ordered by what someone actually wants to know, not by what's easiest to
 * plot: am I hitting my goal, how much have I read, what's the shape of the
 * habit, and only then the breakdowns.
 */

import { el, fill, toast } from '../lib/dom.js';
import { allBooks, getSettings } from '../data/store.js';
import {
  headline, allGoalProgress, finishedByMonth, loggedByMonth, dailyPages,
  cumulativePages, dailyMinutes, breakdown, finishedByCategory,
  yearInReview, yearsWithReading,
} from '../logic/stats.js';
import { formatDuration } from '../logic/sessions.js';
import { kindLabel, kindPlural } from '../data/kinds.js';
import { showModal } from './modal.js';
import { barChart, lineChart, rankChart, heatGrid } from '../lib/charts.js';
import { openBookForm } from './bookForm.js';

export function renderStats(mount) {
  const books = allBooks();
  const settings = getSettings();

  if (!books.length) {
    fill(mount, [
      el('div.view-head', {}, el('h2.view-title', {}, 'Statistics')),
      el('div.empty', {}, [
        el('h3', {}, 'Nothing to count yet'),
        el('p', {}, 'Add a book and log some reading, and this fills in on its own.'),
        el('button.btn.btn--stamp', { type: 'button', onClick: () => openBookForm() }, 'Add a book'),
      ]),
    ]);
    return;
  }

  const stats = headline(books);
  // Every goal that has been set, not only the first: a year can be "twenty
  // books and twelve comics", and showing one of them is showing half a year.
  const goals = allGoalProgress(books, settings.goals ?? settings.goal);

  fill(mount, [
    el('div.view-head', {}, [
      el('div', {}, [
        el('h2.view-title', {}, 'Statistics'),
        el('p.view-sub', {}, 'Everything here is recomputed from your log'),
      ]),
    ]),

    ...goals.map((goal) => goalPanel(goal)),

    reviewPanel(books),

    stats.byCategory.length > 1 ? categoryPanel(stats) : null,

    el('div.stat-row', {}, [
      statCard('Finished', String(stats.booksFinished), `${stats.pagesFinished.toLocaleString()} pages`),
      statCard('Time logged', formatDuration(stats.minutes), `${stats.sessions} sittings`),
      statCard('Pages logged', stats.pagesLogged.toLocaleString(), `across ${stats.daysRead} days`),
      statCard(
        'Current streak',
        `${stats.streak.current}`,
        stats.streak.longest > stats.streak.current ? `best ${stats.streak.longest}` : 'days running'
      ),
    ]),

    el('div.stat-row', {}, [
      statCard('On a reading day', `${Math.round(stats.pagesPerReadingDay)}`, 'pages, on average'),
      statCard('Sitting length', formatDuration(stats.minutesPerReadingDay), 'per day read'),
      stats.minutesPerPage
        ? statCard('Reading speed', `${(60 / stats.minutesPerPage).toFixed(0)}`, 'pages an hour')
        : null,
      stats.averageDaysPerBook
        ? statCard('A book takes', `${Math.round(stats.averageDaysPerBook)}`, 'days, start to finish')
        : null,
    ].filter(Boolean)),

    panel(
      'Books finished by month',
      barChart(finishedByMonth(books), {
        label: 'Books finished by month',
        format: (value) => `${value} book${value === 1 ? '' : 's'}`,
      })
    ),

    panel(
      'Time logged by month',
      barChart(
        loggedByMonth(books).map((row) => ({
          ...row,
          note: row.pages ? `${row.pages.toLocaleString()} pages read` : undefined,
        })),
        {
          label: 'Minutes logged by month',
          format: (v) => (v >= 60 ? `${Math.round(v / 60)}h` : `${v}m`),
          // Hours on the axis too: the default is a plain number, and "1,200"
          // where the panel says hours is worse than a narrow gutter.
          axisFormat: (v) => (v >= 60 ? `${Math.round(v / 60)}h` : `${v}m`),
        }
      )
    ),

    panel(
      'Pages read, last 90 days',
      lineChart(cumulativePages(books), {
        label: 'Cumulative pages read',
        format: (value) => `${value.toLocaleString()} pages`,
        // The axis says 1,000; the hover readout says 1,000 pages. The axis
        // has a gutter to fit in and the readout does not.
        axisFormat: (value) => value.toLocaleString(),
      }),
      'Running total. Hover a point for the date.'
    ),

    panel(
      'Pages read each day',
      barChart(dailyPages(books), {
        label: 'Pages read each day',
        format: (value) => `${value.toLocaleString()} pages`,
        axisFormat: (value) => value.toLocaleString(),
      }),
      'The same 90 days undoctored \u2014 a gap is a gap, and a long Sunday is tall.'
    ),

    panel(
      'Reading days, last six months',
      el('div.heat-wrap', {}, heatGrid(dailyMinutes(books), { label: 'Daily reading' })),
      'Each square is a day, darker meaning longer. Hover one for the date and minutes.'
    ),

    // Genre is the field most likely to be blank in a hand-built catalogue,
    // and an empty panel headed "By genre" is a chart of nothing taking up the
    // width of the page. Shown only once something has one.
    el('div.stat-split', {}, [
      breakdown(books, (b) => b.genre).length
        ? panel('By genre', rankChart(breakdown(books, (b) => b.genre), { label: 'Books by genre' }))
        : null,
      panel('By author', rankChart(breakdown(books, (b) => b.author), { label: 'Books by author' })),
    ].filter(Boolean)),

    panel('By kind',
      rankChart(breakdown(books, (b) => kindLabel(b.category)), { label: 'Books by kind' }),
      'The darker part of each bar is what you have finished.'),

    breakdown(books, (b) => b.shelves).length
      ? panel('By shelf',
          rankChart(breakdown(books, (b) => b.shelves), { label: 'Books by shelf' }),
          'The darker part of each bar is what you have finished.')
      : null,
  ].filter(Boolean));
}

/* --- The year, in one card ------------------------------------------------
   Everything else on this page is a working answer to a question you asked on
   a Tuesday. This is the December answer: what did I actually read this year,
   in a shape that can be sent to someone.
   -------------------------------------------------------------------------- */

/** Which year the card is showing. Module state — a glance, not a preference. */
let reviewYear = null;

function reviewPanel(books) {
  const years = yearsWithReading(books);
  if (!years.length) return null;

  if (!years.includes(reviewYear)) reviewYear = years[0];
  const review = yearInReview(books, reviewYear);
  if (!review.books && !review.sessions) return null;

  const repaint = () => {
    const mount = document.querySelector('#view');
    if (mount) renderStats(mount);
  };

  return el('section.review.slip.slip--plain', {}, [
    el('div.review__head', {}, [
      el('div', {}, [
        el('p.review__eyebrow', {}, 'The year in reading'),
        el('h3.review__year', {}, String(review.year)),
      ]),

      years.length > 1
        ? el('select.select.review__picker', {
            'aria-label': 'Which year to review',
            onChange: (event) => {
              reviewYear = Number(event.target.value);
              repaint();
            },
          }, years.map((year) =>
            el('option', { value: String(year), selected: year === review.year }, String(year))))
        : null,
    ].filter(Boolean)),

    el('dl.review__figures', {}, [
      figure(String(review.books), review.books === 1 ? 'book finished' : 'books finished'),
      figure(review.pages.toLocaleString(), 'pages, cover to cover'),
      figure(formatDuration(review.minutes), 'at the page'),
      figure(String(review.daysRead), `days read \u00b7 ${review.dayShare}% of the year`),
      figure(String(review.streak), review.streak === 1 ? 'day in a row, at best' : 'days in a row, at best'),
      review.averageRating != null
        ? figure(`${review.averageRating}\u2605`, `average of ${review.rated} rated`)
        : null,
    ].filter(Boolean)),

    el('ul.review__lines', {}, reviewLines(review).map((line) => el('li', {}, line))),

    el('div.review__actions', {}, [
      el('button.btn.btn--quiet.btn--sm', {
        type: 'button',
        onClick: async () => {
          const text = reviewText(review);
          try {
            await navigator.clipboard.writeText(text);
            toast('Copied. Paste it wherever you like.');
          } catch {
            // Clipboard access is refused often enough — insecure contexts,
            // permissions, older browsers — that failing silently would look
            // like a broken button. Hand the text over instead.
            openReviewText(text);
          }
        },
      }, 'Copy this summary'),
    ]),
  ]);
}

const figure = (value, label) =>
  el('div.review__figure', {}, [el('dt', {}, value), el('dd', {}, label)]);

/** The sentences worth having, skipping any the year cannot support. */
function reviewLines(review) {
  const lines = [];
  const top = (list) => list[0];

  if (top(review.authors)?.value > 1) {
    lines.push(`Most read: ${top(review.authors).label}, ${top(review.authors).value} books.`);
  } else if (top(review.authors)) {
    lines.push(`First finished author of the year: ${top(review.authors).label}.`);
  }

  if (top(review.genres)) {
    lines.push(`Mostly ${top(review.genres).label.toLowerCase()} \u2014 ${top(review.genres).value} of ${review.books}.`);
  }

  if (review.kinds.length > 1) {
    // `kinds` counts by category id, which is what kindPlural speaks.
    lines.push(`Across ${review.kinds.map((kind) => `${kind.value} ${kindPlural(kind.label)}`).join(', ')}.`);
  }

  if (review.longest) {
    lines.push(`Longest: ${review.longest.title}, ${review.longest.pageCount.toLocaleString()} pages.`);
  }

  if (review.bestRated?.rating === 5) {
    lines.push(`Five stars for ${review.bestRated.title}.`);
  }

  if (review.busiestMonth) {
    lines.push(`Busiest month: ${review.busiestMonth.label}, ${formatDuration(review.busiestMonth.minutes)} logged.`);
  }

  return lines;
}

/** The same card as prose, for pasting somewhere that isn't this app. */
function reviewText(review) {
  return [
    `${review.year} in reading`,
    `${review.books} books \u00b7 ${review.pages.toLocaleString()} pages \u00b7 ${formatDuration(review.minutes)} \u00b7 read on ${review.daysRead} days`,
    ...reviewLines(review),
  ].join('\n');
}

/** The fallback when the clipboard is refused: show it, selected, to copy by hand. */
function openReviewText(text) {
  const field = el('textarea.textarea', { rows: '8', readonly: true }, text);
  const modal = showModal({
    title: 'Your year, as text',
    body: [
      el('p.field__hint', {}, 'This browser would not let the page reach the clipboard. Select it and copy.'),
      field,
    ],
    actions: [el('button.btn.btn--stamp', { type: 'button', onClick: () => modal.close() }, 'Done')],
  });
  field.focus();
  field.select();
}

/**
 * The split that makes the headline count honest.
 *
 * A single-issue comic and a 900-page novel both add one to "books finished",
 * which flatters the total in a way that stops being useful the moment you
 * read a lot of comics.
 */
function categoryPanel(stats) {
  const year = new Date().getFullYear();
  const total = stats.byCategory.reduce((sum, row) => sum + row.count, 0);

  const bar = el('div.category-bar', {},
    stats.byCategory.map((row) =>
      el('span.category-bar__part', {
        class: `is-${row.category}`,
        style: { width: `${(row.count / total) * 100}%` },
        title: `${row.count} ${kindPlural(row.category)}`,
      })));

  return el('section.stat-panel.slip.slip--plain', {}, [
    el('h3.stat-panel__title', {}, 'What those finished books actually are'),
    bar,
    el('dl.category-legend', {},
      stats.byCategory.flatMap((row) => [
        el('dt', { class: `is-${row.category}` }, kindLabel(row.category)),
        el('dd', {},
          `${row.count} \u00b7 ${row.pages.toLocaleString()} pages`),
      ])),
    stats.byCategoryThisYear.length
      ? el('p.stat-panel__note', {},
          `In ${year}: ${stats.byCategoryThisYear
            .map((row) => `${row.count} ${row.count === 1 ? kindLabel(row.category).toLowerCase() : kindPlural(row.category)}`)
            .join(', ')}.`)
      : null,
  ].filter(Boolean));
}

function goalPanel(goal) {
  // A per-kind goal counts that kind, so "12 of 20 comics" reads correctly
  // rather than calling every finished thing a book.
  const noun = goal.type === 'pages'
    ? 'pages'
    : goal.label
      ? kindPlural(goal.category)
      : 'books';

  return el('div.goal-panel', { class: goal.onTrack ? 'is-ahead' : 'is-behind' }, [
    el('div.goal-panel__head', {}, [
      el('div', {}, [
        el('p.goal-panel__eyebrow', {},
          `${new Date().getFullYear()} goal${goal.label ? ` \u00b7 ${goal.label}` : ''}`),
        el('h3.goal-panel__figure', {}, [
          el('b', {}, goal.done.toLocaleString()),
          ` of ${goal.target.toLocaleString()} ${noun}`,
        ]),
      ]),
      el('span.goal-panel__verdict', {},
        goal.onTrack
          ? `${goal.delta > 0 ? `${goal.delta} ${noun} ahead` : 'on pace'}`
          : `${Math.abs(goal.delta)} ${noun} behind pace`),
    ]),

    el('div.progress.goal-panel__bar', {
      role: 'progressbar', 'aria-valuenow': String(goal.percent),
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Yearly goal progress',
    }, el('span.progress__fill', { style: { width: `${goal.percent}%` } })),

    el('p.goal-panel__note', {},
      goal.remaining === 0
        ? 'Goal met. The rest of the year is a bonus.'
        : `${goal.remaining.toLocaleString()} to go \u00b7 about ${goal.perWeekNeeded.toFixed(1)} ${noun} a week \u00b7 on this pace you finish the year at ${goal.projected.toLocaleString()}`),
  ]);
}

const statCard = (label, value, note) =>
  el('div.stat-card.slip.slip--plain', {}, [
    el('p.stat-card__label', {}, label),
    el('p.stat-card__value', {}, value),
    note ? el('p.stat-card__note', {}, note) : null,
  ].filter(Boolean));

const panel = (title, chart, note) =>
  el('section.stat-panel.slip.slip--plain', {}, [
    el('h3.stat-panel__title', {}, title),
    chart,
    note ? el('p.stat-panel__note', {}, note) : null,
  ].filter(Boolean));
