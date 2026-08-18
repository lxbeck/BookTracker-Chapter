/**
 * Stats view.
 *
 * Ordered by what someone actually wants to know, not by what's easiest to
 * plot: am I hitting my goal, how much have I read, what's the shape of the
 * habit, and only then the breakdowns.
 */

import { el, fill } from '../lib/dom.js';
import { allBooks, getSettings } from '../data/store.js';
import {
  headline, goalProgress, finishedByMonth, loggedByMonth,
  cumulativePages, dailyMinutes, breakdown, finishedByCategory,
} from '../logic/stats.js';
import { formatDuration } from '../logic/sessions.js';
import { CATEGORIES } from '../data/schema.js';
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
  const goal = goalProgress(books, settings.goal);

  fill(mount, [
    el('div.view-head', {}, [
      el('div', {}, [
        el('h2.view-title', {}, 'Statistics'),
        el('p.view-sub', {}, 'Everything here is recomputed from your log'),
      ]),
    ]),

    goal ? goalPanel(goal) : null,

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
        }
      )
    ),

    panel(
      'Pages read, last 90 days',
      lineChart(cumulativePages(books), {
        label: 'Cumulative pages read',
        format: (value) => `${value.toLocaleString()} pages`,
      }),
      'Hover a point for the date and running total.'
    ),

    panel(
      'Reading days, last six months',
      el('div.heat-wrap', {}, heatGrid(dailyMinutes(books), { label: 'Daily reading' })),
      'Each square is a day, darker meaning longer. Hover one for the date and minutes.'
    ),

    el('div.stat-split', {}, [
      panel('By genre', rankChart(breakdown(books, (b) => b.genre), { label: 'Books by genre' })),
      panel('By author', rankChart(breakdown(books, (b) => b.author), { label: 'Books by author' })),
    ]),

    panel('By kind',
      rankChart(breakdown(books, (b) => CATEGORIES[b.category]?.label ?? 'Book'),
        { label: 'Books by kind' })),

    breakdown(books, (b) => b.shelves).length
      ? panel('By shelf', rankChart(breakdown(books, (b) => b.shelves), { label: 'Books by shelf' }))
      : null,
  ].filter(Boolean));
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
        title: `${row.count} ${CATEGORIES[row.category]?.plural ?? row.category}`,
      })));

  return el('section.stat-panel.slip.slip--plain', {}, [
    el('h3.stat-panel__title', {}, 'What those finished books actually are'),
    bar,
    el('dl.category-legend', {},
      stats.byCategory.flatMap((row) => [
        el('dt', { class: `is-${row.category}` }, CATEGORIES[row.category]?.label ?? row.category),
        el('dd', {},
          `${row.count} \u00b7 ${row.pages.toLocaleString()} pages`),
      ])),
    stats.byCategoryThisYear.length
      ? el('p.stat-panel__note', {},
          `In ${year}: ${stats.byCategoryThisYear
            .map((row) => `${row.count} ${row.count === 1 ? (CATEGORIES[row.category]?.label ?? row.category).toLowerCase() : (CATEGORIES[row.category]?.plural ?? row.category)}`)
            .join(', ')}.`)
      : null,
  ].filter(Boolean));
}

function goalPanel(goal) {
  const noun = goal.type === 'pages' ? 'pages' : 'books';

  return el('div.goal-panel', { class: goal.onTrack ? 'is-ahead' : 'is-behind' }, [
    el('div.goal-panel__head', {}, [
      el('div', {}, [
        el('p.goal-panel__eyebrow', {}, `${new Date().getFullYear()} goal`),
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
