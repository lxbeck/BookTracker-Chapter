/**
 * Does the README still describe the app that exists?
 *
 * A module map is the first thing to rot and the last thing anyone checks. The
 * one in this README listed files that had been renamed two snapshots earlier
 * and omitted a stylesheet, a theme module and half the cover pipeline —
 * silently, because prose has no compiler.
 *
 * So it is checked: every source file appears in the map, and every path in
 * the map is a file that exists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

/** Every shipped source file, ignoring tests and anything generated. */
function sourceFiles() {
  const found = [];
  const skip = new Set(['node_modules', 'data', '.git', 'tests']);

  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) walk(path, rel);
      // `package.json` and the like are not part of the map, and neither is
      // anything nested under a directory we skipped.
      else if (/\.(js|mjs|css|html)$/.test(entry.name)) found.push(rel);
    }
  };

  walk(ROOT);
  return found;
}

/** The fenced block under the module-map heading. */
function moduleMap() {
  const at = README.indexOf('Where things live');
  assert.notEqual(at, -1, 'the README has no module map');

  const open = README.indexOf('```', at);
  const close = README.indexOf('```', open + 3);
  return README.slice(open + 3, close);
}

const FILES = sourceFiles();
const MAP = moduleMap();

test('the project has source files to document', () => {
  assert.ok(FILES.length > 30, `only found ${FILES.length}`);
});

test('every source file is in the module map', () => {
  // A view module added and never written down is a module nobody knows to
  // look in.
  const missing = FILES.filter((file) => {
    const name = file.startsWith('js/views/') ? file.slice('js/views/'.length) : file;
    return !MAP.includes(name);
  });

  assert.deepEqual(missing, []);
});

test('the module map lists no file that has been deleted or renamed', () => {
  const listed = [...MAP.matchAll(/^\s*((?:js|css)\/[\w./-]+|[\w-]+\.(?:js|mjs|html))/gm)]
    .map((match) => match[1])
    .filter((path) => path.includes('.'));

  const gone = listed.filter((path) => {
    for (const candidate of [path, `js/views/${path}`]) {
      try {
        statSync(join(ROOT, candidate));
        return false;
      } catch {
        /* try the next shape */
      }
    }
    return true;
  });

  assert.deepEqual(gone, []);
});

test('the README opens by saying what this is', () => {
  assert.match(README, /^# Chapter\n/);
  assert.match(README.slice(0, 400), /reading tracker/i);
});

test('every collapsible section is closed again', () => {
  // An unclosed <details> swallows the rest of the page on GitHub.
  const open = (README.match(/<details>/g) ?? []).length;
  const close = (README.match(/<\/details>/g) ?? []).length;

  assert.equal(open, close);
  assert.ok(open > 20, 'the sections should be folded, not one wall of text');
});

test('every collapsible section has a summary', () => {
  const sections = README.split('<details>').slice(1);
  for (const section of sections) {
    const head = section.slice(0, section.indexOf('</summary>'));
    assert.match(head, /<summary>/, 'a details block with no summary cannot be opened by label');
  }
});
