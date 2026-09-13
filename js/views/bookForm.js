/**
 * Add / edit book form.
 *
 * The form owns a draft copy of the book and only touches the store on save,
 * so cancelling is genuinely free and validation errors can be shown per field
 * without half-written records reaching the library.
 */

import { el, fill, $, toast } from '../lib/dom.js';
import { showModal, confirmAction } from './modal.js';
import { coverPicker } from './coverPicker.js';
import { sessionLog } from './sessionLog.js';
import {
  progressReport, catchUpPreview, catchUpPatch, startFromHere, paceFor, progressTrail,
} from '../logic/pacing.js';
import { trailChart } from '../lib/charts.js';
import { allBooks } from '../data/store.js';
import {
  STATUSES, STATUS_ORDER, FORMATS, FORMAT_PRIORITY,
  blankBook, resolveProgress, formatUnit, hasFormat,
  parseHms, formatHms, listeningTime,
} from '../data/schema.js';
import { allKinds } from '../data/kinds.js';
import { allSources, sourceLabel } from '../data/sources.js';
import { formatShort } from '../lib/dates.js';
import { addBook, updateBook, removeBook, restoreBook, getBook, setStatus } from '../data/store.js';
import { addDays, isValidKey } from '../lib/dates.js';
import { fetchMissingDetails, missingFields } from '../data/enrich.js';
import { historySummary, finishedSummary, formatDuration } from '../logic/sessions.js';
import { readingDaysFor } from '../logic/sessions.js';

/**
 * @param {Object} [options]
 * @param {Object} [options.book] - existing book; omit to add a new one
 * @param {string} [options.defaultStart] - prefill the plan start (day click)
 * @param {(book: object) => void} [options.onSaved]
 */
export function openBookForm({ book = null, defaultStart = null, onSaved } = {}) {
  const isEdit = Boolean(book);
  const draft = book
    ? structuredClone(book)
    : blankBook({ schedule: { start: defaultStart, end: null } });

  const fields = {};

  const field = (name, label, control, hint) => {
    const wrap = el('div.field', {}, [
      el('label.field__label', { for: `f-${name}`, text: label }),
      control,
      hint && el('span.field__hint', { text: hint }),
      el('span.field__error', { id: `err-${name}`, hidden: true }),
    ]);
    fields[name] = { wrap, control };
    return wrap;
  };

  const input = (name, attrs = {}) =>
    el('input.input', {
      id: `f-${name}`,
      name,
      'aria-describedby': `err-${name}`,
      ...attrs,
    });

  const titleInput = input('title', {
    value: draft.title,
    placeholder: 'A Princess of Mars',
    required: true,
  });
  const authorInput = input('author', { value: draft.author, placeholder: 'Edgar Rice Burroughs' });

  // Everyone else credited. One name is shown on a card and sorted by, because
  // a shelf sorts by one name; the rest belong here rather than flattened into
  // a sentence in the notes, where an import used to leave them.
  const coAuthorsInput = input('coAuthors', {
    value: draft.coAuthors?.join(', ') ?? '',
    placeholder: 'Christopher Golden, Thomas E. Sniegoski',
  });
  const isbnInput = input('isbn', { value: draft.isbn, placeholder: '9780486436173' });
  const pagesInput = input('pageCount', {
    type: 'number',
    min: '1',
    value: draft.pageCount ?? '',
    placeholder: '448',
  });
  // A running time is typed the way a player displays it, so the field is text
  // rather than a number input: `9:45:30` is not a number, and a number input
  // silently refuses the colons instead of saying so.
  const audioInput = input('audioSeconds', {
    value: draft.audioSeconds ? formatHms(draft.audioSeconds) : '',
    placeholder: '9:45:30',
    inputMode: 'numeric',
    'aria-describedby': 'err-pageCount audio-note',
  });
  const speedInput = input('speed', {
    type: 'number',
    min: '0.5',
    max: '5',
    step: '0.05',
    value: draft.speed && draft.speed !== 1 ? draft.speed : '',
    placeholder: '1',
    'aria-label': 'Playback speed',
  });
  const audioNote = el('p.field__hint', { id: 'audio-note' });

  // --- Length, which is two different measurements ---------------------------

  const pagesLine = el('div.length-line', {}, [
    el('span.length-line__unit', { text: 'Pages' }),
    pagesInput,
  ]);
  const audioLine = el('div.length-line', {}, [
    el('span.length-line__unit', { text: 'Audio' }),
    audioInput,
  ]);
  // Its own line, because the Length cell can be 150px wide: a label, a
  // running time, a speed and two words of connective tissue on one line left
  // both boxes too narrow to read what was being typed into them.
  const speedLine = el('div.length-line.length-line--speed', {}, [
    el('span.length-line__unit', { text: 'Speed' }),
    speedInput,
    el('span.length-line__unit', { text: '\u00d7' }),
  ]);
  const lengthControl = el('div.length-fields', {}, [pagesLine, audioLine, speedLine, audioNote]);

  const genreInput = input('genre', { value: draft.genre, placeholder: 'Adventure' });

  const descriptionInput = el('textarea.textarea', {
    id: 'f-description',
    name: 'description',
    rows: '4',
    placeholder: 'Fetched automatically when you look a book up by ISBN.',
  }, draft.description ?? '');

  const seriesNameInput = input('series.name', {
    value: draft.series.name,
    placeholder: 'Barsoom',
  });
  const seriesNumberInput = input('series.number', {
    // `step` matters as much as `min` here: a number input with the default
    // step of 1 rejects 4.5 on submit in every browser, so a half-numbered
    // volume could be typed and then silently refused. Zero is allowed
    // because prequels are #0 as often as they are #0.5.
    type: 'number', min: '0', step: '0.01',
    value: draft.series.number ?? '', placeholder: '4.5',
  });
  const seriesTotalInput = input('series.total', {
    type: 'number', min: '1', value: draft.series.total ?? '', placeholder: '4',
  });

  /**
   * Why a book was set down.
   *
   * Only shown once the status says it was, because for every other book the
   * field is a blank prompt for something that never happened. Kept if the
   * status changes back: a book abandoned once and picked up again is a more
   * interesting record with the first attempt still in it.
   */
  const dnfInput = input('dnfReason', {
    value: draft.dnfReason ?? '',
    placeholder: 'Lost the thread around page 200',
    maxlength: '300',
  });

  const dnfField = el('div', { hidden: draft.status !== 'dnf' }, [
    el('label.field', {}, [
      el('span.field__label', {}, 'Why you stopped'),
      dnfInput,
      el('span.field__hint', {}, 'Optional, and only for you.'),
    ]),
  ]);

  const shelvesInput = input('shelves', {
    value: draft.shelves.join(', '),
    placeholder: '2026 goal, book club, rereads',
    list: 'shelf-suggestions',
  });

  // Offer the shelves already in use, so they don't fragment into near-misses.
  const knownShelves = [...new Set(allBooks().flatMap((book) => book.shelves))].sort();
  const shelfList = el('datalist', { id: 'shelf-suggestions' },
    knownShelves.map((shelf) => el('option', { value: shelf })));

  const notesInput = el('textarea.textarea', {
    id: 'f-notes', name: 'notes', rows: '3',
    placeholder: 'Anything you want to remember about this book.',
  }, draft.notes ?? '');

  const reviewInput = el('textarea.textarea', {
    id: 'f-review', name: 'review', rows: '3',
    placeholder: 'A few lines on what you thought.',
  }, draft.review ?? '');

  // Progress can be given either way round. Percent matters for anything
  // without page numbers — a comic, an ebook that only reports a location, a
  // book you're judging by the thickness of what's left.
  /**
   * Controls the person has edited by hand.
   *
   * The form refreshes itself from the store while it is open, so a session
   * logged in the panel below updates the progress and status above it. That
   * refresh must never travel over a value someone has just set, so each
   * control that can be both typed into and written by the log records that it
   * was touched.
   */
  const touched = new Set();

  const progressInput = input('progress.page', {
    type: 'number',
    min: '0',
    step: 'any',
    value: draft.progress.page || '',
    placeholder: '79',
    onInput: () => touched.add('progress'),
  });

  const progressUnit = el('select.select.progress-unit', {
    'aria-label': 'Progress measured in',
    onChange: () => {
      const total = lengthInUnits();
      const current = Number.parseFloat(progressInput.value);

      // Convert what's already typed rather than leaving a page number sitting
      // in a field now labelled "percent".
      if (Number.isFinite(current) && total > 0) {
        progressInput.value =
          progressUnit.value === 'percent'
            ? Math.round((current / total) * 100)
            : Math.round((current / 100) * total);
      }
      progressInput.placeholder = progressUnit.value === 'percent' ? '18' : '79';
      progressInput.max = progressUnit.value === 'percent' ? '100' : '';
      refreshProgressNote();
    },
  }, [
    el('option', { value: 'page' }, formatUnit(draft) === 'minutes' ? 'minutes in' : 'page'),
    el('option', { value: 'percent' }, '% complete'),
  ]);

  const progressNote = el('span.field__hint');

  function refreshProgressNote() {
    const total = lengthInUnits();
    const value = Number.parseFloat(progressInput.value);

    if (!Number.isFinite(value) || !total) {
      progressNote.textContent = total
        ? ''
        : 'Add a length above and this will show a percentage too.';
      return;
    }
    const page = progressUnit.value === 'percent' ? Math.round((value / 100) * total) : value;
    const percent = Math.round((page / total) * 100);
    progressNote.textContent = `${percent}% \u00b7 page ${Math.round(page)} of ${total}`;
  }

  /** Whatever is in the progress field, as units of the book. */
  function progressAsUnits(total) {
    const typed = Number.parseFloat(progressInput.value);
    if (!Number.isFinite(typed)) return draft.progress.page || 0;
    return progressUnit.value === 'percent' && total
      ? Math.round((typed / 100) * total)
      : Math.round(typed);
  }

  progressInput.addEventListener('input', refreshProgressNote);
  pagesInput.addEventListener('input', refreshProgressNote);
  audioInput.addEventListener('input', refreshProgressNote);
  refreshProgressNote();

  const ratingControl = starRating(draft.rating, (value) => {
    draft.rating = value;
  });

  const quotesBlock = quotesEditor(draft);

/**
   * Formats, plural.
   *
   * Reading the paperback with the audiobook playing is one book being read
   * once — same story, same progress, same finish date — so it is one record
   * that admits to being two objects, rather than two records to keep in step
   * by hand. (A comic and its audio drama are genuinely different works and
   * still want separate records.)
   *
   * Checkboxes rather than a select, and no "primary" to choose: when a book
   * is both read and listened to, the unit is pages, because a page count is
   * a property of the book and a running time is a property of one recording.
   */
  const formatChecks = FORMAT_PRIORITY.map((id) =>
    el('label.format-check', {}, [
      el('input', {
        type: 'checkbox',
        name: 'formats',
        value: id,
        checked: hasFormat(draft, id),
        onChange: () => {
          // Turning the last one off leaves a book with no unit and every
          // pacing figure silently falling back to pages. Refuse quietly.
          if (!readFormats().length) {
            const box = formatChecks
              .flatMap((label) => [...label.querySelectorAll('input')])
              .find((input) => input.value === id);
            if (box) box.checked = true;
            formatNote.textContent = 'A book has to be in at least one format.';
            return;
          }
          refreshFormatNote();
          refreshFormatNote();
  refreshPaceNote();
          refreshProgressNote();
        },
      }),
      el('span', {}, FORMATS[id].label),
    ])
  );

  const formatNote = el('span.field__hint');

  const readFormats = () =>
    formatChecks
      .flatMap((label) => [...label.querySelectorAll('input')])
      .filter((input) => input.checked)
      .map((input) => input.value);

  function refreshFormatNote() {
    refreshLengthFields();
    const chosen = readFormats();
    const unit = formatUnit({ formats: chosen });
    formatNote.textContent =
      chosen.length > 1
        ? `Both at once \u2014 one record, one set of progress, measured in ${unit}.`
        : `Measured in ${unit}.`;
  }

  const formatField = el('div.format-checks', {}, formatChecks);

  /**
   * Show the measurements this book actually has.
   *
   * One box labelled "pages, or minutes for audio" made you work out which
   * unit it meant every time you opened a record, and gave a paperback you
   * also own on audio nowhere to put the second length.
   */
  function refreshLengthFields() {
    const chosen = readFormats();
    const audio = chosen.includes('audio');
    const printed = chosen.includes('physical') || chosen.includes('ebook');

    pagesLine.hidden = audio && !printed;
    audioLine.hidden = !audio;
    speedLine.hidden = !audio;
    // The "Pages"/"Audio" prefixes only earn their space when both are up and
    // the field label above can no longer say which is which.
    lengthControl.classList.toggle('length-fields--both', audio && printed);

    const label = fields.pageCount?.wrap.querySelector('.field__label');
    if (label) label.htmlFor = pagesLine.hidden ? 'f-audioSeconds' : 'f-pageCount';

    refreshAudioNote();
  }

  /** What the recording costs you at the speed you play it. */
  function refreshAudioNote() {
    const typed = audioInput.value.trim();
    const runtime = parseHms(typed);

    if (audioLine.hidden || !typed) {
      audioNote.textContent = '';
      return;
    }
    if (!runtime) {
      audioNote.textContent = 'Use hours:minutes:seconds, like 9:45:30.';
      return;
    }

    const speed = Number(speedInput.value) || 1;
    const minutes = Math.ceil(runtime / 60);

    audioNote.textContent = speed > 0 && speed !== 1
      ? `${formatHms(runtime)} at ${speed}\u00d7 is ${formatHms(listeningTime({ audioSeconds: runtime, speed }))} of your time.`
      : `${formatHms(runtime)} \u2014 ${minutes} minutes.`;
  }

  audioInput.addEventListener('input', refreshAudioNote);
  speedInput.addEventListener('input', refreshAudioNote);

  const categorySelect = el(
    'select.select',
    { id: 'f-category', name: 'category' },
    allKinds().map((kind) =>
      el('option', { value: kind.id, selected: draft.category === kind.id }, kind.label)
    )
  );

  // Where this copy came from. Blank is a real answer — most records imported
  // from anywhere will have it — so the list leads with "Not stated" rather
  // than defaulting everything to Purchased and inventing a fact.
  const sourceSelect = el(
    'select.select',
    { id: 'f-source', name: 'source' },
    [
      el('option', { value: '', selected: !draft.source }, 'Not stated'),
      ...allSources().map((source) =>
        el('option', { value: source.id, selected: draft.source === source.id }, source.label)),
      // A source this device has not heard of yet must not be silently
      // rewritten by opening the record and saving it.
      draft.source && !allSources().some((source) => source.id === draft.source)
        ? el('option', { value: draft.source, selected: true }, sourceLabel(draft.source))
        : null,
    ].filter(Boolean)
  );

  const statusSelect = el(
    'select.select',
    {
      id: 'f-status',
      name: 'status',
      onChange: () => {
        touched.add('status');
        // Revealed by the status rather than always present: for every book
        // that was not set down, the field is a prompt for something that
        // never happened.
        if (dnfField) dnfField.hidden = statusSelect.value !== 'dnf';
      },
    },
    STATUS_ORDER.map((id) =>
      el('option', { value: id, selected: draft.status === id }, STATUSES[id].label)
    )
  );

  const startInput = input('schedule.start', { type: 'date', value: draft.schedule.start ?? '' });
  const endInput = input('schedule.end', { type: 'date', value: draft.schedule.end ?? '' });

  // The record, as distinct from the plan. Finishing a book fills these in on
  // its own; they're editable for the times it didn't happen that way.
  // Both events, deliberately: a date field emptied with the picker's own
  // clear control reports `change` without always reporting `input`, and an
  // untouched field is one Save is free to overwrite from the stored record.
  const startedInput = input('actual.startedAt', {
    type: 'date',
    value: draft.actual.startedAt ?? '',
    onInput: () => touched.add('startedAt'),
    onChange: () => touched.add('startedAt'),
  });
  const finishedInput = input('actual.finishedAt', {
    type: 'date',
    value: draft.actual.finishedAt ?? '',
    onInput: () => touched.add('finishedAt'),
    onChange: () => touched.add('finishedAt'),
  });

  const paceNote = el('p.field__hint', { id: 'pace-note' });

  /**
   * The length in the unit the book is paced in.
   *
   * Pages when there are pages; whole minutes of recording when there are not.
   * The stored record derives the same number, but the notes below have to
   * work from what is typed, before any of it is saved.
   */
  function lengthInUnits() {
    if (!pagesLine.hidden) return Number.parseInt(pagesInput.value, 10) || 0;
    const runtime = parseHms(audioInput.value);
    return runtime ? Math.ceil(runtime / 60) : 0;
  }

  /** Live feedback: what this plan actually asks of you per day. */
  function refreshPaceNote() {
    const start = startInput.value;
    const end = endInput.value;
    const pages = lengthInUnits();
    const unit = formatUnit({ formats: readFormats() });

    if (!start || !end || !pages || end < start) {
      paceNote.textContent = 'Set a length and both dates to see the daily pace.';
      return;
    }
    const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;

    // What is *left*, not what the book is.
    //
    // Rescheduling a book you are eighty per cent through, to finish it
    // tomorrow, used to read "1 day — about 310 minutes a day": the whole
    // audiobook again, as though the seven sittings behind it had not
    // happened. The plan is for the part you have not read.
    const done = Math.min(progressAsUnits(pages), pages);
    const left = Math.max(0, pages - done);
    const perDay = Math.ceil((left || pages) / days);

    paceNote.textContent = done > 0 && left > 0
      ? `${days} day${days === 1 ? '' : 's'} \u2014 about ${perDay} ${unit} a day for the ${left} still to go.`
      : left === 0 && done > 0
        ? `${days} day${days === 1 ? '' : 's'} \u2014 nothing left to read.`
        : `${days} day${days === 1 ? '' : 's'} \u2014 about ${perDay} ${unit} a day.`;
  }

  [startInput, endInput, pagesInput, progressInput, audioInput].forEach((node) =>
    node.addEventListener('input', refreshPaceNote)
  );
  progressUnit.addEventListener('change', refreshPaceNote);

  // Picking a start date almost always means "and about a week". Filling the
  // finish date in saves the second date picker, and it stays editable, so the
  // guess costs nothing when it's wrong.
  startInput.addEventListener('change', () => {
    // A native date input can report a "change" mid-edit — typing over an
    // existing year fires one for every digit, each a complete-looking but
    // wrong date (a single "2" typed into a cleared year reads as "0002").
    // Guessing a finish date from that stuck once the guess landed, since the
    // guard below only fires while endInput is still empty.
    if (!startInput.value || !isValidKey(startInput.value) || endInput.value) return;
    endInput.value = addDays(startInput.value, 6);
    refreshPaceNote();
  });

  refreshFormatNote();
  refreshPaceNote();

  // Cover art. A lookup can autofill the fields the user hasn't filled in
  // themselves — never overwrite what they typed.
  const picker = coverPicker({
    draft,
    readForm: () => ({
      isbn: isbnInput.value,
      title: titleInput.value,
      author: authorInput.value,
    }),
    onPick: (cover, meta) => {
      draft.cover = cover;
      if (!meta) return;
      if (!titleInput.value.trim() && meta.title) titleInput.value = meta.title;
      if (!authorInput.value.trim() && meta.author) authorInput.value = meta.author;
      if (!isbnInput.value.trim() && meta.isbn) isbnInput.value = meta.isbn;
      if (!pagesInput.value && meta.pageCount) {
        pagesInput.value = meta.pageCount;
        refreshPaceNote();
      }
      if (!descriptionInput.value.trim() && meta.description) {
        descriptionInput.value = meta.description;
      }
      if (!genreInput.value.trim() && meta.genre) genreInput.value = meta.genre;
    },
  });

  /**
   * Fill the empty fields from a lookup. Reads the form rather than the saved
   * record, so it respects anything typed but not yet saved, and writes back
   * into the inputs rather than the store — nothing is committed until Save.
   */
  /** The reading log, when one is shown, so Save can flush a typed entry. */
  let logPanel = null;

  const detailsNote = el('p.field__hint', { 'aria-live': 'polite' });

  const detailsButton = el('button.btn.btn--quiet.btn--sm', {
    type: 'button',
    onClick: async () => {
      const current = collect();
      const gaps = missingFields(current);
      if (!gaps.length) {
        detailsNote.textContent = 'Nothing is missing on this record.';
        return;
      }

      detailsButton.disabled = true;
      detailsNote.textContent = `Looking up ${gaps.join(', ')}\u2026`;
      const result = await fetchMissingDetails(current);
      detailsButton.disabled = false;

      if (!result.ok) {
        detailsNote.textContent = result.reason;
        return;
      }

      // Written into the fields, never over them.
      if (result.patch.pageCount && !pagesInput.value) {
        pagesInput.value = result.patch.pageCount;
        refreshPaceNote();
      }
      if (result.patch.description && !descriptionInput.value.trim()) {
        descriptionInput.value = result.patch.description;
      }
      if (result.patch.author && !authorInput.value.trim()) authorInput.value = result.patch.author;
      if (result.patch.genre && !genreInput.value.trim()) genreInput.value = result.patch.genre;
      if (result.patch.isbn && !isbnInput.value.trim()) isbnInput.value = result.patch.isbn;
      if (result.patch.cover?.url && !draft.cover.url) draft.cover = result.patch.cover;

      detailsNote.textContent = `Filled in ${result.filled.join(', ')}. Save to keep it.`;
    },
  }, 'Get details');

  const body = [
    isEdit ? finishedStrip(draft) : null,
    // Redundant once a book is finished: finishedStrip already says everything
    // this could, and does it from the dates rather than from a today-relative
    // average that has no "today" left to be relative to.
    isEdit && draft.status !== 'finished' ? progressStrip(draft) : null,
    isEdit ? replanNote(draft, { onChange: () => syncFromStore() }) : null,
    isEdit ? historyPanel(draft) : null,
    el('div.field', {}, [
      el('span.field__label', { text: 'Cover' }),
      picker,
    ]),
    el('div.details-row', {}, [detailsButton, detailsNote]),
    field('title', 'Title', titleInput),
    el('div.field-row', {}, [
      field('author', 'Author', authorInput),
      field('coAuthors', 'Also by', coAuthorsInput, 'Separated by commas. Optional.'),
      field('isbn', 'ISBN', isbnInput, 'Used to look up cover art'),
    ]),
    el('div.field-row', {}, [
      field('category', 'Kind', categorySelect, 'Book, comic, manga\u2026'),
      field('format', 'Format', el('div', {}, [formatField, formatNote]),
        'How you read it \u2014 tick both if you read and listen'),
      field('pageCount', 'Length', lengthControl, 'How long it is, in its own units'),
      field('genre', 'Genre', genreInput),
    ]),
    el('div.field-row', {}, [
      field('status', 'Status', statusSelect),
      field('source', 'Where from', sourceSelect, 'Bought, borrowed, a gift\u2026'),
    ]),
    dnfField,
    el('div.field', {}, [
      el('label.field__label', { for: 'f-description', text: 'Description' }),
      descriptionInput,
    ]),
    el('fieldset.plan-block', {}, [
      el('legend.field__label', { text: 'Series' }),
      el('div.field-row', {}, [
        field('series.name', 'Series name', seriesNameInput),
        field('series.number', 'Book number', seriesNumberInput),
        field('series.total', 'Of how many', seriesTotalInput),
      ]),
    ]),
    // How far in you are, on its own.
    //
    // It used to live inside "What actually happened", between the start and
    // finish dates, which made it look like part of that record — so saying
    // "I am eighty per cent through" seemed to require dates for a book that
    // is not finished and may never have had a start date written down. It is
    // its own fact, it sits above the plan that depends on it, and the plan's
    // daily pace is worked out from what is left.
    el('fieldset.plan-block', {}, [
      el('legend.field__label', { text: 'How far in you are' }),
      el('div.field', {}, [
        el('span.field__label', {}, 'Currently at'),
        el('div.progress-entry', {}, [progressInput, progressUnit]),
        progressNote,
      ]),
      el('p.field__hint', {}, 'Page, minute or percentage \u2014 whichever you know. Nothing else has to be filled in for this to count.'),
    ]),

    el('fieldset.plan-block', {}, [
      el('legend.field__label', { text: 'Reading plan' }),
      el('div.field-row', {}, [
        field('schedule.start', 'Start on', startInput),
        field('schedule.end', 'Finish by', endInput),
      ]),
      paceNote,
    ]),
    el('fieldset.plan-block', {}, [
      el('legend.field__label', { text: 'What actually happened' }),
      el('div.field-row', {}, [
        field('actual.startedAt', 'Started on', startedInput),
        field('actual.finishedAt', 'Finished on', finishedInput),
      ]),
      el('p.field__hint', {}, 'Marking a book finished fills the finish date in for you.'),
      historyLine(draft),
      isEdit
        ? el('div.details-row', {}, [
            el('button.btn.btn--danger.btn--sm', {
              type: 'button',
              onClick: () => {
                startedInput.value = '';
                finishedInput.value = '';
                progressInput.value = '';

                // Setting `.value` in code fires no input event, so without
                // this the fields count as untouched — and Save re-reads the
                // stored record over them before collecting, putting the dates
                // straight back. That is the bug where clearing appeared to
                // work, saved silently, and came back on reopening.
                touched.add('startedAt');
                touched.add('finishedAt');
                touched.add('progress');

                // Saying a book has not been read is saying it is not being
                // read, so the status has to move with the dates — otherwise
                // the status rules stamp them straight back on save. Shown
                // here rather than sprung afterwards, so the form says what
                // saving will do.
                const stepped = startInput.value ? 'planned' : 'backlog';
                if (statusSelect.value === 'reading' || statusSelect.value === 'finished') {
                  statusSelect.value = stepped;
                  touched.add('status');
                }

                refreshProgressNote();
                refreshPaceNote();
                toast(`Cleared, and set back to ${STATUSES[stepped].label.toLowerCase()}. Save to keep it.`);
              },
            }, 'Clear what actually happened'),
            draft.sessions.length
              ? el('button.btn.btn--danger.btn--sm', {
                  type: 'button',
                  onClick: async () => {
                    const sure = await confirmAction({
                      title: `Delete the reading log for ${draft.title}?`,
                      body: `All ${draft.sessions.length} logged sittings go. The book itself stays.`,
                      confirmLabel: 'Delete the log',
                    });
                    if (!sure) return;
                    updateBook(draft.id, { sessions: [] });
                    draft.sessions = [];
                    toast('Reading log cleared.');
                    modal.close();
                    openBookForm({ book: getBook(draft.id), onSaved });
                  },
                }, `Delete the reading log (${draft.sessions.length})`)
              : null,
          ].filter(Boolean))
        : null,
    ]),
    el('fieldset.plan-block', {}, [
      el('legend.field__label', { text: 'Shelves and notes' }),
      field('shelves', 'Shelves', shelvesInput, 'Comma separated'),
      shelfList,
      el('div.field', {}, [
        el('label.field__label', { for: 'f-notes', text: 'Notes' }),
        notesInput,
      ]),
      quotesBlock.node,
    ]),
    el('fieldset.plan-block', {}, [
      el('legend.field__label', { text: 'Rating and review' }),
      ratingControl,
      el('div.field', {}, [
        el('label.field__label', { for: 'f-review', text: 'Review' }),
        reviewInput,
      ]),
    ]),
    isEdit
      ? el('fieldset.plan-block.plan-block--log', {}, [
          el('legend.field__label', { text: 'Reading log' }),
          (logPanel = sessionLog({
            bookId: draft.id,
            onChange: () => syncFromStore(),
          })),
        ])
      : null,
  ].filter(Boolean);

  function showErrors(errors) {
    for (const [name, entry] of Object.entries(fields)) {
      const message = errors[name];
      const slot = $(`#err-${name}`, entry.wrap);
      if (slot) {
        slot.textContent = message ?? '';
        slot.hidden = !message;
      }
      entry.control.setAttribute('aria-invalid', message ? 'true' : 'false');
    }
    const firstBad = Object.keys(errors)[0];
    fields[firstBad]?.control.focus();
  }

  /**
   * The fields this form owns.
   *
   * Deliberately does *not* spread the draft. The draft is a snapshot taken
   * when the form opened, so spreading it wrote a stale `sessions` array back
   * over anything logged in the meantime — you'd log a sitting, press Save,
   * and watch it vanish. It also dropped `schedule.rebase`, silently undoing a
   * catch-up. Anything the form doesn't edit is left for the store to merge.
   */
  function collect() {
    return {
      title: titleInput.value,
      author: authorInput.value,
      isbn: isbnInput.value,
      pageCount: pagesInput.value,
      audioSeconds: audioLine.hidden ? null : parseHms(audioInput.value),
      speed: audioLine.hidden ? 1 : Number(speedInput.value) || 1,
      genre: genreInput.value,
      formats: readFormats(),
      category: categorySelect.value,
      source: sourceSelect.value,
      status: statusSelect.value,
      dnfReason: dnfInput.value,
      coAuthors: coAuthorsInput.value.split(',').map((name) => name.trim()).filter(Boolean),
      cover: draft.cover,
      description: descriptionInput.value,
      series: {
        name: seriesNameInput.value,
        number: seriesNumberInput.value,
        total: seriesTotalInput.value,
      },
      shelves: shelvesInput.value.split(',').map((shelf) => shelf.trim()).filter(Boolean),
      notes: notesInput.value,
      review: reviewInput.value,
      rating: draft.rating,
      quotes: quotesBlock.read(),
      // Only the two dates: `rebase` belongs to the store and survives because
      // updateBook merges nested objects one level deep.
      schedule: { start: startInput.value || null, end: endInput.value || null },
      actual: {
        startedAt: startedInput.value || null,
        finishedAt: finishedInput.value || null,
      },
      // A blank field means "not stated here", not "back to zero" — the log is
      // the better authority, and normalizeBook already takes the furthest
      // logged page. Clearing progress deliberately is what the reset button
      // in the record is for.
      progress:
        progressInput.value === ''
          ? undefined
          : resolveProgress(
              { pageCount: lengthInUnits() || null },
              progressUnit.value === 'percent'
                ? { percent: progressInput.value }
                : { page: progressInput.value }
            ),
    };
  }

  /**
   * Re-read the stored record into the form.
   *
   * Logging a session writes progress, status and the start date straight to
   * the store, but the form's fields still held whatever they had when it
   * opened — so Save wrote the stale values back over the new ones. Closing
   * without saving *appeared* to work only because nothing overwrote anything.
   *
   * Anything the person has typed is left alone; only the fields the log owns
   * are refreshed.
   */
  function syncFromStore() {
    const stored = getBook(draft.id);
    if (!stored) return;

    draft.sessions = stored.sessions;
    draft.progress = stored.progress;
    draft.actual = { ...stored.actual };

    // Only fields the person has *not* edited are refreshed.
    //
    // This ran on save as well as after logging, and it wrote the stored
    // status straight into the select — so changing a book from Reading to On
    // hold and pressing Save re-selected Reading a moment before the form read
    // the select, and the change vanished with no error. Refreshing what the
    // log owns is right; overwriting what someone just typed is not, and the
    // difference is whether they have touched the control.
    if (!touched.has('status')) {
      draft.status = stored.status;
      statusSelect.value = stored.status;
    }

    if (!touched.has('progress') && stored.progress.page) {
      progressInput.value =
        progressUnit.value === 'percent'
          ? Math.round(stored.progress.percent)
          : stored.progress.page;
    }

    if (!touched.has('startedAt') && stored.actual.startedAt) {
      startedInput.value = stored.actual.startedAt;
    }
    if (!touched.has('finishedAt') && stored.actual.finishedAt) {
      finishedInput.value = stored.actual.finishedAt;
    }

    refreshProgressNote();
  }

  function save() {
    // A session typed into the log but never confirmed with "Log it" used to be
    // thrown away here. Filling the fields and pressing Save is the obvious
    // thing to do, so Save commits it.
    logPanel?.commitPending?.();

    // Then pick up anything the log wrote while the form was open, so Save
    // cannot write stale values back over it.
    if (isEdit) syncFromStore();

    // Caught here rather than in validateBook, which only ever sees the parsed
    // number: by then "9.45.30" has already become null, and saving it would
    // quietly drop a length the person believes they just typed.
    if (!audioLine.hidden && audioInput.value.trim() && !parseHms(audioInput.value)) {
      showErrors({ pageCount: 'Use hours:minutes:seconds, like 9:45:30.' });
      toast('Check the highlighted fields.', { variant: 'error' });
      return;
    }

    const payload = collect();

    // On add there is nothing to merge against, so the defaults come from a
    // blank record rather than from a draft that may be half-stale.
    const result = isEdit
      ? updateBook(draft.id, payload)
      : addBook({ ...blankBook(), ...payload, id: draft.id, cover: draft.cover });

    if (!result.ok) {
      showErrors(result.errors);
      toast('Check the highlighted fields.', { variant: 'error' });
      return;
    }
    // Keep the draft aligned with what was actually stored, so a form left
    // open after saving doesn't hold a stale copy.
    Object.assign(draft, structuredClone(result.book));
    modal.close();
    toast(isEdit ? 'Changes saved.' : `${result.book.title} added to the library.`);
    onSaved?.(result.book);
  }

  function confirmRemove() {
    const removed = removeBook(draft.id);
    if (!removed.ok) return;
    modal.close();
    toast(`${removed.book.title} removed.`);
    // Undo lives in the toast rail for as long as the toast does.
    const rail = document.querySelector('.toast-rail .toast:last-child');
    rail?.append(
      el('button.btn.btn--sm.btn--danger', {
        style: { pointerEvents: 'auto', marginLeft: '8px' },
        onClick: () => {
          restoreBook(removed.book);
          toast('Put back on the shelf.');
        },
        text: 'Undo',
      })
    );
  }

  const modal = showModal({
    eyebrow: isEdit ? 'Catalogue record' : 'New acquisition',
    title: isEdit ? draft.title || 'Untitled' : 'Add a book',
    body,
    secondaryAction:
      isEdit &&
      el('button.btn.btn--danger', { type: 'button', onClick: confirmRemove }, 'Remove'),
    actions: [
      el('button.btn.btn--quiet', { type: 'button', onClick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn--stamp', { type: 'button', onClick: save }, isEdit ? 'Save changes' : 'Add book'),
    ],
  });

  // Enter submits from any single-line input, as people expect from a form.
  modal.panel.addEventListener('keydown', (event) => {
    // The session log handles its own Enter key; don't save the whole book
    // because someone finished typing a page number.
    if (event.target.closest('.session-log')) return;
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
      event.preventDefault();
      save();
    }
  });

  // Again now the fields exist: the first call runs while the form is still
  // being assembled, so the Length label has nothing to point at yet.
  refreshLengthFields();

  return modal;
}

/**
 * The derived picture, at the top of the record: how far in, how fast, and
 * where that lands. Everything here is computed from the log rather than
 * entered, so there is nothing to edit and no field to keep in sync.
 */
/**
 * What finishing it actually took.
 *
 * A finished record used to say "finished" and stop. The same shelf row covers
 * a book read in four sittings over a fortnight and one ground through over
 * eight months, and the difference between those is most of what anyone would
 * want to remember about reading them.
 */
function finishedStrip(book) {
  if (book.status !== 'finished') return null;

  const summary = finishedSummary(book);
  if (!summary.ok) return null;

  const unit = formatUnit(book) === 'minutes' ? 'minutes' : 'pages';

  return el('div.finished-strip', {}, [
    el('p.finished-strip__head', {}, [
      el('b', {}, `${formatShort(summary.from)} \u2013 ${formatShort(summary.to)}`),
      ` \u00b7 ${summary.days} day${summary.days === 1 ? '' : 's'} start to finish`,
    ]),

    el('dl.finished-strip__facts', {}, [
      fact('Days actually read', summary.readingDays
        ? `${summary.readingDays} of ${summary.days}`
        : 'none logged'),
      fact('Sittings', summary.sessions ? String(summary.sessions) : 'none logged'),
      summary.minutes ? fact('Time at the page', formatDuration(summary.minutes)) : null,
      summary.pagesPerHour
        ? fact('Reading speed', `${summary.pagesPerHour} ${unit} an hour`)
        : null,
      summary.listenedAt
        ? fact('Listened at', `${summary.listenedAt}\u00d7 the clock`)
        : null,
      summary.pagesPerReadingDay
        ? fact('On a day you read', `${summary.pagesPerReadingDay} ${unit}`)
        : null,
    ].filter(Boolean)),

    !summary.sessions
      ? el('p.field__hint', {}, 'Nothing was logged for this one, so the dates are all there is to go on.')
      : null,

    // A rate from two of five sittings is a true number about a partial log,
    // and reads as a claim about the whole book unless it says otherwise.
    summary.partiallyTimed
      ? el('p.field__hint', {},
          `Speed is measured over the ${summary.timedSessions} of ${summary.sessions} sittings that have minutes on them.`)
      : null,
  ].filter(Boolean));
}

const fact = (label, value) =>
  el('div.finished-strip__fact', {}, [el('dt', {}, label), el('dd', {}, value)]);

/**
 * A book that keeps being moved is telling you something.
 *
 * Three reschedules is not a failure and the app has no business acting on it
 * — quietly putting a book on hold because it counted to three would be the
 * app deciding how someone's reading is going. But it is worth saying out
 * loud, once, with the two ways out within reach, because the alternative is a
 * book that gets pushed forward a week at a time for six months.
 */
function replanNote(book, { onChange }) {
  const moves = book.schedule.history?.length ?? 0;
  if (moves < 3 || book.status === 'finished' || book.status === 'dnf' || book.status === 'on-hold') {
    return null;
  }

  const first = book.schedule.history[0];

  return el('div.replan-note', {}, [
    el('p', {}, [
      el('b', {}, `Moved ${moves} times`),
      ` \u00b7 first planned for ${formatShort(first.start)}.`,
    ]),
    el('p.replan-note__aside', {}, 'Plans slip, and that is what rescheduling is for. If this one is not working out, it can wait somewhere honest instead.'),
    el('div.replan-note__actions', {}, [
      el('button.btn.btn--quiet.btn--sm', {
        type: 'button',
        onClick: () => {
          setStatus(book.id, 'on-hold');
          toast(`${book.title} put on hold. It keeps its plan and its log.`);
          onChange?.();
        },
      }, 'Put it on hold'),
      el('button.btn.btn--quiet.btn--sm', {
        type: 'button',
        onClick: () => {
          setStatus(book.id, 'dnf');
          toast(`${book.title} marked as did not finish.`);
          onChange?.();
        },
      }, 'Did not finish'),
    ]),
  ]);
}

/**
 * This book's own history: the plan and the record on the same axes.
 *
 * The record already says "27 pages behind" and "finishes Friday", and both
 * are this comparison boiled down to a sentence. The chart is here because the
 * sentence cannot tell you *when* it went wrong — a book that lost a week to a
 * holiday and one that has been quietly slipping since day one produce the
 * same sentence and completely different shapes.
 *
 * Folded shut. It is detail, and the fields above it are what the record is
 * for; anyone who wants it opens it once and finds it open thereafter.
 */
function historyPanel(book) {
  const trail = progressTrail(book);
  if (!trail.ok || trail.points.length < 2) return null;
  if (!trail.points.some((point) => point.logged)) return null;

  return el('details.book-history', {}, [
    el('summary', {}, 'How this book has actually gone'),
    el('div.book-history__body', {}, [
      trailChart(trail.points, {
        label: `${book.title}: plan against record`,
        total: trail.total,
        unit: trail.unit,
      }),
      el('p.chart-key', {}, [
        el('span', {}, [el('i', {}), 'What you have read']),
        el('span', {}, [el('i', { class: 'is-plan' }), 'What the plan asked for']),
        trail.moves
          ? el('span', {}, [el('i', { class: 'is-replan' }), `Rescheduled (${trail.moves})`])
          : null,
      ].filter(Boolean)),
    ]),
  ]);
}

function progressStrip(book) {
  const report = progressReport(book);
  if (!report.ok || (!report.done && !report.sittings)) return null;

  const unitWord = report.unit === 'minutes' ? 'minutes' : 'pages';

  return el('div.progress-strip', {}, [
    el('div.progress-strip__head', {}, [
      el('span.progress-strip__percent', {}, `${report.percent}%`),
      el('span.progress-strip__where', {}, `${report.done} of ${report.total} ${unitWord}`),
      report.remaining
        ? el('span.progress-strip__left', {}, `${report.remaining} to go`)
        : null,
    ].filter(Boolean)),
    el(
      'div.progress',
      {
        role: 'progressbar',
        'aria-valuenow': String(report.percent),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-label': 'Progress through this book',
      },
      el('span.progress__fill', { style: { width: `${report.percent}%` } })
    ),
    el('dl.progress-strip__facts', {}, [
      report.rateLabel
        ? miniFact('Average so far', report.rateLabel, '', report.rateBasis)
        : null,
      book.sessions.length
        ? miniFact(
            'Days read',
            String(new Set(book.sessions.map((session) => session.date)).size),
            '',
            `${book.sessions.length} sitting${book.sessions.length === 1 ? '' : 's'}, not necessarily consecutive`
          )
        : null,
      report.needed
        ? miniFact(
            'Needed from here',
            report.needed.overdue
              ? `${report.needed.perDay} ${unitWord} — the date has passed`
              : `${report.needed.perDay} ${unitWord} a day`,
            report.needed.overdue ? 'is-late' : '',
            report.needed.overdue ? null : `over ${report.needed.days} days left`
          )
        : null,
      report.timeLeft ? miniFact('Time left', report.timeLeft) : null,
      report.projected ? miniFact('Finishing', formatShort(report.projected)) : null,
      report.verdict
        ? miniFact('Against plan', report.verdict.text, `is-${report.verdict.tone}`)
        : null,
    ].filter(Boolean)),
    report.projectionNote ? el('p.progress-strip__note', {}, report.projectionNote) : null,
    catchUpRow(book),
    startHereRow(book, report),
  ].filter(Boolean));
}

/**
 * Offered when progress runs ahead of the plan — which usually means the plan
 * never described reality, not that you are doing brilliantly.
 */
function startHereRow(book, report) {
  // Already rebased: the plan and reality agree.
  if (book.schedule.rebase || book.status === 'finished') return null;
  if (report.percent >= 100 || report.percent < 10) return null;

  const preview = startFromHere(book);
  if (!preview.ok) return null;

  const plan = paceFor(book);
  const ahead = plan.ok && plan.delta >= 25;

  // Being "ahead" is the loudest symptom, but not the only one: what matters
  // is that the plan counts from page one while you started somewhere else.
  return el('div.progress-strip__catchup', {}, [
    el('p', {},
      (ahead
        ? `You are ${plan.delta} ${preview.unit} ahead of this plan, which usually means the plan started before you did. `
        : `You are ${report.percent}% in. `) +
      `Replanning from today spreads the remaining ${preview.remaining} over ${preview.days} days \u2014 ${preview.perDay} a day.`),
    el('button.btn.btn--stamp.btn--sm', {
      type: 'button',
      onClick: () => {
        updateBook(book.id, preview.patch);
        toast(`Replanned from today: ${preview.perDay} ${preview.unit} a day.`);
      },
    }, 'Start plan from here'),
  ]);
}

/** Offered only when the plan has actually slipped. */
function catchUpRow(book) {
  const preview = catchUpPreview(book);
  if (!preview.ok || preview.behind > -5) return null;

  return el('div.progress-strip__catchup', {}, [
    el('p', {}, preview.needsExtension
      ? `The finish date has passed with ${preview.remaining} ${preview.unit} left.`
      : `Behind by ${Math.abs(preview.behind)} ${preview.unit}. Spreading what's left over the ${preview.days} days remaining is ${preview.perDay} a day.`),
    el('button.btn.btn--stamp.btn--sm', {
      type: 'button',
      onClick: () => {
        updateBook(book.id, catchUpPatch(book));
        toast(`Replanned: ${preview.perDay} ${preview.unit} a day through ${preview.to}.`);
      },
    }, 'Catch me up'),
  ]);
}

const miniFact = (label, value, tone = '', note = null) =>
  el('div.progress-strip__fact', {}, [
    el('dt', {}, label),
    el('dd', { class: tone }, value),
    note ? el('dd.progress-strip__basis', {}, note) : null,
  ].filter(Boolean));

/* --- Rating ---------------------------------------------------------------
 * Radio buttons rather than clickable glyphs: a star widget that isn't a real
 * form control is unreachable by keyboard and invisible to a screen reader.
 * -------------------------------------------------------------------------- */

function starRating(current, onChange) {
  const name = `rating-${Math.random().toString(36).slice(2, 7)}`;
  let value = current ?? null;

  const stars = [1, 2, 3, 4, 5].map((score) =>
    el('label.star', { class: value >= score ? 'is-on' : '' }, [
      el('input', {
        type: 'radio', name, value: String(score),
        checked: value === score,
        class: 'visually-hidden',
        'aria-label': `${score} star${score === 1 ? '' : 's'}`,
        onChange: () => {
          value = score;
          onChange(score);
          paint();
        },
      }),
      el('span', { 'aria-hidden': 'true' }, '\u2605'),
    ])
  );

  const clear = el('button.btn.btn--danger.btn--sm', {
    type: 'button',
    onClick: () => {
      value = null;
      onChange(null);
      for (const star of stars) star.querySelector('input').checked = false;
      paint();
    },
  }, 'Clear');

  function paint() {
    stars.forEach((star, index) => star.classList.toggle('is-on', value != null && value >= index + 1));
    clear.hidden = value == null;
  }

  paint();

  return el('div.field', {}, [
    el('span.field__label', {}, 'Rating'),
    el('div.star-rating', { role: 'radiogroup', 'aria-label': 'Rating' }, [...stars, clear]),
  ]);
}

/* --- Quotes ---------------------------------------------------------------- */

function quotesEditor(draft) {
  let quotes = [...(draft.quotes ?? [])];
  const list = el('ul.quote-list');

  const textInput = el('textarea.textarea', {
    rows: '2', placeholder: 'Type or paste a passage worth keeping.',
    'aria-label': 'Quote',
  });
  const pageInput = el('input.input.quote-page', {
    type: 'number', min: '0', placeholder: 'page', 'aria-label': 'Page number',
  });

  const paint = () => {
    fill(list, quotes.length
      ? quotes.map((quote) =>
          el('li.quote', {}, [
            el('blockquote', {}, quote.text),
            el('div.quote__foot', {}, [
              quote.page != null ? el('cite', {}, `page ${quote.page}`) : null,
              el('button.icon-btn', {
                type: 'button', 'aria-label': 'Delete this quote',
                onClick: () => {
                  quotes = quotes.filter((entry) => entry.id !== quote.id);
                  paint();
                },
                text: '\u00d7',
              }),
            ].filter(Boolean)),
          ])
        )
      : [el('li.quote-empty', {}, 'No quotes saved yet.')]);
  };

  const add = () => {
    const text = textInput.value.trim();
    if (!text) return;
    const page = Number.parseInt(pageInput.value, 10);
    quotes.push({
      id: `qt_${Date.now().toString(36)}`,
      text,
      page: Number.isFinite(page) ? page : null,
      createdAt: new Date().toISOString(),
    });
    textInput.value = '';
    pageInput.value = '';
    paint();
  };

  paint();

  return {
    node: el('div.field', {}, [
      el('span.field__label', {}, 'Quotes'),
      list,
      el('div.quote-form', {}, [
        textInput,
        el('div.quote-form__foot', {}, [
          pageInput,
          el('button.btn.btn--quiet.btn--sm', { type: 'button', onClick: add }, 'Add quote'),
        ]),
      ]),
    ]),
    read: () => quotes,
  };
}

/**
 * How the reading actually went, when it wasn't continuous.
 *
 * The two dates say "started here, ended there", which describes a span rather
 * than a habit. A book read on 3 July and again on the 18th deserves to say so.
 */
function historyLine(book) {
  const summary = historySummary(book);
  if (!summary) return null;
  return el('p.field__hint.history-line', {}, summary);
}
