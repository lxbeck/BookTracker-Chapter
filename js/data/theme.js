/**
 * What the place looks like.
 *
 * The palette has always lived in CSS custom properties on `:root`, which
 * means changing it needs no rebuild and no stylesheet swap: a handful of
 * `setProperty` calls at boot and the whole app changes colour. That is the
 * entire mechanism. The rest of this file is two decisions.
 *
 * **Which colours to expose.** Seven, not thirty. `tokens.css` defines around
 * twenty-five colours, but most are variations — `--slip-shade` is the card
 * stock one step down, `--stamp-wash` is the accent at a tenth strength — and
 * asking anyone to pick those by hand produces a settings panel nobody can
 * navigate and a hundred ways to make the app unreadable. So seven *base*
 * colours are offered, each one a thing you can point at, and every variation
 * is computed from its base. Change the accent and the accent's wash, deep
 * shade and bright-on-dark variant all move with it, staying in the same
 * relationship they were designed in.
 *
 * **How the derivations work.** Lightening and darkening happen against the
 * surface the colour sits on rather than against white and black, so a wash
 * stays a wash on a dark scheme instead of turning into a pale bar of light.
 * Text on the chrome flips between the light and dark ink automatically, since
 * a scheme with a cream-coloured chrome and cream text on it is not a scheme.
 */

/* --- Colour arithmetic ------------------------------------------------------ */

export const isColour = (value) =>
  typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());

function toRgb(hex) {
  const value = String(hex).trim().replace('#', '');
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value;
  return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
}

const toHex = (rgb) =>
  `#${rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;

/** Blend two colours. `t` of 0 is all `a`, 1 is all `b`. */
export function mix(a, b, t) {
  const [ar, ag, ab] = toRgb(a);
  const [br, bg, bb] = toRgb(b);
  return toHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

/** Rough perceived lightness — enough to tell a dark scheme from a light one. */
export function isDark(hex) {
  if (!isColour(hex)) return false;
  const [r, g, b] = toRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 < 140;
}

/**
 * Two directions, named for what they are for rather than for which way they
 * move, because which way they move depends on the colour.
 *
 * `contrast` goes toward the opposite of the colour: darker on a pale card,
 * lighter on a dark one. That is what a shade, an edge or a border wants —
 * something you can see against the surface it sits on.
 *
 * `recede` goes the other way, deeper into the colour's own end of the range.
 * That is what a recessed well or a gutter wants.
 *
 * Getting these the wrong way round is not a subtle bug: it is why every
 * button on every scheme had an outline mixed 16% *toward the background*,
 * which is to say no outline at all.
 */
const contrast = (hex, amount) => mix(hex, isDark(hex) ? '#ffffff' : '#000000', amount);
const recede = (hex, amount) => mix(hex, isDark(hex) ? '#000000' : '#ffffff', amount);

/* --- What can be changed ---------------------------------------------------- */

/**
 * The seven colours offered, in the order they appear in Settings.
 *
 * `id` is the CSS property that actually carries the value; everything else
 * derived from it is listed in `derive` below.
 */
export const THEME_COLOURS = [
  {
    id: '--bookcloth',
    label: 'App chrome',
    hint: 'The frame: sidebar, header, calendar grid.',
  },
  {
    id: '--slip',
    label: 'Card stock',
    hint: 'Book cards, panels, day tiles — most of the reading surface.',
  },
  { id: '--ink', label: 'Text', hint: 'Titles and body text on cards.' },
  {
    id: '--stamp',
    label: 'Accent',
    hint: 'Buttons, links, today, anything time-sensitive.',
  },
  { id: '--inprogress', label: 'Reading now', hint: 'Books in progress.' },
  { id: '--shelved', label: 'Finished', hint: 'Books checked back in.' },
  { id: '--overdue', label: 'Behind schedule', hint: 'Overdue days and warnings.' },
];

const COLOUR_IDS = THEME_COLOURS.map((colour) => colour.id);

/**
 * Everything computed from the seven.
 *
 * Written as functions of the base colours so a preset only ever has to state
 * seven values and a custom colour never leaves its relatives behind.
 */
export function derive(base) {
  const chrome = base['--bookcloth'];
  const slip = base['--slip'];
  const ink = base['--ink'];
  const stamp = base['--stamp'];

  const onChrome = isDark(chrome) ? '#f1f4f7' : '#141a20';

  return {
    ...base,

    '--bookcloth-lift': contrast(chrome, 0.07),
    '--bookcloth-edge': recede(chrome, 0.35),
    '--bookcloth-hover': contrast(chrome, 0.1),

    // Toward the ink, not away from it: a card shade one step *lighter* than
    // the card is not a shade, and an edge mixed toward the background is not
    // an edge.
    '--slip-shade': contrast(slip, 0.07),
    '--slip-edge': contrast(slip, 0.18),

    // A hairline is right between two cards and wrong around a control. At 16%
    // toward the background a button's outline is invisible on a pale scheme
    // and nearly invisible on a dark one, so buttons and fields read as bare
    // text. Toward the *ink* instead, and far enough to actually see.
    '--control-edge': mix(slip, ink, 0.3),
    '--control-edge-strong': mix(slip, ink, 0.5),

    // Form fields, raised very slightly off the card they sit on. This was a
    // hardcoded near-white, which is correct on the original scheme and a
    // glaring white slab on every dark one.
    '--field': mix(slip, '#ffffff', isDark(slip) ? 0.06 : 0.45),

    // Heat squares, shaded from the card toward the accent so an empty day is
    // still a visible square rather than a hole in the page.
    '--heat-0': contrast(slip, 0.06),
    '--heat-1': mix(slip, stamp, 0.28),
    '--heat-2': mix(slip, stamp, 0.5),
    '--heat-3': mix(slip, stamp, 0.75),
    '--heat-4': stamp,
    '--heat-edge': mix(slip, ink, 0.22),

    // Softened toward the card they sit on, so secondary text recedes rather
    // than going grey — which is what mixing toward a fixed grey would do.
    '--ink-soft': mix(ink, slip, 0.32),
    '--ink-faint': mix(ink, slip, 0.52),
    '--ink-inverse': onChrome,
    '--ink-inverse-soft': mix(onChrome, chrome, 0.42),

    '--stamp-deep': mix(stamp, '#000000', 0.22),
    // The accent has to work on the chrome as well as on the cards, and on a
    // dark chrome the card version is unreadable.
    '--stamp-bright': isDark(chrome) ? mix(stamp, '#ffffff', 0.55) : stamp,
    '--stamp-wash': mix(stamp, slip, 0.88),

    '--overdue-wash': mix(base['--overdue'], slip, 0.88),

    // Two statuses that had no colour of their own. Backlog fell through to a
    // bare outline, which on a card corner over cover art is close to
    // invisible; on hold borrowed the neutral grey and read as disabled. Both
    // are derived rather than picked, so they follow the scheme like the rest.
    '--backlog': mix(ink, slip, 0.35),
    '--backlog-wash': mix(ink, slip, 0.86),
    '--onhold': mix(stamp, base['--overdue'], 0.55),
    '--onhold-wash': mix(mix(stamp, base['--overdue'], 0.55), slip, 0.86),
    '--shelved-wash': mix(base['--shelved'], slip, 0.86),
    '--inprogress-wash': mix(base['--inprogress'], slip, 0.86),

    // Calendar stripes read against the chrome, not against a card.
    '--state-reading': isDark(chrome)
      ? mix(base['--inprogress'], '#ffffff', 0.35)
      : base['--inprogress'],
    '--state-planned': isDark(chrome) ? mix(stamp, '#ffffff', 0.45) : stamp,
    '--state-finished': isDark(chrome)
      ? mix(base['--shelved'], '#ffffff', 0.3)
      : base['--shelved'],

    '--rule': `1px solid ${contrast(slip, 0.18)}`,
    '--rule-dark': `1px solid ${isDark(chrome) ? 'rgba(241, 244, 247, 0.14)' : 'rgba(20, 26, 32, 0.14)'}`,
  };
}

/* --- The presets ------------------------------------------------------------ */

/**
 * Each states all seven, so switching never leaves half the old scheme behind.
 * Each was checked for the one thing that matters — that text stays readable
 * on the surface it sits on. A palette that looks good as a row of swatches
 * and turns author names into grey mist is not a palette, it is a bug with a
 * pleasant name.
 */
export const THEMES = [
  {
    id: 'slip',
    label: 'Due-date slip',
    hint: 'The original. Blue-slate chrome, manila cards, ink-blue stamps.',
    colours: {
      '--bookcloth': '#1b2c3b', '--slip': '#f3f0e8', '--ink': '#171c22',
      '--stamp': '#3a57bd', '--inprogress': '#b07d1c', '--shelved': '#3c7a63',
      '--overdue': '#a8324a',
    },
  },
  {
    id: 'nightfall',
    label: 'Nightfall',
    hint: 'Dark cards as well as dark chrome. Easy at midnight.',
    colours: {
      '--bookcloth': '#12151a', '--slip': '#1e2229', '--ink': '#e8e6e1',
      '--stamp': '#7fa5df', '--inprogress': '#d9a95c',
      '--shelved': '#6fb495', '--overdue': '#d1705a',
    },
  },
  {
    id: 'readingRoom',
    label: 'Reading room',
    hint: 'Green baize, brass and dark wood.',
    colours: {
      '--bookcloth': '#22322a', '--slip': '#f2f1e6', '--ink': '#1f2620',
      '--stamp': '#2f5d43', '--inprogress': '#a5761d', '--shelved': '#417a55',
      '--overdue': '#9a4520',
    },
  },
  {
    id: 'sepia',
    label: 'Sepia',
    hint: 'Old paperback: brown ink on tea-stained paper.',
    colours: {
      '--bookcloth': '#3b2b1c', '--slip': '#f4ead6', '--ink': '#3b2b1c',
      '--stamp': '#96591f', '--inprogress': '#b4832a', '--shelved': '#6c7a45',
      '--overdue': '#a33a22',
    },
  },
  {
    id: 'ink',
    label: 'Ink and paper',
    hint: 'Near-monochrome. The covers do all the talking.',
    colours: {
      '--bookcloth': '#1a1a1a', '--slip': '#f8f8f6', '--ink': '#111111',
      '--stamp': '#2e2e2e', '--inprogress': '#7a6a3a', '--shelved': '#3f5f4c',
      '--overdue': '#7a2f2f',
    },
  },
  {
    id: 'plum',
    label: 'Plum',
    hint: 'Deep purple chrome with a warm rose accent.',
    colours: {
      '--bookcloth': '#2a1f33', '--slip': '#f5f0f4', '--ink': '#241d29',
      '--stamp': '#8a4a72', '--inprogress': '#b2762c', '--shelved': '#4a7a68',
      '--overdue': '#a83a52',
    },
  },
  {
    id: 'daylight',
    label: 'Daylight',
    hint: 'Pale chrome throughout, for a bright room.',
    colours: {
      '--bookcloth': '#dfe3e8', '--slip': '#ffffff', '--ink': '#1b2129',
      '--stamp': '#2f5d94', '--inprogress': '#9a7118', '--shelved': '#35705a',
      '--overdue': '#a3364a',
    },
  },
];

const DEFAULT_THEME = 'slip';


/* --- Settings --------------------------------------------------------------- */

/**
 * Clean a stored theme.
 *
 * Overrides are filtered to colours we offer and values that really are
 * colours: this ends up in `style.setProperty`, and a settings object arriving
 * over sync from another device is not something to hand to the DOM unread.
 */
/**
 * Themes the person has saved.
 *
 * The gap this fills: overrides live *on top of* a preset, so switching preset
 * discards them — which is correct, since an accent chosen against cream paper
 * is not an accent on black. But it meant an evening of picking colours was
 * one click from gone, with nothing anywhere to say it had existed.
 *
 * A saved theme is a full set of seven colours and a name, so it survives
 * switching away and back, syncs with every other setting, and can be deleted.
 */
function normalizeSavedThemes(list) {
  const out = [];
  const seen = new Set();

  for (const entry of Array.isArray(list) ? list : []) {
    const label = String(entry?.label ?? '').trim().slice(0, 40);
    if (!label) continue;

    const id = `saved:${String(entry?.id ?? label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
    if (seen.has(id)) continue;

    const colours = {};
    for (const colour of THEME_COLOURS) {
      const value = entry?.colours?.[colour.id];
      if (!isColour(value)) break;
      colours[colour.id] = value.trim().toLowerCase();
    }
    // A saved theme missing a colour would fall back to whichever scheme was
    // last applied, which is exactly the unpredictability this avoids.
    if (Object.keys(colours).length !== THEME_COLOURS.length) continue;

    seen.add(id);
    out.push({
      id,
      label,
      hint: String(entry?.hint ?? '').trim().slice(0, 120) || 'Your own.',
      colours,
      saved: true,
    });
  }

  return out;
}

/** Presets plus anything saved, which is what the picker should show. */
export const availableThemes = (settings = {}) => [
  ...THEMES,
  ...normalizeSavedThemes(settings.savedThemes),
];

export function normalizeTheme(input = {}, settings = {}) {
  const available = availableThemes(settings);
  const preset = available.some((theme) => theme.id === input?.preset)
    ? input.preset
    : DEFAULT_THEME;

  const overrides = {};
  for (const [token, value] of Object.entries(input?.overrides ?? {})) {
    if (COLOUR_IDS.includes(token) && isColour(value)) overrides[token] = value.trim().toLowerCase();
  }

  return { preset, overrides };
}

/** The full set of properties a setting resolves to. */
export function resolveTheme(setting, settings = {}) {
  const { preset, overrides } = normalizeTheme(setting, settings);
  const base = availableThemes(settings).find((theme) => theme.id === preset) ?? THEMES[0];
  return derive({ ...base.colours, ...overrides });
}

/**
 * Paint the app.
 *
 * Written onto the root element rather than into a stylesheet, so the defaults
 * in `tokens.css` stay authoritative for everything not themed, and clearing a
 * setting genuinely reverts instead of leaving the last colour behind.
 */
export function applyTheme(setting, settings = {}, root = document.documentElement) {
  const resolved = resolveTheme(setting, settings);

  for (const [token, value] of Object.entries(resolved)) {
    root.style.setProperty(token, value);
  }

  root.dataset.theme = normalizeTheme(setting, settings).preset;
  // Tells the browser which way its own furniture should go: scrollbars, form
  // controls and focus rings, none of which read a custom property.
  root.style.colorScheme = isDark(resolved['--slip']) ? 'dark' : 'light';

  return resolved;
}
