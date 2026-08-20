/**
 * Is every stylesheet actually on the page?
 *
 * A stylesheet that exists, is well-formed, and is never linked produces no
 * error anywhere: the app renders, the rules simply do nothing. `settings.css`
 * sat unlinked through several releases, and every symptom it caused — theme
 * cards with no gap between them, labels running into their own descriptions,
 * shelf names welded to their buttons — read as a dozen separate CSS mistakes
 * rather than as one missing line in `index.html`.
 *
 * Nothing else here can catch that, so this does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const read = (name) => readFileSync(fileURLToPath(new URL(name, ROOT)), 'utf8');

const STYLESHEETS = readdirSync(fileURLToPath(new URL('css', ROOT)))
  .filter((name) => name.endsWith('.css'))
  .sort();

test('there is at least one stylesheet to check', () => {
  assert.ok(STYLESHEETS.length > 5);
});

test('every stylesheet is linked from the page', () => {
  const html = read('index.html');
  const missing = STYLESHEETS.filter((name) => !html.includes(`css/${name}`));

  assert.deepEqual(missing, [], 'a stylesheet nobody links is a stylesheet that silently does nothing');
});

test('every stylesheet is precached by the service worker', () => {
  // Otherwise the app comes back offline with part of its styling missing,
  // which looks like corruption rather than like a cache gap.
  const sw = read('sw.js');
  const missing = STYLESHEETS.filter((name) => !sw.includes(`./css/${name}`));

  assert.deepEqual(missing, []);
});

test('the page links no stylesheet that does not exist', () => {
  const html = read('index.html');
  const linked = [...html.matchAll(/href="css\/([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(linked.filter((name) => !STYLESHEETS.includes(name)), []);
});

test('no stylesheet has unbalanced braces', () => {
  // An unclosed rule swallows everything after it, which is the other way a
  // block of CSS quietly stops applying.
  for (const name of STYLESHEETS) {
    const source = read(`css/${name}`).replace(/\/\*[\s\S]*?\*\//g, '');
    const open = (source.match(/{/g) ?? []).length;
    const close = (source.match(/}/g) ?? []).length;
    assert.equal(open, close, `${name} has ${open} { and ${close} }`);
  }
});

/* --- Colours that have to work on every scheme ----------------------------- */

import { THEMES, resolveTheme, isDark, mix } from '../js/data/theme.js';

/** Rough contrast ratio, enough to catch a colour that has vanished. */
function contrastRatio(a, b) {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
    const [r, g, bl] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

test('every scheme gives buttons and fields a visible outline', () => {
  // The bug this exists for: --control-edge was mixed *toward* the background,
  // so on every theme, including the original, a quiet button had no outline
  // at all and read as bare text.
  for (const theme of THEMES) {
    const colours = resolveTheme({ preset: theme.id });
    const ratio = contrastRatio(colours['--slip'], colours['--control-edge']);
    assert.ok(ratio > 1.35, `${theme.label}: control edge is invisible (ratio ${ratio.toFixed(2)})`);
  }
});

test('card shades move toward the ink, not away from it', () => {
  // A "shade" one step lighter than the card it shades is not a shade.
  for (const theme of THEMES) {
    const colours = resolveTheme({ preset: theme.id });
    const slipIsDark = isDark(colours['--slip']);

    assert.equal(
      isDark(colours['--slip-shade']) || !slipIsDark,
      true,
      `${theme.label}: slip shade went the wrong way`
    );
    assert.ok(
      contrastRatio(colours['--slip'], colours['--slip-edge']) > 1.15,
      `${theme.label}: card edge is invisible`
    );
  }
});

test('form fields are never a white slab on a dark scheme', () => {
  // The field background was a hardcoded near-white, which is correct on the
  // original scheme and glaring on every dark one.
  for (const theme of THEMES) {
    const colours = resolveTheme({ preset: theme.id });
    if (!isDark(colours['--slip'])) continue;
    assert.ok(isDark(colours['--field']), `${theme.label}: field is light on a dark card`);
  }
});

test('an empty heat square is still visible against the panel', () => {
  for (const theme of THEMES) {
    const colours = resolveTheme({ preset: theme.id });
    assert.ok(
      contrastRatio(colours['--slip'], colours['--heat-edge']) > 1.15,
      `${theme.label}: heat squares have no visible outline`
    );
  }
});

test('body text stays readable on its card in every scheme', () => {
  for (const theme of THEMES) {
    const colours = resolveTheme({ preset: theme.id });
    for (const token of ['--ink', '--ink-soft', '--ink-faint']) {
      const ratio = contrastRatio(colours['--slip'], colours[token]);
      assert.ok(ratio > 2.4, `${theme.label}: ${token} on the card is ${ratio.toFixed(2)}`);
    }
  }
});
